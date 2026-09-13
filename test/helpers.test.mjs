import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { OIFPlugin } from "../plugins/oif.js"

const {
  resolveProject,
  textOf,
  additionalContext,
  permissionDenied,
  systemMessage,
  limit,
  compactContext,
  expandPlaceholders,
  materializeInput,
  summarizeResolve,
  pick,
  artifactProjectKey,
  genEventId,
} = OIFPlugin.__internal

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "oif-adapter-"))
  mkdirSync(join(root, ".oif", "runtime"), { recursive: true })
  mkdirSync(join(root, ".oif-state"), { recursive: true })
  writeFileSync(join(root, ".oif", "runtime", "objective_ledger.py"), "# fixture\n")
  writeFileSync(join(root, ".oif-state", "config.json"), "{}\n")
  return root
}

test("resolveProject finds the nearest project containing .oif", () => {
  const root = makeProject()
  try {
    const nested = join(root, "a", "b")
    mkdirSync(nested, { recursive: true })
    assert.equal(resolveProject([nested]), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolveProject falls back to the session dir when no .oif exists", () => {
  const bare = mkdtempSync(join(tmpdir(), "oif-bare-"))
  try {
    assert.equal(resolveProject([bare]), bare)
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

test("textOf joins text parts only", () => {
  assert.equal(
    textOf([
      { type: "text", text: "a" },
      { type: "tool", text: "ignored" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  )
  assert.equal(textOf(undefined), "")
})

test("hook output parsing helpers", () => {
  assert.equal(
    additionalContext({ hookSpecificOutput: { additionalContext: "RECONCILE SOURCE FIRST: /x" } }),
    "RECONCILE SOURCE FIRST: /x",
  )
  assert.equal(additionalContext({}), null)
  assert.equal(permissionDenied({ hookSpecificOutput: { permissionDecision: "deny" } }), true)
  assert.equal(permissionDenied({ hookSpecificOutput: { permissionDecision: "allow" } }), false)
  assert.equal(systemMessage({ systemMessage: "warn" }), "warn")
  assert.equal(systemMessage({}), null)
})

test("limit truncates long strings", () => {
  assert.equal(limit("abc", 10), "abc")
  assert.match(limit("abcdef", 2), /truncated/)
})

test("compactContext projects the live state", () => {
  const out = JSON.parse(
    compactContext({
      projection: "p/objective.txt",
      state: {
        head_hash: "H",
        revision: 3,
        current_contract_id: null,
        open_outcomes: { "O-1": { status: "OPEN" } },
        unclassified_source_ids: ["SRC-1"],
      },
    }),
  )
  assert.equal(out.head_hash, "H")
  assert.equal(out.open_outcomes["O-1"], "OPEN")
  assert.deepEqual(out.unclassified_source_ids, ["SRC-1"])
  assert.equal(out.projection, "p/objective.txt")
})

test("expandPlaceholders resolves project tokens without spawning the runtime", async () => {
  const project = join(tmpdir(), "oif-project-token")
  const { expanded, unresolved } = await expandPlaceholders(project, "ses_1", [
    "--config",
    "{config}",
    "--logical-chat-id",
    "{sessionID}",
  ])
  assert.equal(expanded[1], join(project, ".oif-state", "config.json"))
  assert.equal(expanded[3], "ses_1")
  assert.deepEqual(unresolved, [])
})

test("expandPlaceholders reports unresolved known tokens", async () => {
  const project = join(tmpdir(), "oif-project-token2")
  const { unresolved } = await expandPlaceholders(project, "ses_1", ["--head", "{head}"])
  assert.deepEqual(unresolved, ["{head}"])
})

test("materializeInput writes a JSON temp file under .oif-state/tmp", () => {
  const project = makeProject()
  try {
    const path = materializeInput(project, { a: 1 })
    assert.ok(existsSync(path))
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { a: 1 })
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test("summarizeResolve compacts a selection receipt", () => {
  const out = JSON.parse(
    summarizeResolve(
      {
        schema_version: "mgskill-selection-receipt-v1",
        decision: "selected",
        errors: [],
        selected: [{ name: "skill-a", skill_id: "S-A", version: "1.0.0", status: "active-bounded" }],
        rejected: [{ name: "skill-b", reasons: ["no trigger clause matched"] }],
        selection_snapshot_sha256: "ABC",
      },
      false,
    ),
  )
  assert.equal(out.decision, "selected")
  assert.equal(out.selected[0].name, "skill-a")
  assert.equal(out.rejected[0].name, "skill-b")
})

test("pick returns the first defined value", () => {
  assert.equal(pick(undefined, null, "x"), "x")
  assert.equal(pick(undefined, null), undefined)
})

test("artifactProjectKey is stable 12 hex chars", () => {
  const key = artifactProjectKey("C:/some/project")
  assert.match(key, /^[0-9a-f]{12}$/)
  assert.equal(key, artifactProjectKey("C:/some/project"))
})

test("genEventId matches the safe event id shape", () => {
  assert.match(genEventId(), /^oc-[a-z0-9]+-[0-9a-f]+$/)
})
