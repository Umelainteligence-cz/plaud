#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { Command } from "commander";
import { clearConfig, readConfig, redactToken } from "./config.js";
import { exportRecordings } from "./export.js";
import { downloadRecording } from "./download.js";
import { resolveAuthToken } from "./plaud-api.js";
import { fail, makeError, ok, printJson } from "./output.js";
import { captureTokenFromBrowser, importTokenFromHar, saveToken, validateToken } from "./auth.js";

function getCliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function requireToken({ json }: { json?: boolean }): Promise<string> {
  const token = await resolveAuthToken();
  if (token) return token;
  const err = makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." });
  if (json) printJson(fail(err));
  else {
    // eslint-disable-next-line no-console
    console.error("No auth token. Use `plaud auth login`, `plaud auth set --stdin`, or export `PLAUD_AUTH_TOKEN`.");
  }
  process.exitCode = 2;
  return "";
}

function pickUserLabel(me: any): string {
  if (!me || typeof me !== "object") return "";
  const candidates = [
    me?.user?.email,
    me?.user?.nickname,
    me?.user?.id,
    me.email,
    me.username,
    me.name,
    me.id,
  ].filter(Boolean);
  return candidates.length ? String(candidates[0]) : "";
}

function splitCsv(value: unknown): string[] {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function defaultOutDir(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(process.cwd(), `plaud-transcripts-${date}`);
}

function defaultZipPath(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(process.cwd(), `plaud-transcripts-${date}.zip`);
}

function defaultDownloadDir(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(process.cwd(), `plaud-download-${date}`);
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.round(elapsedMs / 100) / 10;
  return `${seconds.toFixed(1)}s`;
}

function createStatusRenderer() {
  const startedAt = Date.now();
  const spinnerFrames = ["|", "/", "-", "\\"] as const;
  let frame = 0;
  let lastLineLen = 0;
  let lastMsg = "";
  let currentMsg = "";
  let interval: NodeJS.Timeout | null = null;

  const render = () => {
    const elapsedMs = Date.now() - startedAt;
    const spin = spinnerFrames[frame % spinnerFrames.length];
    frame++;
    const msg = currentMsg || lastMsg || "Working";
    const line = `[plaud] ${spin} ${msg} (${formatElapsed(elapsedMs)})`;
    if (line === lastMsg) return;
    lastMsg = line;
    const pad = lastLineLen > line.length ? " ".repeat(lastLineLen - line.length) : "";
    lastLineLen = line.length;
    process.stderr.write(`\r${line}${pad}`);
  };

  return {
    update({ msg, elapsedMs }: { msg: string; elapsedMs?: number }) {
      currentMsg = msg || currentMsg;
      if (!interval) {
        if (typeof elapsedMs === "number") {
          const line = `[plaud] ${msg} (${formatElapsed(elapsedMs)})`;
          if (line !== lastMsg) {
            lastMsg = line;
            const pad = lastLineLen > line.length ? " ".repeat(lastLineLen - line.length) : "";
            lastLineLen = line.length;
            process.stderr.write(`\r${line}${pad}`);
          }
          return;
        }
        render();
      }
    },
    start(msg: string) {
      currentMsg = msg || currentMsg;
      if (interval) return;
      render();
      interval = setInterval(render, 120);
    },
    done(finalMsg?: string) {
      if (interval) clearInterval(interval);
      interval = null;
      if (finalMsg) process.stderr.write(`\r[plaud] ${finalMsg}\n`);
      else process.stderr.write("\n");
    },
  };
}

const program = new Command();
program.name("plaud").description("Export Plaud recordings and transcripts").version(getCliVersion());

program
  .command("auth")
  .description("Manage Plaud auth token")
  .addCommand(
    new Command("show")
      .description("Show token source (redacted)")
      .option("--json", "Print JSON")
      .action(async (opts: { json?: boolean }) => {
        const cfg = await readConfig();
        const env = process.env.PLAUD_AUTH_TOKEN;
        const token = env || cfg?.authToken || "";
        if (!token) {
          if (opts.json) {
            printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No token set" }), { hasToken: false }));
          } else {
            // eslint-disable-next-line no-console
            console.log("No token set. Use `plaud auth login`, `plaud auth set`, or export `PLAUD_AUTH_TOKEN`.");
          }
          process.exitCode = 2;
          return;
        }
        const source = env ? "env:PLAUD_AUTH_TOKEN" : "config";
        const tokenRedacted = redactToken(token);
        if (opts.json) {
          printJson(ok({ hasToken: true, source, tokenRedacted }));
        } else {
          // eslint-disable-next-line no-console
          console.log(`${source}: ${tokenRedacted}`);
        }
      }),
  )
  .addCommand(
    new Command("status")
      .description("Check whether the current token is set and valid")
      .option("--json", "Print JSON")
      .action(async (opts: { json?: boolean }) => {
        const env = process.env.PLAUD_AUTH_TOKEN;
        const cfg = await readConfig();
        const token = await resolveAuthToken();
        const source = env ? "env:PLAUD_AUTH_TOKEN" : cfg?.authToken ? "config" : null;

        if (!token) {
          if (opts.json) {
            printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No token set" }), { hasToken: false, source }));
          } else {
            // eslint-disable-next-line no-console
            console.log("No token set. Run `plaud auth login`.");
          }
          process.exitCode = 2;
          return;
        }

        const validation = await validateToken(token);
        const tokenRedacted = redactToken(token);
        const meLabel = validation.ok ? pickUserLabel(validation.me) : "";

        if (opts.json) {
          printJson(ok({ hasToken: true, source, tokenRedacted, validation }));
        } else if (validation.ok) {
          // eslint-disable-next-line no-console
          console.log(`Logged in${meLabel ? ` as ${meLabel}` : ""} (${source || "unknown source"})`);
        } else {
          // eslint-disable-next-line no-console
          console.log(`Token present but invalid: ${validation.reason}`);
        }

        if (!validation.ok) process.exitCode = 1;
      }),
  )
  .addCommand(
    new Command("login")
      .description("Open a browser, login to Plaud, and capture the auth token")
      .option("--timeout-ms <n>", "Timeout waiting for login (ms)", (v) => Number(v), 180000)
      .option("--url <url>", "Login URL to open", "https://app.plaud.ai")
      .option("--channel <channel>", "Browser channel (chrome or msedge)", "chrome")
      .option("--headless", "Run headless (not recommended for login)", false)
      .option("--force", "Capture even if an existing token is valid", false)
      .option("--json", "Print JSON")
      .action(async (opts: { timeoutMs: number; url: string; channel: string; headless?: boolean; force?: boolean; json?: boolean }) => {
        try {
          const existing = await resolveAuthToken();
          if (existing && !opts.force) {
            const existingValidation = await validateToken(existing);
            if (existingValidation.ok) {
              const msg = "Already logged in (existing token is valid). Use --force to recapture.";
              if (opts.json) {
                printJson(ok({ alreadyLoggedIn: true, message: msg, tokenRedacted: redactToken(existing) }));
              } else {
                // eslint-disable-next-line no-console
                console.log(msg);
              }
              return;
	          }
	        }

	        const status = opts.json ? null : createStatusRenderer();
	        status?.start("Waiting for login");
	        const token = await captureTokenFromBrowser({
	          url: opts.url,
	          timeoutMs: Math.max(10_000, Number(opts.timeoutMs || 180000)),
	          channel: opts.channel,
	          headless: !!opts.headless,
	          onStatus: (s) => status?.update(s),
	        });

	        status?.update({ msg: "Saving token" });
	        const saved = await saveToken(token);
	        status?.update({ msg: "Validating token" });
	        const validation = await validateToken(saved);
	        status?.done(validation.ok ? "Login complete" : "Token saved (validation failed)");

	        if (!validation.ok) process.exitCode = 1;

	        if (opts.json) {
	          printJson(ok({ tokenRedacted: redactToken(saved), validation }));
	          return;
	        }

	        // Keep stdout quiet; print user guidance to stderr.
	        // eslint-disable-next-line no-console
	        console.error(`Saved Plaud token (${redactToken(saved)}) to ~/.config/plaud/config.json (mode 0600).`);
	        // eslint-disable-next-line no-console
	        console.error("Next: `plaud auth status` or `plaud doctor`.");
        } catch (err: any) {
          process.exitCode = 1;
          if (opts.json) {
            printJson(fail(makeError(err)));
            return;
          }
          throw err;
        }
      }),
  )
  .addCommand(
    new Command("set")
      .description("Store token in ~/.config/plaud/config.json")
      .option("--stdin", "Read token from stdin")
      .option("--json", "Print JSON")
      .action(async (opts: { stdin?: boolean; json?: boolean }) => {
	        if (!opts.stdin) {
	          const msg = "Provide the token via stdin: `plaud auth set --stdin` (then paste token and Ctrl-D).";
	          if (opts.json) {
	            printJson(fail(makeError(null, { code: "VALIDATION", message: msg })));
	          } else {
	            // eslint-disable-next-line no-console
	            console.error(msg);
	          }
	          process.exitCode = 2;
	          return;
	        }

	        if (process.stdin.isTTY && !opts.json) {
	          // eslint-disable-next-line no-console
	          console.error("Paste Plaud token, then press Ctrl-D to submit.");
	        }
	        const token = (await readStdin()).trim();

        if (!token || !token.replace(/^bearer\s+/i, "").startsWith("eyJ")) {
          const msg = "Invalid token. Provide the JWT starting with `eyJ`.";
          if (opts.json) {
            printJson(fail(makeError(null, { code: "VALIDATION", message: msg })));
          } else {
            // eslint-disable-next-line no-console
            console.error(msg);
          }
          process.exitCode = 2;
          return;
        }

	        const saved = await saveToken(token);
	        if (opts.json) {
	          printJson(ok({ saved: true, tokenRedacted: redactToken(saved) }));
	        } else {
	          // eslint-disable-next-line no-console
	          console.error(`Saved token: ${redactToken(saved)}`);
	        }
	      }),
	  )
  .addCommand(
    new Command("import-har")
      .description("Extract a bearer token from a Plaud HAR file and store it")
      .argument("<path>", "Path to HAR file (may include Authorization headers)")
      .option("--json", "Print JSON")
      .action(async (harPath: string, opts: { json?: boolean }) => {
        try {
          const token = await importTokenFromHar(harPath);
          await saveToken(token);
	          if (opts.json) {
	            printJson(ok({ imported: true, tokenRedacted: redactToken(token) }));
	          } else {
	            // eslint-disable-next-line no-console
	            console.error(`Imported token: ${redactToken(token)}`);
	          }
	        } catch (err: any) {
          const msg = err?.message || String(err);
          const likelyUserIssue =
            msg.includes("No bearer token") || msg.includes("Invalid HAR") || msg.includes("missing log.entries");
          process.exitCode = likelyUserIssue ? 2 : 1;
          if (opts.json) {
            printJson(fail(makeError(err)));
            return;
          }
          throw err;
        }
      }),
  )
  .addCommand(
    new Command("clear")
      .description("Remove stored token")
      .option("--json", "Print JSON")
      .action(async (opts: { json?: boolean }) => {
        await clearConfig();
        if (opts.json) {
          printJson(ok({ cleared: true }));
        } else {
          // eslint-disable-next-line no-console
          console.log("Cleared stored token.");
        }
      }),
  );

const recordingsCmd = program
  .command("recordings")
  .alias("files")
  .description("Manage Plaud recordings (files)");

recordingsCmd
  .command("list")
  .description("List recordings (count-only by default)")
  .option("--include-trash", "Include trashed recordings", false)
  .option("--max <n>", "Max recordings to fetch", (v) => Number(v), 99999)
  .option("--json", "Print JSON")
  .action(async (opts: { includeTrash?: boolean; max: number; json?: boolean }) => {
    const { listRecordings } = await import("./plaud-api.js");
    const token = await resolveAuthToken();
    if (!token) {
      if (opts.json) {
        printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." })));
      } else {
        // eslint-disable-next-line no-console
        console.error("No auth token. Use `plaud auth login`, `plaud auth set`, or export `PLAUD_AUTH_TOKEN`.");
      }
      process.exitCode = 2;
      return;
    }

    try {
      const max = Number.isFinite(opts.max) ? opts.max : 99999;
      const recordings = await listRecordings({
        token,
        includeTrash: !!opts.includeTrash,
        max,
      });

      if (opts.json) {
        printJson(ok({ count: recordings.length, recordings }, { includeTrash: !!opts.includeTrash, max }));
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`${recordings.length} recordings`);
    } catch (err: any) {
      process.exitCode = 1;
      if (opts.json) {
        printJson(fail(makeError(err)));
        return;
      }
      throw err;
    }
  });

recordingsCmd
  .command("trash")
  .description("Move recording(s) to trash")
  .argument("<id...>", "Recording id(s)")
  .action(async (ids: string[]) => {
    const token = await requireToken({ json: true });
    if (!token) return;
    const { trashFiles } = await import("./plaud-api.js");
    try {
      const res = await trashFiles({ token, ids: ids.map(String) });
      printJson(ok({ ids, action: "trash", response: res }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

recordingsCmd
  .command("restore")
  .description("Restore recording(s) from trash")
  .argument("<id...>", "Recording id(s)")
  .action(async (ids: string[]) => {
    const token = await requireToken({ json: true });
    if (!token) return;
    const { untrashFiles } = await import("./plaud-api.js");
    try {
      const res = await untrashFiles({ token, ids: ids.map(String) });
      printJson(ok({ ids, action: "restore", response: res }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

const recordingTagsCmd = recordingsCmd.command("tags").description("Manage tags on recordings");

recordingTagsCmd
  .command("list")
  .description("List available tags")
  .option("--json", "Print JSON")
  .action(async (opts: { json?: boolean }) => {
    const token = await requireToken({ json: !!opts.json });
    if (!token) return;
    const { listTags } = await import("./plaud-api.js");
    try {
      const tags = await listTags({ token });
      if (opts.json) {
        printJson(ok({ count: tags.length, tags }));
        return;
      }
      // eslint-disable-next-line no-console
      for (const t of tags) console.log(`${t.id}\t${t.name}`);
    } catch (err: any) {
      process.exitCode = 1;
      if (opts.json) printJson(fail(makeError(err)));
      else throw err;
    }
  });

recordingTagsCmd
  .command("add")
  .description("Add a tag to one or more recordings")
  .argument("<tagId>", "Tag id")
  .argument("<id...>", "Recording id(s)")
  .action(async (tagId: string, ids: string[]) => {
    const token = await requireToken({ json: true });
    if (!token) return;
    const { updateTags } = await import("./plaud-api.js");
    try {
      const res = await updateTags({ token, fileIds: ids.map(String), filetagId: String(tagId) });
      printJson(ok({ ids, action: "tags.add", tagId, response: res }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

recordingTagsCmd
  .command("clear")
  .description("Clear all tags from one or more recordings")
  .argument("<id...>", "Recording id(s)")
  .action(async (ids: string[]) => {
    const token = await requireToken({ json: true });
    if (!token) return;
    const { updateTags } = await import("./plaud-api.js");
    try {
      const res = await updateTags({ token, fileIds: ids.map(String), filetagId: "" });
      printJson(ok({ ids, action: "tags.clear", response: res }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

function inferTransSummPayload(details: any, overrides: { summType?: string; summTypeType?: string }): Record<string, unknown> {
  const tz = typeof details?.timezone === "number" ? details.timezone : 0;
  const tranConfig = details?.extra_data?.tranConfig || {};
  const usedTemplate =
    details?.extra_data?.used_template ||
    details?.extra_data?.aiContentHeader?.used_template ||
    details?.extra_data?.aiContentHeader?.usedTemplate ||
    {};

  const language =
    tranConfig?.language ||
    details?.extra_data?.aiContentHeader?.language_code ||
    details?.extra_data?.aiContentHeader?.languageCode ||
    "en";

  const diarization = typeof tranConfig?.diarization === "number" ? tranConfig.diarization : 1;
  const llm = tranConfig?.llm || "";
  const info: Record<string, unknown> = { language, timezone: tz, diarization };
  if (llm) info.llm = llm;

  const summType =
    overrides.summType ||
    usedTemplate?.template_id ||
    usedTemplate?.templateId ||
    tranConfig?.type ||
    "";
  const summTypeType =
    overrides.summTypeType ||
    usedTemplate?.template_type ||
    usedTemplate?.templateType ||
    tranConfig?.type_type ||
    "custom";

  return {
    is_reload: 1,
    summ_type: String(summType),
    summ_type_type: String(summTypeType),
    info: JSON.stringify(info),
    support_mul_summ: true,
    mark_title: "",
  };
}

recordingsCmd
  .command("rerun")
  .description("Re-run transcript/summary generation for a recording")
  .argument("<id>", "Recording id")
  .option("--summ-type <id>", "Template id (defaults to inferred from file details)")
  .option("--summ-type-type <type>", "Template type (defaults to inferred)", "custom")
  .option("--wait", "Poll until Plaud no longer reports running tasks for this file", false)
  .option("--timeout-ms <n>", "Wait timeout in ms", (v) => Number(v), 300000)
  .option("--poll-ms <n>", "Poll interval in ms", (v) => Number(v), 2000)
  .action(async (id: string, opts: any) => {
    const token = await requireToken({ json: true });
    if (!token) return;
    const { getRecordingDetailsBatch, triggerTransSumm, listRunningTasks } = await import("./plaud-api.js");
    try {
      const detailsList = await getRecordingDetailsBatch({ token, ids: [id] });
      const details = Array.isArray(detailsList) ? detailsList.find((d: any) => String(d?.id || "") === String(id)) : null;
      if (!details) {
        process.exitCode = 1;
        printJson(fail(makeError(null, { code: "NOT_FOUND", message: "Recording not found (or details unavailable)." })));
        return;
      }

      const payload = inferTransSummPayload(details, {
        summType: opts.summType ? String(opts.summType) : undefined,
        summTypeType: opts.summTypeType ? String(opts.summTypeType) : undefined,
      });

      if (!payload.summ_type) {
        process.exitCode = 2;
        printJson(
          fail(
            makeError(null, {
              code: "VALIDATION",
              message: "Could not infer template id. Re-run with `--summ-type <id>` (capture another HAR if needed).",
            }),
          ),
        );
        return;
      }

      const res = await triggerTransSumm({ token, fileId: id, payload });

      let waited = false;
      if (opts.wait) {
        waited = true;
        const startedAt = Date.now();
        const timeoutMs = Math.max(10_000, Number(opts.timeoutMs || 300000));
        const pollMs = Math.max(500, Number(opts.pollMs || 2000));
        while (Date.now() - startedAt < timeoutMs) {
          const tasks = await listRunningTasks({ token });
          const stillRunning = tasks.filter((t: any) => String(t?.file_id || "") === String(id));
          if (stillRunning.length === 0) break;
          await new Promise((r) => setTimeout(r, pollMs));
        }
      }

      printJson(ok({ id, action: "rerun", waited, payload, response: res }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

recordingsCmd
  .command("tasks")
  .description("List running transcription/summary tasks")
  .option("--file-id <id>", "Filter to a specific recording id")
  .option("--json", "Print JSON")
  .action(async (opts: { fileId?: string; json?: boolean }) => {
    const token = await requireToken({ json: !!opts.json });
    if (!token) return;
    const { listRunningTasks } = await import("./plaud-api.js");
    try {
      const tasks = await listRunningTasks({ token });
      const filtered = opts.fileId ? tasks.filter((t: any) => String(t?.file_id || "") === String(opts.fileId)) : tasks;
      if (opts.json) {
        printJson(ok({ count: filtered.length, tasks: filtered }, { filtered: !!opts.fileId }));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`${filtered.length} running tasks`);
    } catch (err: any) {
      process.exitCode = 1;
      if (opts.json) printJson(fail(makeError(err)));
      else throw err;
    }
  });

const speakersCmd = program.command("speakers").description("Manage speakers");

speakersCmd
  .command("list")
  .description("List speakers")
  .option("--json", "Print JSON")
  .action(async (opts: { json?: boolean }) => {
    const token = await requireToken({ json: !!opts.json });
    if (!token) return;
    const { listSpeakers } = await import("./plaud-api.js");
    try {
      const speakers = await listSpeakers({ token });
      const safe = speakers.map((s: any) => ({
        speaker_id: s.speaker_id,
        speaker_name: s.speaker_name,
        speaker_type: s.speaker_type,
        sample_counts: s.sample_counts,
        created_at: s.created_at,
        updated_at: s.updated_at,
      }));
      if (opts.json) {
        printJson(ok({ count: safe.length, speakers: safe }));
        return;
      }
      // eslint-disable-next-line no-console
      for (const s of safe) console.log(`${s.speaker_id}\t${s.speaker_name}`);
    } catch (err: any) {
      process.exitCode = 1;
      if (opts.json) printJson(fail(makeError(err)));
      else throw err;
    }
  });

speakersCmd
  .command("rename")
  .description("Rename a speaker")
  .argument("<speakerId>", "Speaker id")
  .requiredOption("--name <name>", "New speaker name")
  .action(async (speakerId: string, opts: { name: string }) => {
    const token = await requireToken({ json: true });
    if (!token) return;
    const { listSpeakers, syncSpeakers } = await import("./plaud-api.js");
    try {
      const speakers = await listSpeakers({ token });
      const speaker = speakers.find((s: any) => String(s?.speaker_id || "") === String(speakerId));
      if (!speaker) {
        process.exitCode = 1;
        printJson(fail(makeError(null, { code: "NOT_FOUND", message: "Speaker not found." })));
        return;
      }

      const updated = {
        ...speaker,
        speaker_name: String(opts.name),
        need_sync: true,
        updated_at: typeof speaker.updated_at === "number" ? speaker.updated_at : Date.now(),
      };

      const res = await syncSpeakers({ token, speakers: [updated] });
      const results = res?.data?.results;
      const safeResults = Array.isArray(results)
        ? results.map((r: any) => ({
            speaker_id: r.speaker_id,
            speaker_name: r.speaker_name,
            speaker_type: r.speaker_type,
            success: r.success,
            is_created: r.is_created,
            is_skipped: r.is_skipped,
            is_deleted: r.is_deleted,
            updated_at: r.updated_at,
          }))
        : [];

      printJson(ok({ speakerId, name: String(opts.name), response: safeResults }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

recordingsCmd
  .command("get")
  .description("Get recording details")
  .argument("<id>", "Recording id")
  .option("--json", "Print JSON")
  .action(async (id: string, opts: { json?: boolean }) => {
    const { getRecordingDetailsBatch } = await import("./plaud-api.js");
    const token = await resolveAuthToken();
    if (!token) {
      if (opts.json) {
        printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." })));
      } else {
        // eslint-disable-next-line no-console
        console.error("No auth token. Use `plaud auth login`, `plaud auth set`, or export `PLAUD_AUTH_TOKEN`.");
      }
      process.exitCode = 2;
      return;
    }

    try {
      const list = await getRecordingDetailsBatch({ token, ids: [id] });
      const details = Array.isArray(list) ? list.find((d: any) => String(d?.id || "") === String(id)) : null;
      if (!details) {
        process.exitCode = 1;
        if (opts.json) {
          printJson(fail(makeError(null, { code: "NOT_FOUND", message: "Recording not found" })));
          return;
        }
        // eslint-disable-next-line no-console
        console.error("Recording not found (or details unavailable).");
        return;
      }

      if (opts.json) {
        printJson(ok({ recording: details }));
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`${details.id}  ${details.filename || ""}`.trim());
    } catch (err: any) {
      process.exitCode = 1;
      if (opts.json) {
        printJson(fail(makeError(err)));
        return;
      }
      throw err;
    }
  });

recordingsCmd
  .command("download")
  .description("Download a single recording's transcript/summary/json/audio")
  .argument("<id>", "Recording id")
  .option("--out <dir>", "Output directory", defaultDownloadDir())
  .option("--what <list>", "Comma-separated: transcript,summary,json,audio", "transcript,summary,json")
  .option("--audio-format <fmt>", "opus or original", "opus")
  .action(async (id: string, opts: { out: string; what: string; audioFormat: string }) => {
    const token = await resolveAuthToken();
    if (!token) {
      printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." })));
      process.exitCode = 2;
      return;
    }

    try {
      const outDir = path.resolve(String(opts.out || defaultDownloadDir()));
      const result = await downloadRecording({
        token,
        id,
        outDir,
        what: opts.what,
        audioFormat: String(opts.audioFormat || "opus").toLowerCase(),
      });
      printJson(ok(result));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

recordingsCmd
  .command("export")
  .description("Export many recordings to a directory or zip (bulk)")
  .option("--include-trash", "Include trashed recordings", false)
  .option("--out <dir>", "Output directory (when not zipping)")
  .option("--zip [path]", "Write a single zip (defaults to ./plaud-transcripts-YYYY-MM-DD.zip)")
  .option("--formats <list>", "Comma-separated: txt,json,md", "txt,json,md")
  .option("--batch-size <n>", "IDs per details request (auto-fallback to 1 on failure)", (v) => Number(v), 10)
  .option("--delay-ms <n>", "Delay between batches (ms)", (v) => Number(v), 300)
  .option("--max <n>", "Max recordings to export", (v) => Number(v), Infinity)
  .option("--since <iso>", "Only export recordings on/after this date (ISO string or YYYY-MM-DD)")
  .option("--until <iso>", "Only export recordings on/before this date (ISO string or YYYY-MM-DD)")
  .option("--resume", "Skip writing files that already exist (dir mode)", false)
  .action(async (opts: any) => {
    const token = await resolveAuthToken();
    if (!token) {
      printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." })));
      process.exitCode = 2;
      return;
    }

    try {
      const formatsList = new Set(splitCsv(opts.formats).map((f) => f.toLowerCase()));
      const formats = {
        txt: formatsList.has("txt"),
        json: formatsList.has("json"),
        md: formatsList.has("md") || formatsList.has("markdown"),
      };

      const zipPath =
        typeof opts.zip === "string" ? path.resolve(opts.zip) : opts.zip ? defaultZipPath() : null;
      const outDir = path.resolve(opts.out || defaultOutDir());

      if (!zipPath) {
        await fs.mkdir(outDir, { recursive: true });
      }

      let lastRendered = 0;
      const summary = await exportRecordings({
        token,
        outDir,
        zipPath,
        includeTrash: !!opts.includeTrash,
        formats,
        batchSize: Math.max(1, Number(opts.batchSize || 10)),
        delayMs: Math.max(0, Number(opts.delayMs || 300)),
        max: Number.isFinite(opts.max) ? opts.max : Infinity,
        since: opts.since || null,
        until: opts.until || null,
        resume: !!opts.resume,
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastRendered < 200) return;
          lastRendered = now;
          // eslint-disable-next-line no-console
          process.stderr.write(`\rExporting ${p.current}/${p.total}...`);
        },
      });

      // eslint-disable-next-line no-console
      process.stderr.write("\n");
      printJson(ok(summary));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

program
  .command("whoami")
  .description("Fetch the current Plaud user profile")
  .option("--json", "Print JSON")
  .option("--raw", "Print raw /user/me response (may include signed URLs)", false)
  .action(async (opts: { json?: boolean; raw?: boolean }) => {
    const { getMe } = await import("./plaud-api.js");
    const token = await resolveAuthToken();
    if (!token) {
      const out = fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." }));
      // eslint-disable-next-line no-console
      console.log(opts.json ? JSON.stringify(out, null, 2) : out.error.message);
      process.exitCode = 2;
      return;
    }
    let me: any;
    if (opts.raw) {
      me = await getMe({ token });
    } else {
      const validation = await validateToken(token);
      if (!validation.ok) {
        const out = fail(makeError(null, { code: "AUTH_INVALID", message: validation.reason || "Token invalid" }));
        // eslint-disable-next-line no-console
        console.log(opts.json ? JSON.stringify(out, null, 2) : out.error.message);
        process.exitCode = 1;
        return;
      }
      me = validation.me;
    }
    if (opts.json) {
      printJson(ok({ me, raw: !!opts.raw }));
      return;
    }
    const label = pickUserLabel(me);
    // eslint-disable-next-line no-console
    console.log(label || "OK");
  });

program
  .command("doctor")
  .description("Run basic checks for auth and API access")
  .option("--json", "Print JSON")
  .action(async (opts: { json?: boolean }) => {
    const checks: Array<{ name: string; ok: boolean; detail?: string | null }> = [];
    const token = await resolveAuthToken();
    checks.push({ name: "token.present", ok: !!token });

    if (!token) {
      const out = fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." }), { checks });
      // eslint-disable-next-line no-console
      console.log(opts.json ? JSON.stringify(out, null, 2) : out.error.message);
      process.exitCode = 2;
      return;
    }

    const validation = await validateToken(token);
    checks.push({ name: "token.valid", ok: validation.ok, detail: validation.ok ? null : validation.reason });

    try {
      const { listRecordings } = await import("./plaud-api.js");
      await listRecordings({ token, includeTrash: false, max: 1, pageSize: 1 });
      checks.push({ name: "api.listRecordings", ok: true });
    } catch (error: any) {
      checks.push({ name: "api.listRecordings", ok: false, detail: error?.message || String(error) });
    }

    const allOk = checks.every((c) => c.ok);
    const out = allOk
      ? ok({ checks })
      : fail(makeError(null, { code: "CHECK_FAILED", message: "One or more checks failed" }), { checks });
    // eslint-disable-next-line no-console
    console.log(opts.json ? JSON.stringify(out, null, 2) : allOk ? "OK" : "Some checks failed");
    if (!allOk) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((err: any) => {
  // eslint-disable-next-line no-console
  console.error(err?.message || err);
  process.exitCode = 1;
});
