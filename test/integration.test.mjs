import { test } from "node:test"
import assert from "node:assert/strict"

// Optional smoke test. Set OIF_ADAPTER_PROJECT to a project that already has an
// OIF runtime installed (.oif/runtime/objective_ledger.py + .oif-state/config.json).
// Skipped by default so CI does not need a Python/OIF installation.
const project = process.env.OIF_ADAPTER_PROJECT

test("plugin exposes its tools for a configured project", { skip: !project }, async () => {
  const { OIFPlugin } = await import("../plugins/oif.js")
  const hooks = await OIFPlugin({
    client: { app: { log: async () => {} } },
    directory: project,
    worktree: project,
  })
  assert.ok(hooks.tool, "expected a tool map")
  assert.ok(hooks.tool.oif, "expected the oif tool")
  assert.ok(hooks.tool.oif_run, "expected the oif_run tool")
  assert.ok(hooks.tool.oif_flow, "expected the oif_flow tool")
  assert.equal(typeof hooks["chat.message"], "function")
  assert.equal(typeof hooks["tool.execute.before"], "function")
  assert.equal(typeof hooks["experimental.session.compacting"], "function")
  assert.equal(typeof hooks["shell.env"], "function")
})
