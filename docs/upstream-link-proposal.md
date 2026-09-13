# Upstream link proposal

This adapter follows the Objective Integrity Framework's own model for host
integrations: optional packaging that is not the framework identity, wired
through the existing `host_binding` and the runtime's host hook contract.

The most likely-to-be-accepted upstream contribution is a short documentation
pointer, not the JavaScript plugin itself. The upstream CI is Python-only and
does not run Node/Bun, so the reference plugin is hosted here and linked.

## Suggested issue

**Title:** Proposal: OpenCode adapter (documentation-first, reference plugin hosted separately)

**Body:**

> Hi — I built an adapter that binds the OIF objective ledger to OpenCode's plugin
> API, using the existing runtime and `host_binding` (no core changes, no new
> semantics). Before opening a PR I'd like to confirm scope.
>
> - **Host mapping:** `chat.message` -> `UserPromptSubmit`;
>   `experimental.session.compacting` -> `SessionStart`;
>   `tool.execute.before` -> `PreToolUse`; session events ->
>   `SessionStart` / `Stop` / `PostCompact`; plus shell env injection and thin
>   tools wrapping the existing commands.
> - **Proposed in-tree scope:** `adapters/opencode/README.md` (following the
>   Hermes adapter format) and a section in `docs/platform-adapters.md`. The
>   reference plugin is JavaScript (OpenCode plugins must be JS/TS); I host it in
>   a separate repository and link it, so this project's Python CI needs no Node
>   toolchain.
> - **Boundaries:** verified structurally and in one live OpenCode environment;
>   host event delivery across versions, model obedience, and external outcomes
>   remain unverified. The plugin shells out to the Python runtime; it does not
>   derive objective semantics.
> - **Ask:** Would you accept (a) the adapter README + platform-adapters entry,
>   and (b) a link to the external reference plugin? If you'd prefer it in-tree,
>   is an optional, non-blocking CI job acceptable, or would you rather keep it
>   as a documented reference only?

## Suggested `docs/platform-adapters.md` addition

```md
## Optional OpenCode Adapter

Use the community OpenCode adapter at <URL> only when that runtime is
intentionally selected. It binds the ledger through OpenCode plugin hooks and
the existing `host_binding`. It is optional packaging, not the framework
identity; delivered context, trust, and tool coverage are host-specific and must
be checked at the event-consumer boundary.
```
