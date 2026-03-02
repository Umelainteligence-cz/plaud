# plaud

![CI](https://github.com/danielgwilson/plaud/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/plaud)

Export all your Plaud recordings with speaker-labeled transcripts and optional AI summaries.

## Disclaimer

This is an **unofficial** project (not affiliated with Plaud). It uses a captured Plaud bearer token and private web endpoints, so it may break if Plaud changes their web app.

Security note: **do not** share tokens or `*.har` files (HARs often contain `Authorization` headers).

## Terminology

Plaud’s web UI uses “Files”. This CLI uses `recordings` (with `files` as an alias): `plaud recordings …` or `plaud files …`.

## Install (npm)

Global (recommended for frequent use):

```bash
npm i -g plaud
plaud auth login
```

No install (convenient for agents/one-offs):

```bash
npx -y plaud auth status --json
```

## Install (skill)

```bash
npx -y skills add danielgwilson/plaud --skill plaud -g -y
```

## Publishing (maintainers)

This repo is configured for npm **trusted publishing** from GitHub Actions.

- Workflow: `.github/workflows/publish.yml`
- npm Trusted Publisher workflow filename: `publish.yml`

## Install (local)

```bash
cd plaud/plaud-cli
npm install
npm link
```

Requirements:
- Node.js 22+ (tested on Node 24)

## Auth

Preferred (easy onboarding, stores token locally):

```bash
plaud auth login
```

Verify:

```bash
plaud auth status
plaud doctor
```

Fallbacks:

```bash
plaud auth set --stdin
plaud auth import-har /path/to/web.plaud.ai.har
```

Or via env var (no local storage):

```bash
export PLAUD_AUTH_TOKEN="eyJ..."
```

Tip (Node 22+): you can also use Node’s `--env-file` if you want to load a local `.env` without adding any dependency to the CLI:

```bash
node --env-file .env "$(command -v plaud)" auth status --json
```

## Export

Create a single ZIP (default):

```bash
plaud recordings export --zip
```

Export to a directory:

```bash
plaud recordings export --out ./plaud-transcripts --formats txt,json,md
```

## Download a single recording

```bash
plaud recordings list --json --limit 10
plaud recordings download <id> --out ./plaud-download --what transcript,summary,json
plaud recordings download <id> --out ./plaud-download --what audio --audio-format opus
```

Notes:
- `plaud recordings export` prints a JSON summary to stdout; progress goes to stderr.
- Tokens are stored at `~/.config/plaud/config.json` with `0600` permissions.

## Agent-first JSON contract

See `docs/CONTRACT_V1.md`.
