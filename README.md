# oif-opencode-adapter

An **optional** OpenCode adapter for the [Objective Integrity Framework (OIF)](https://github.com/Chisiki1/objective-integrity-framework).

OIF keeps a small, explicit ledger per objective so an agent stays faithful to the
requested outcome across long tasks, corrections, compaction, and handoffs. This
adapter lets OpenCode drive that ledger: it captures prompts as immutable sources,
injects recovery context at compaction, screens mutating tool calls, and exposes
the OIF runtime through a few convenient tools.

> This is an independent host integration, **not** an official OIF component and
> not "the framework identity". The OIF runtime stays the source of truth; this
> adapter only bridges to it.

## What it is / is not

**Is:** a thin JavaScript bridge. It translates OpenCode plugin hooks into the
OIF runtime's host hook contract (`objective_ledger.py hook --event ...`) and runs
selected OIF commands for you. It shells out to Python; it does not re-implement
OIF semantics.

**Is not:** a fork of OIF, a replacement for the Python runtime, or a guarantee
that every OIF capability is automatic. Advanced OIF features (Skill Book,
whole-scope work, learning/governance, transition/scenario checks) are reachable
through the adapter's tools but are still driven by the agent, per OIF's design
("hooks capture facts only; they never derive objective semantics").

## Requirements

- **OpenCode** with plugin support.
- **OIF installed in your project**: `.oif/runtime/objective_ledger.py` and a
  config at `.oif-state/config.json`. Install it from the OIF release with
  `python tools/bootstrap.py --destination <project> --adapter generic --mode complete`.
- **Python 3.10+** on `PATH` (or set `OIF_PYTHON`).

## Install

### Option A — local plugin file (simplest)

Copy `plugins/oif.js` into one of:

- Global: `~/.config/opencode/plugins/oif.js`
- Project: `<project>/.opencode/plugins/oif.js`

OpenCode loads these automatically at startup.

### Option B — npm package

If this package is published, add it to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oif-opencode-adapter"]
}
```

## Configure

Create `<project>/.oif-state/config.json` (see `examples/config.json`):

```json
{
  "schema": "chat-objective-continuity-config-v1",
  "namespace": "opencode",
  "host_binding": { "session_env": "OIF_SESSION_ID", "bindings_dir": "bindings" },
  "session_bindings": {},
  "implicit_session_ledgers": true,
  "data_root": "ledger",
  "tool_classes": {
    "read": "read_only", "glob": "read_only", "grep": "read_only",
    "write": "mutating", "edit": "mutating", "bash": "mixed", "task": "mixed"
  }
}
```

`data_root` and `bindings_dir` are resolved relative to the config file, so
`"ledger"` means `<project>/.oif-state/ledger`. `tool_classes` maps OpenCode tool
names to OIF classes (`read_only`, `mutating`, `mixed`, `unknown`).

The adapter activates **only** for projects that contain both
`.oif/runtime/objective_ledger.py` and `.oif-state/config.json`; it stays inert
elsewhere.

## What it does

| OpenCode hook | OIF event | Effect |
|---|---|---|
| `chat.message` | `UserPromptSubmit` | capture the prompt as an immutable, unclassified source |
| `experimental.session.compacting` | `SessionStart` | inject `RECONCILE SOURCE FIRST` / objective card so the goal survives compaction |
| `tool.execute.before` | `PreToolUse` | screen mutating/mixed tools; advisory by default |
| `session.created` / `session.idle` / `session.compacted` | `SessionStart` / `Stop` / `PostCompact` | read-only continuity checks |
| `shell.env` | — | inject `OIF_*` variables and create the session binding file |

### Tools

- **`oif`** — friendly ledger operations: `context`, `owner-view`, `source-update`,
  `progress`, `action-start`, `action-outcome`, `verify`. Resolves the session,
  config path, and current head for you; mutations apply by default.
- **`oif_run`** — run any `tools/oif.py` command, with placeholders
  `{project} {oif} {runtime} {runtimeSha} {config} {sessionID} {head} {ledgerRoot} {ledgerInput}`,
  inline JSON materialization via `inputs`, and `payload` piped to stdin.
- **`oif_flow`** — guided workflows: `artifact`, `learning`, `check`, `work`,
  `skill-registry`, `skill-resolve` (with a lightweight v1 fact-array path and a
  full `facts-build → facts-compile → resolve` chain).

## Environment variables

| Variable | Purpose |
|---|---|
| `OIF_PYTHON` | Python executable (default: `python` on Windows, `python3` otherwise) |
| `OIF_ENFORCE` | `1`/`true` to hard-block a mutating tool on an OIF hold (default: advisory) |
| `OIF_HOOK_TIMEOUT_MS` | Per-command timeout (default 15000) |
| `OIF_PROJECT` | Override project root (default: discovered from the session directory) |
| `OIF_ALWAYS_INJECT` | `1`/`true` to keep the ledger pointer in the system prompt every turn |
| `OIF_INCLUDE_CARD` | `0`/`false` to skip injecting the objective card at compaction |

## Posture

Default is **advisory**: when the runtime returns a hold, the adapter logs a
warning and adds an `Objective Integrity advisory` line to the system prompt; it
does not stop your work. Set `OIF_ENFORCE=1` to block instead. Reads and recovery
stay available either way, matching OIF's "hold only the dependent mutation".

## Verify

```bash
node --check plugins/oif.js
npm test
```

The unit tests cover the pure helpers. The integration smoke test is skipped
unless you point it at a real project:

```bash
OIF_ADAPTER_PROJECT=/path/to/project npm test
```

## Evidence boundaries

Adapter unit tests prove helper behavior and file/JSON handling only. They do not
prove host event delivery, semantic correctness of classification, model
obedience, or external outcomes. OIF itself states that hooks capture facts and
never derive objective semantics; classification and authority stay with the
owner. Validate behavior at your own host/event-consumer boundary.

## Uninstall

Remove the plugin file (or the `plugin` entry from `opencode.json`). Project state
lives under `<project>/.oif-state/` and is not touched by the adapter. To remove an
OIF installation, use the OIF installer's rollback.

## Attribution and license

Licensed under the Apache License 2.0. See `LICENSE` and `NOTICE`. This adapter is
an independent integration and includes no OIF source code; it references the
runtime you install separately.
