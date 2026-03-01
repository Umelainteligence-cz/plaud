# Plaud CLI v1 contract (agent-first)

This document defines **stable**, machine-readable behavior for agents and scripts.

## Output rules

- When you pass `--json`, the command prints **exactly one JSON object** to stdout.
- Progress/status logs go to **stderr**.
- For mutation-style commands, stdout is always JSON (even without `--json`):
  - `plaud recordings download`
  - `plaud recordings export`
  - `plaud recordings trash`
  - `plaud recordings restore`
  - `plaud recordings tags add`
  - `plaud recordings tags clear`
  - `plaud recordings rerun`
  - `plaud recordings speakers rename`

## JSON envelope

### Success

```json
{
  "ok": true,
  "data": {},
  "meta": {}
}
```

`meta` is optional.

### Failure

```json
{
  "ok": false,
  "error": {
    "code": "AUTH_MISSING",
    "message": "No auth token. Run `plaud auth login`.",
    "retryable": false,
    "http": { "status": 401 }
  },
  "meta": {}
}
```

`error.http` and `meta` are optional.

## Exit codes

- `0`: success
- `1`: failure (unexpected, transient, or upstream error)
- `2`: user action required (missing auth, invalid input, invalid HAR, etc.)

## Error codes

These are best-effort and may expand in the future:

- `AUTH_MISSING` (exit `2`)
- `AUTH_INVALID` (usually exit `1`)
- `NOT_FOUND` (exit `1`)
- `RATE_LIMITED` (exit `1`, `retryable: true`)
- `UPSTREAM_5XX` (exit `1`, `retryable: true`)
- `TIMEOUT` (exit `1`, `retryable: true`)
- `VALIDATION` (exit `2`)
- `CHECK_FAILED` (exit `1`)
- `UNKNOWN` (exit `1`)

## Commands (JSON schemas by example)

### `plaud auth show --json`

Success:
```json
{
  "ok": true,
  "data": { "hasToken": true, "source": "config", "tokenRedacted": "eyJhbG…abcd" }
}
```

Failure (`exit 2`):
```json
{
  "ok": false,
  "error": { "code": "AUTH_MISSING", "message": "No token set", "retryable": false },
  "meta": { "hasToken": false }
}
```

### `plaud auth status --json`

Success:
```json
{
  "ok": true,
  "data": {
    "hasToken": true,
    "source": "config",
    "tokenRedacted": "eyJhbG…abcd",
    "validation": { "ok": true, "me": { "status": 0, "user": { "email": "…" } } }
  }
}
```

### `plaud auth login --json`

Success:
```json
{
  "ok": true,
  "data": { "tokenRedacted": "eyJhbG…abcd", "validation": { "ok": true, "me": { "user": { "email": "…" } } } }
}
```

Notes:
- This flow opens a browser and captures a Plaud bearer token from an authenticated request to `api.plaud.ai`.

### `plaud auth set --json`

Success:
```json
{ "ok": true, "data": { "saved": true, "tokenRedacted": "eyJhbG…abcd" } }
```

### `plaud auth import-har /path/to.har --json`

Success:
```json
{ "ok": true, "data": { "imported": true, "tokenRedacted": "eyJhbG…abcd" } }
```

### `plaud auth clear --json`

Success:
```json
{ "ok": true, "data": { "cleared": true } }
```

### `plaud whoami --json`

Success:
```json
{ "ok": true, "data": { "me": { "user": { "email": "…" } }, "raw": false } }
```

Notes:
- `--raw` returns the full `/user/me` response and may include signed URLs.

### `plaud doctor --json`

Success:
```json
{ "ok": true, "data": { "checks": [{ "name": "token.present", "ok": true }] } }
```

Failure:
```json
{
  "ok": false,
  "error": { "code": "CHECK_FAILED", "message": "One or more checks failed", "retryable": false },
  "meta": { "checks": [{ "name": "api.listRecordings", "ok": false, "detail": "…" }] }
}
```

### `plaud recordings list --json`

Success:
```json
{
  "ok": true,
  "data": { "count": 2, "recordings": [{ "id": "…" }, { "id": "…" }] },
  "meta": { "includeTrash": false, "max": 2 }
}
```

### `plaud recordings get <id> --json`

Success:
```json
{ "ok": true, "data": { "recording": { "id": "…", "trans_result": [] } } }
```

Failure (not found):
```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "Recording not found", "retryable": false } }
```

### `plaud recordings download <id>`

Success:
```json
{
  "ok": true,
  "data": {
    "id": "…",
    "outDir": "/abs/path",
    "written": [{ "kind": "audio", "path": "/abs/path/file.opus", "bytes": 123 }]
  }
}
```

Notes:
- `--what` supports: `transcript,summary,json,audio`
- `--audio-format` supports: `opus` (preferred) or `original`

### `plaud recordings export`

Success:
```json
{
  "ok": true,
  "data": {
    "exportDate": "2026-02-28T00:00:00.000Z",
    "totalFiles": 10,
    "successful": 10,
    "failed": [],
    "includesTrash": false,
    "since": null,
    "until": null,
    "outDir": null,
    "zipPath": "/abs/path.zip"
  }
}
```

### `plaud recordings trash <id...>`

Success:
```json
{ "ok": true, "data": { "ids": ["…"], "action": "trash", "response": { "status": 0 } } }
```

### `plaud recordings restore <id...>`

Success:
```json
{ "ok": true, "data": { "ids": ["…"], "action": "restore", "response": { "status": 0 } } }
```

### `plaud recordings tags list --json`

Success:
```json
{ "ok": true, "data": { "count": 1, "tags": [{ "id": "…", "name": "…" }] } }
```

### `plaud recordings tags add <tagId> <id...>`

Success:
```json
{ "ok": true, "data": { "ids": ["…"], "action": "tags.add", "tagId": "…", "response": { "status": 0 } } }
```

### `plaud recordings tags clear <id...>`

Success:
```json
{ "ok": true, "data": { "ids": ["…"], "action": "tags.clear", "response": { "status": 0 } } }
```

### `plaud recordings rerun <id>`

Success:
```json
{ "ok": true, "data": { "id": "…", "action": "rerun", "waited": false, "response": { "status": 0 } } }
```

### `plaud recordings tasks --json`

Success:
```json
{ "ok": true, "data": { "count": 2, "tasks": [{ "file_id": "…", "task_type": "transcript" }] } }
```

### `plaud recordings speakers list <id> --json`

Success:
```json
{ "ok": true, "data": { "id": "…", "totalSegments": 162, "mappings": [{ "originalSpeaker": "Speaker 2", "speaker": "Person A", "count": 10 }] } }
```

### `plaud recordings speakers rename <id> --from "Speaker 2" --to "Person A"`

Success:
```json
{ "ok": true, "data": { "id": "…", "action": "recordings.speakers.rename", "dryRun": false, "changed": 10 } }
```
