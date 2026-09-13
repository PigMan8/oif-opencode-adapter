# Changelog

## 0.1.0

- Initial OpenCode adapter.
- Hook translation: `chat.message` to `UserPromptSubmit`, `experimental.session.compacting`
  to `SessionStart`, `tool.execute.before` to `PreToolUse`, and session events to
  `SessionStart` / `Stop` / `PostCompact`.
- `shell.env` injection of `OIF_*` variables and session binding creation.
- Tools: `oif` (ledger core), `oif_run` (any OIF command), `oif_flow` (guided
  artifact / learning / check / work / skill-registry / skill-resolve workflows).
- Advisory by default; `OIF_ENFORCE=1` blocks on hold.
