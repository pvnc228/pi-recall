# Pi Recall

Project-scoped memory extension for [Pi](https://github.com/earendil-works/pi):
extract facts from ordinary work and return the relevant ones to context.

**Status: early scaffold.** The store and manual commands work. Automatic
extraction and recall are not implemented yet.

## Scope of v0.1

1. While idle, extract facts and hypotheses from the conversation using Pi's
   configured model. Each record keeps its exact sources.
2. Before a request, select the relevant records and append them to context.
   A result that is not ready in time goes to the next turn.
3. Show the user which records were inserted. Records can be inspected, edited
   and deleted.

Out of scope: file backup and restore, cross-project memory, semantic detection
of reworded deleted claims. macOS is not a supported target.

## What works now

- SQLite source journal with a pending-work cursor.
- Manual fact and hypothesis records with sources, edits, deletion and an audit log.
- Opt-in capture of user and assistant text. Tool outputs, images and thinking
  blocks are not captured.
- `/recall decide`: a manual diagnostic call to a local decision model.

## Requirements

Node.js 22.19+ and Pi 1.4.0. Python 3.11+ only for the managed decision worker.

## Run

```sh
npm ci --ignore-scripts
npm run check
npm test
python -m unittest discover -s python/tests -v
pi -e ./dist/src/extension.js
```

| Command | Behavior |
|---|---|
| `/recall status` | Capabilities, record count, pending sources, config path |
| `/recall configure` | Edit validated local settings |
| `/recall add <text>` | Save a fact or hypothesis |
| `/recall list` | Inspect a record and its sources |
| `/recall edit` | Replace a record's text |
| `/recall delete` | Delete a record |
| `/recall audit` | Inspect saves, edits and deletions |
| `/recall decide <text>` | Diagnostic decision call; nothing is inserted |

## Configuration

Settings live in `~/.pi/agent/recall/<project-id>/config.json`, or under
`PI_RECALL_DATA_DIR`. Repository-local configuration is deliberately ignored: a
cloned project must not select an executable or receive an environment token.

```json
{
  "capture": false,
  "decisionTimeoutMs": 1000,
  "decision": { "mode": "managed", "python": "python", "modelDir": null }
}
```

An existing server can be used instead. Non-loopback endpoints require HTTPS,
and `tokenEnv` names the environment variable that holds the token:

```json
{
  "decision": {
    "mode": "external",
    "endpoint": "http://127.0.0.1:8080/v1",
    "model": "ggml-org/Julia-1-GGUF",
    "tokenEnv": null
  }
}
```

## Data and deletion

The database is `~/.pi/agent/recall/<project-id>/memory.sqlite`. The project ID
hashes the canonical working directory, so starting from a subdirectory currently
creates a separate store.

Capture has no secret redaction. Deleting a record hides it from active use and
blocks extraction from its source events. Those events stay in the journal, so
deletion is not physical erasure. A newer human message can create the claim again.

## Decision model

The decision step is experimental and may be dropped if a plain short list of
records performs as well. Nothing has been evaluated with a real model: tests use
a fake engine, and no accuracy, latency or memory figures have been measured.

`python/worker.py` is a loopback HTTP worker for a separately installed
[Julia-1](https://huggingface.co/SupersonicLabs/Julia-1) runtime. It never downloads
weights. Managed mode starts it on the first `/recall decide`, after `modelDir` is
set. To run it manually:

```sh
PI_RECALL_WORKER_TOKEN=<random-secret> python python/worker.py --model-dir /path/to/Julia-1 --port 8080
```

It serves `GET /health` and `POST /v1/systemone`, requires
`Authorization: Bearer <token>`, limits bodies to 64 KiB and answers `429` while a
forward pass is running. A client timeout does not cancel a running forward pass.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT license. Model runtimes have their own
licenses.
