# Changelog

## 0.2.3

- Resolve the project from the most specific safe session directory, so hosts
  that pass a broad worktree (for example a drive root) alongside the real
  session directory still provision the intended project.

## 0.2.2

- Do not auto-provision a drive root, the home directory, or known system
  directories; sessions opened there stay inactive instead of being modified.

## 0.2.1

- Fix plugin loading: the module now exports only the plugin function. Test
  helpers are attached as `OIFPlugin.__internal` instead of a second export,
  which OpenCode's plugin loader rejects ("Plugin export is not a function").

## 0.2.0

- Auto-provision any project: use a shared runtime at `~/.config/opencode/oif`
  and create `.oif` (directory link) plus `.oif-state/config.json` on first use.
- The session directory now takes precedence over `OIF_PROJECT` when resolving
  the project, so a new project gets its own state.
- Add `OIF_HOME` (shared runtime location) and `OIF_DISABLE` (opt out).

## 0.1.0

- Initial OpenCode adapter.
- Hook translation: `chat.message` to `UserPromptSubmit`, `experimental.session.compacting`
  to `SessionStart`, `tool.execute.before` to `PreToolUse`, and session events to
  `SessionStart` / `Stop` / `PostCompact`.
- `shell.env` injection of `OIF_*` variables and session binding creation.
- Tools: `oif` (ledger core), `oif_run` (any OIF command), `oif_flow` (guided
  artifact / learning / check / work / skill-registry / skill-resolve workflows).
- Advisory by default; `OIF_ENFORCE=1` blocks on hold.
