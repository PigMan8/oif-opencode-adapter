// oif-opencode-adapter
//
// An OpenCode adapter for the Objective Integrity Framework (OIF).
// SPDX-License-Identifier: Apache-2.0
//
// This file is an optional OpenCode integration, not part of the OIF framework
// identity. OIF is published by Chisiki1/objective-integrity-framework under
// Apache-2.0. See NOTICE for attribution.
//
// ---
// Objective Integrity Framework (OIF) adapter for OpenCode.
//
// Two integration surfaces:
//   1. Host hooks -> OIF runtime host contract (`objective_ledger.py hook ...`).
//   2. A custom `oif` tool -> OIF owner-input caller (`ledger_input.py`), so the
//      agent can resolve sources, record progress and actions without knowing
//      the host session id, config path, or current head hash.
//
// Activates only for projects that contain BOTH:
//   <project>/.oif/runtime/objective_ledger.py
//   <project>/.oif-state/config.json
//
// Posture: advisory by default. Set OIF_ENFORCE=1 to hard-block mutating tools
// when the runtime returns a deny decision.
//
// Environment:
//   OIF_PYTHON            python executable (default: python on win32, python3 otherwise)
//   OIF_ENFORCE           1/true to block on hold
//   OIF_HOOK_TIMEOUT_MS   per-hook timeout (default 15000)
//   OIF_PROJECT           override project root (default: discovered per session)
//   OIF_ALWAYS_INJECT     1/true to keep the ledger pointer in the system prompt every turn
//   OIF_INCLUDE_CARD      0/false to skip injecting the objective card at compaction

import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { tool } from "@opencode-ai/plugin"

const RUNTIME_REL = join(".oif", "runtime", "objective_ledger.py")
const LEDGER_INPUT_REL = join(
  ".oif",
  "runtime",
  "skills",
  "chat-objective-continuity",
  "scripts",
  "ledger_input.py",
)
const OIF_REL = join(".oif", "tools", "oif.py")
const CONFIG_REL = join(".oif-state", "config.json")
const BINDINGS_REL = join(".oif-state", "bindings")
const SERVICE = "oif"

const PYTHON =
  process.env.OIF_PYTHON || (process.platform === "win32" ? "python" : "python3")
const ENFORCE =
  process.env.OIF_ENFORCE === "1" || process.env.OIF_ENFORCE === "true"
const ALWAYS_INJECT =
  process.env.OIF_ALWAYS_INJECT === "1" || process.env.OIF_ALWAYS_INJECT === "true"
const INCLUDE_CARD = process.env.OIF_INCLUDE_CARD !== "0"
const HOOK_TIMEOUT_MS = Number(process.env.OIF_HOOK_TIMEOUT_MS || 15000)

const OIF_COMMANDS = [
  "objective",
  "objective-input",
  "facts-build",
  "facts-compile",
  "resolve",
  "registry-check",
  "skill-inventory",
  "master-inventory",
  "apply-skill",
  "learning",
  "index",
  "reconcile",
  "operation",
  "artifact",
  "lifecycle",
  "allocate",
  "allocation-io",
  "work",
  "work-phase",
  "capabilities",
  "candidate",
  "adopt",
  "governance",
  "transition",
  "scenarios",
  "control",
  "legacy-status",
  "catalog",
  "demo",
  "bootstrap",
  "plugin",
]

const configCache = { path: null, mtimeMs: 0, value: null }
const runtimeHashCache = { path: null, mtimeMs: 0, value: null }

function loadConfig(path) {
  try {
    const mtimeMs = statSync(path).mtimeMs
    if (configCache.path === path && configCache.mtimeMs === mtimeMs) {
      return configCache.value
    }
    const value = JSON.parse(readFileSync(path, "utf8"))
    configCache.path = path
    configCache.mtimeMs = mtimeMs
    configCache.value = value
    return value
  } catch {
    return null
  }
}

function runtimeSha256(project) {
  const path = join(project, RUNTIME_REL)
  try {
    const mtimeMs = statSync(path).mtimeMs
    if (runtimeHashCache.path === path && runtimeHashCache.mtimeMs === mtimeMs) {
      return runtimeHashCache.value
    }
    const value = createHash("sha256").update(readFileSync(path)).digest("hex")
    runtimeHashCache.path = path
    runtimeHashCache.mtimeMs = mtimeMs
    runtimeHashCache.value = value
    return value
  } catch {
    return null
  }
}

function resolveProject(starts) {
  const seen = new Set()
  for (const start of starts.filter(Boolean)) {
    let dir
    try {
      dir = resolve(start)
    } catch {
      continue
    }
    for (let depth = 0; depth < 60; depth++) {
      if (seen.has(dir)) break
      seen.add(dir)
      if (existsSync(join(dir, RUNTIME_REL)) && existsSync(join(dir, CONFIG_REL))) {
        return dir
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

function runProcess(project, scriptRel, argv, payload, env, timeoutMs = HOOK_TIMEOUT_MS) {
  const script = join(project, scriptRel)
  return new Promise((done) => {
    let child
    try {
      child = spawn(PYTHON, ["-B", script, ...argv], {
        cwd: project,
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      done({ ok: false, error: String(error) })
      return
    }

    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish({ ok: false, error: "timeout" })
    }, timeoutMs)

    child.on("error", (error) => finish({ ok: false, error: String(error) }))
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, code, stdout, stderr })
        return
      }
      const trimmed = stdout.trim()
      if (!trimmed) {
        finish({ ok: true, value: null })
        return
      }
      try {
        finish({ ok: true, value: JSON.parse(trimmed) })
      } catch (error) {
        finish({ ok: false, code: 0, error: String(error), stdout, stderr })
      }
    })
    child.stdin.on("error", () => {})
    try {
      if (payload === undefined) child.stdin.end()
      else {
        child.stdin.write(JSON.stringify(payload))
        child.stdin.end()
      }
    } catch {}
  })
}

function textOf(parts) {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function additionalContext(value) {
  const hook = value && value.hookSpecificOutput
  return hook && typeof hook.additionalContext === "string" ? hook.additionalContext : null
}

function permissionDenied(value) {
  const hook = value && value.hookSpecificOutput
  return Boolean(hook && hook.permissionDecision === "deny")
}

function systemMessage(value) {
  return value && typeof value.systemMessage === "string" ? value.systemMessage : null
}

function readCard(project, projectionPath) {
  try {
    if (!projectionPath || !existsSync(projectionPath)) return null
    const card = readFileSync(projectionPath, "utf8").trim()
    return card || null
  } catch {
    return null
  }
}

function ensureBinding(project, sessionID) {
  try {
    const dir = join(project, BINDINGS_REL)
    mkdirSync(dir, { recursive: true })
    const name = createHash("sha256").update(String(sessionID)).digest("hex") + ".json"
    const file = join(dir, name)
    const expected = JSON.stringify({ role: "root", session_id: String(sessionID) })
    if (existsSync(file)) {
      try {
        if (readFileSync(file, "utf8").trim() === expected) return
      } catch {}
    }
    writeFileSync(file, expected, { encoding: "utf8" })
  } catch {}
}

function genEventId() {
  return `oc-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`
}

function materializeInput(project, value) {
  const dir = join(project, ".oif-state", "tmp")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `oif-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.json`)
  writeFileSync(file, JSON.stringify(value === undefined ? {} : value, null, 2), { encoding: "utf8" })
  return file
}

async function runOif(project, argv, payload, env, timeoutMs) {
  return runProcess(project, OIF_REL, argv, payload, env, timeoutMs || HOOK_TIMEOUT_MS)
}

function formatOifResult(command, result) {
  if (result.ok) {
    return { title: `oif ${command}`, output: limit(JSON.stringify(result.value, null, 2)), metadata: { ok: true } }
  }
  if (result.code === 0 && typeof result.stdout === "string") {
    return { title: `oif ${command}`, output: limit(result.stdout), metadata: { ok: true } }
  }
  const detail = [result.stderr, result.stdout].filter(Boolean).join("\n")
  return {
    title: `oif ${command} failed`,
    output: limit(detail || result.error || "unknown error"),
    metadata: { ok: false, code: result.code },
  }
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function summarizeResolve(value, full) {
  if (full) return limit(JSON.stringify(value, null, 2), 60000)
  const name = (item) => (item && (item.name || item.skill_id)) || item
  return JSON.stringify(
    {
      schema_version: value.schema_version,
      decision: value.decision,
      errors: value.errors || [],
      selected: (value.selected || []).map((s) => ({
        name: s.name,
        skill_id: s.skill_id,
        version: s.version,
        status: s.status,
        canonical_path: s.canonical_path,
      })),
      rejected: (value.rejected || []).map((s) => ({ name: name(s), reasons: s.reasons })),
      near_matches: (value.near_matches || value.near || []).map(name),
      no_match: (value.no_match || []).map(name),
      withheld_count: value.withheld_count,
      stale_snapshot: value.stale_snapshot,
      selection_snapshot_sha256: value.selection_snapshot_sha256,
      registry_id: value.registry_id,
      registry_path: value.registry_path,
      input_path: value.input_path,
      input_sha256: value.input_sha256,
      proof_ceiling: value.proof_ceiling,
    },
    null,
    2,
  )
}

function artifactInventoryDir() {
  const dir = join(tmpdir(), "oif")
  mkdirSync(dir, { recursive: true })
  return dir
}

function artifactProjectKey(project) {
  return createHash("sha256").update(project).digest("hex").slice(0, 12)
}

function newestInventory(project) {
  try {
    const dir = artifactInventoryDir()
    const prefix = `artifact-inventory-${artifactProjectKey(project)}-`
    const files = readdirSync(dir).filter((name) => name.startsWith(prefix)).sort()
    return files.length ? join(dir, files[files.length - 1]) : null
  } catch {
    return null
  }
}

function limit(text, max = 24000) {
  if (typeof text !== "string") text = JSON.stringify(text)
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text
}

function compactContext(status) {
  const state = (status && status.state) || {}
  const outcomes = {}
  for (const [id, value] of Object.entries(state.open_outcomes || {})) {
    outcomes[id] = value && value.status ? value.status : "OPEN"
  }
  return JSON.stringify(
    {
      head_hash: state.head_hash,
      revision: state.revision,
      current_contract_id: state.current_contract_id,
      projection: status && status.projection,
      open_outcomes: outcomes,
      unclassified_source_ids: state.unclassified_source_ids || [],
      unproven_source_ids: state.unproven_source_ids || [],
      unknown_effect_action_ids: state.unknown_effect_action_ids || [],
      unresolved_capture_gap_ids: state.unresolved_capture_gap_ids || [],
    },
    null,
    2,
  )
}

async function expandPlaceholders(project, sessionID, argv) {
  const runtime = join(project, RUNTIME_REL)
  const config = join(project, CONFIG_REL)
  const map = {
    "{project}": project,
    "{oif}": join(project, ".oif"),
    "{runtime}": runtime,
    "{config}": config,
    "{ledgerInput}": join(project, LEDGER_INPUT_REL),
  }
  if (sessionID) map["{sessionID}"] = sessionID
  const has = (token) => argv.some((arg) => typeof arg === "string" && arg.includes(token))
  if (has("{runtimeSha}")) {
    const sha = runtimeSha256(project)
    if (sha) map["{runtimeSha}"] = sha
  }
  if (has("{head}")) {
    const status = await runProcess(project, RUNTIME_REL, [
      "status",
      "--config",
      config,
      "--logical-chat-id",
      sessionID,
    ])
    if (status.ok && status.value && status.value.state && status.value.state.head_hash) {
      map["{head}"] = status.value.state.head_hash
    }
  }
  if (has("{ledgerRoot}")) {
    const ov = await runProcess(project, LEDGER_INPUT_REL, [
      "owner-view",
      "--runtime",
      runtime,
      "--runtime-sha256",
      runtimeSha256(project) || "",
      "--config",
      config,
      "--logical-chat-id",
      sessionID,
    ])
    if (ov.ok && ov.value && ov.value.ledger_root) map["{ledgerRoot}"] = ov.value.ledger_root
  }
  const unresolved = []
  const expanded = argv.map((arg) => {
    if (typeof arg !== "string") return arg
    let out = arg
    for (const [token, value] of Object.entries(map)) out = out.split(token).join(value)
    if (/\{(project|oif|runtime|runtimeSha|config|sessionID|head|ledgerRoot|ledgerInput)\}/.test(out)) {
      unresolved.push(arg)
    }
    return out
  })
  return { expanded, unresolved }
}

export const OIFPlugin = async ({ client, directory, worktree }) => {
  const project = resolveProject([worktree, directory, process.env.OIF_PROJECT, process.cwd()])

  const log = async (level, message, extra) => {
    if (!client || !client.app || typeof client.app.log !== "function") return
    try {
      await client.app.log({ body: { service: SERVICE, level, message, extra } })
    } catch {}
  }

  if (!project) {
    await log("info", "OIF runtime not found; adapter inactive for this project", {
      directory,
    })
    return {}
  }

  const configPath = join(project, CONFIG_REL)
  const hook = (event, payload) =>
    runProcess(project, RUNTIME_REL, ["hook", "--config", configPath, "--event", event], payload)

  await log("info", "OIF adapter active", { project, enforce: ENFORCE })

  const advisories = new Map()

  return {
    tool: {
      oif: tool({
        description:
          "Objective Integrity Framework ledger operations for this project. Resolves the " +
          "host session, config and current head automatically. Actions: 'context' (compact " +
          "state: head, open outcomes, pending sources/actions), 'owner-view' (full current " +
          "objective, outcomes, source clauses, pending items), 'source-update' (classify the " +
          "latest prompt: fields source_event_id, disposition INITIAL|ADD|CLARIFY|CORRECT, " +
          "changes, new_outcomes, classification_note), 'progress', 'action-start', " +
          "'action-outcome', 'verify'. Mutations apply by default; pass apply:false to only " +
          "validate and return the prepared input.",
        args: {
          action: tool.schema.enum([
            "context",
            "owner-view",
            "source-update",
            "progress",
            "action-start",
            "action-outcome",
            "verify",
          ]),
          payload: tool.schema
            .record(tool.schema.string(), tool.schema.any())
            .optional()
            .describe("Action-specific fields object, e.g. the source-update delta or action fields."),
          apply: tool.schema
            .boolean()
            .optional()
            .describe("Commit the change (default true for source-update/progress/action-*)."),
          expectedHead: tool.schema
            .string()
            .optional()
            .describe("Explicit observed head hash; omit to read the current head."),
          eventId: tool.schema
            .string()
            .optional()
            .describe("Unique event id; auto-generated when omitted."),
        },
        async execute(args, context) {
          const proj = resolveProject([
            context.worktree,
            context.directory,
            process.env.OIF_PROJECT,
            project,
          ])
          if (!proj) {
            return {
              title: "oif",
              output: "No OIF runtime found for this project (.oif/runtime + .oif-state/config.json required).",
            }
          }
          const sessionID = context.sessionID
          const cfg = join(proj, CONFIG_REL)
          const runtime = join(proj, RUNTIME_REL)
          const action = args.action

          if (action === "verify") {
            const result = await runProcess(proj, RUNTIME_REL, [
              "verify",
              "--config",
              cfg,
              "--logical-chat-id",
              sessionID,
            ])
            if (!result.ok) {
              return { title: "oif verify failed", output: limit(result.stderr || result.error || "unknown error") }
            }
            return { title: "oif verify", output: limit(JSON.stringify(result.value, null, 2)) }
          }

          if (action === "context" || action === "owner-view") {
            if (action === "context") {
              const result = await runProcess(proj, RUNTIME_REL, [
                "status",
                "--config",
                cfg,
                "--logical-chat-id",
                sessionID,
              ])
              if (!result.ok) {
                return { title: "oif context failed", output: limit(result.stderr || result.error || "unknown error") }
              }
              return { title: "oif context", output: compactContext(result.value) }
            }
            const sha = runtimeSha256(proj)
            const result = await runProcess(proj, LEDGER_INPUT_REL, [
              "owner-view",
              "--runtime",
              runtime,
              "--runtime-sha256",
              sha,
              "--config",
              cfg,
              "--logical-chat-id",
              sessionID,
            ])
            if (!result.ok) {
              return { title: "oif owner-view failed", output: limit(result.stderr || result.error || "unknown error") }
            }
            return { title: "oif owner-view", output: limit(JSON.stringify(result.value, null, 2)) }
          }

          const apply = args.apply !== false
          const fields = (args.payload && { ...args.payload }) || {}

          let head = args.expectedHead
          if (!head) {
            const status = await runProcess(proj, RUNTIME_REL, [
              "status",
              "--config",
              cfg,
              "--logical-chat-id",
              sessionID,
            ])
            if (!status.ok) {
              return {
                title: "oif error",
                output: `Could not read the current head: ${limit(status.stderr || status.error || "unknown error")}`,
              }
            }
            head = status.value && status.value.state && status.value.state.head_hash
          }

          const sha = runtimeSha256(proj)
          if (!sha) {
            return { title: "oif error", output: "Could not hash the OIF runtime." }
          }

          if (apply) ensureBinding(proj, sessionID)

          const eventId = args.eventId || genEventId()
          const argv = [
            action,
            "--runtime",
            runtime,
            "--runtime-sha256",
            sha,
            "--config",
            cfg,
            "--logical-chat-id",
            sessionID,
            "--fields",
            "-",
          ]
          if (head) argv.push("--expected-head", head)
          if (apply) argv.push("--apply", "--event-id", eventId)

          const result = await runProcess(
            proj,
            LEDGER_INPUT_REL,
            argv,
            fields,
            apply ? { OIF_SESSION_ID: sessionID } : undefined,
          )

          if (!result.ok) {
            return {
              title: `oif ${action} rejected`,
              output: limit(result.stderr || result.error || "unknown error"),
              metadata: { ok: false, code: result.code },
            }
          }
          return {
            title: `oif ${action}${apply ? " applied" : " prepared"}`,
            output: limit(JSON.stringify(result.value, null, 2)),
            metadata: { ok: true, applied: apply },
          }
        },
      }),

      oif_run: tool({
        description:
          "Run any OIF command directory entry (python .oif/tools/oif.py <command> ...) with the " +
          "project runtime, config, session and head resolved for you. Placeholders usable inside " +
          "args: {project} {oif} {runtime} {runtimeSha} {config} {sessionID} {head} {ledgerRoot} " +
          "{ledgerInput}. Pass a JSON object to stdin via payload. command 'list' prints the " +
          "directory; every command supports '<command> --help'. Commands: " +
          OIF_COMMANDS.join(", ") +
          ".",
        args: {
          command: tool.schema.string().describe("OIF command name, or 'list' for the directory."),
          subcommand: tool.schema
            .string()
            .optional()
            .describe("First positional of the command, e.g. 'query' for index, 'prepare' for work."),
          args: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Arguments passed through; placeholders are expanded."),
          inputs: tool.schema
            .record(tool.schema.string(), tool.schema.any())
            .optional()
            .describe(
              "Map of a CLI flag to a JSON value, e.g. {\"--input\": {...}}. Each value is written " +
                "to a temp file and passed as the flag's path, so no manual file creation is needed.",
            ),
          payload: tool.schema
            .record(tool.schema.string(), tool.schema.any())
            .optional()
            .describe("JSON object piped to stdin."),
          timeoutMs: tool.schema
            .number()
            .optional()
            .describe("Process timeout in milliseconds (default 15000)."),
          raw: tool.schema
            .boolean()
            .optional()
            .describe("Return raw stdout/stderr instead of parsed JSON."),
        },
        async execute(args, context) {
          const proj = resolveProject([
            context.worktree,
            context.directory,
            process.env.OIF_PROJECT,
            project,
          ])
          if (!proj) {
            return { title: "oif_run", output: "No OIF runtime found for this project." }
          }
          const sessionID = context.sessionID
          const { expanded, unresolved } = await expandPlaceholders(
            proj,
            sessionID,
            args.args || [],
          )
          if (unresolved.length) {
            return {
              title: "oif_run error",
              output: `Unresolved placeholders: ${unresolved.join(", ")}`,
            }
          }
          if (sessionID) ensureBinding(proj, sessionID)
          const argv = [args.command]
          if (args.subcommand) argv.push(args.subcommand)
          argv.push(...expanded)
          if (args.command === "learning" && !argv.includes("--db")) {
            argv.push("--db", join(proj, ".oif-state", "learning.db"))
          }
          if (args.inputs) {
            for (const [flag, value] of Object.entries(args.inputs)) {
              argv.push(flag, materializeInput(proj, value))
            }
          }
          const result = await runProcess(
            proj,
            OIF_REL,
            argv,
            args.payload,
            sessionID ? { OIF_SESSION_ID: sessionID } : undefined,
            args.timeoutMs || HOOK_TIMEOUT_MS,
          )
          return formatOifResult(args.command, result)
        },
      }),

      oif_flow: tool({
        description:
          "Guided OIF workflows that remove file and chain plumbing for advanced features. flow: " +
          "'artifact' (subaction inventory|read|diff|json), 'learning' (init|upsert|status|history|due), " +
          "'check' (fields.type transition|scenarios|control|lifecycle|governance|reconcile), " +
          "'work' (subaction prepare|phase), 'skill-registry' (build catalog), " +
          "'skill-resolve' (facts-build -> facts-compile -> resolve chain). " +
          "Scalars go in fields; JSON objects (input, spec, plan, payload) go in inputs and are " +
          "written to temp files automatically. Paths default under .oif-state.",
        args: {
          flow: tool.schema.enum([
            "artifact",
            "learning",
            "check",
            "work",
            "skill-registry",
            "skill-resolve",
          ]),
          subaction: tool.schema.string().optional().describe("Flow subaction."),
          fields: tool.schema
            .record(tool.schema.string(), tool.schema.any())
            .optional()
            .describe("Scalar fields for the flow."),
          inputs: tool.schema
            .record(tool.schema.string(), tool.schema.any())
            .optional()
            .describe("JSON objects materialized to temp files (e.g. input, spec, plan, payload)."),
          timeoutMs: tool.schema.number().optional().describe("Process timeout in milliseconds."),
        },
        async execute(args, context) {
          const proj = resolveProject([
            context.worktree,
            context.directory,
            process.env.OIF_PROJECT,
            project,
          ])
          if (!proj) {
            return { title: "oif_flow", output: "No OIF runtime found for this project." }
          }
          const f = args.fields || {}
          const ins = args.inputs || {}
          const timeout = args.timeoutMs || HOOK_TIMEOUT_MS
          const flow = args.flow
          const tmp = join(proj, ".oif-state", "tmp")

          if (flow === "artifact") {
            const sub = args.subaction || "inventory"
            const argv = ["artifact", sub]
            if (sub === "inventory") {
              let out = f.output
              if (!out) {
                out = join(
                  artifactInventoryDir(),
                  `artifact-inventory-${artifactProjectKey(proj)}-${randomBytes(4).toString("hex")}.json`,
                )
              }
              argv.push("--root", f.root || proj, "--output", out)
            } else if (sub === "read") {
              const inv = f.inventory || newestInventory(proj)
              if (inv && existsSync(inv)) argv.push("--inventory", inv)
              else if (f.manifest) argv.push("--manifest", f.manifest)
              if (f.root) argv.push("--root", f.root)
              if (f.path === undefined) {
                return { title: "oif_flow artifact", output: "fields.path is required for read." }
              }
              argv.push("--path", f.path)
              if (f.start !== undefined) argv.push("--start", String(f.start))
              if (f.lines !== undefined) argv.push("--lines", String(f.lines))
            } else if (sub === "diff") {
              argv.push("--left", f.left, "--right", f.right)
              if (f.lines !== undefined) argv.push("--lines", String(f.lines))
            } else if (sub === "json") {
              argv.push("--file", f.file)
              if (f.pointer) argv.push("--pointer", f.pointer)
              if (f.keys) argv.push("--keys")
              if (f.chars !== undefined) argv.push("--chars", String(f.chars))
            } else {
              return { title: "oif_flow artifact", output: "subaction must be inventory|read|diff|json." }
            }
            return formatOifResult(`artifact ${sub}`, await runOif(proj, argv, undefined, undefined, timeout))
          }

          if (flow === "learning") {
            const sub = args.subaction || "status"
            const db = f.db || join(proj, ".oif-state", "learning.db")
            const argv = ["learning", sub, "--db", db]
            if (sub === "upsert") {
              argv.push("--input", materializeInput(proj, pick(ins.payload, f.payload)))
            } else if (sub === "status" || sub === "history") {
              if (!f.candidateId) {
                return { title: "oif_flow learning", output: "fields.candidateId is required." }
              }
              argv.push("--candidate-id", f.candidateId)
            } else if (sub === "due") {
              if (!f.objectiveRef || !f.familyKey || !f.trigger) {
                return {
                  title: "oif_flow learning",
                  output: "fields.objectiveRef, familyKey and trigger are required for due.",
                }
              }
              argv.push("--objective-ref", f.objectiveRef, "--family-key", f.familyKey, "--trigger", f.trigger)
              if (f.limit !== undefined) argv.push("--limit", String(f.limit))
              if (f.cursor) argv.push("--cursor", f.cursor)
            } else if (sub !== "init") {
              return { title: "oif_flow learning", output: "subaction must be init|upsert|status|history|due." }
            }
            return formatOifResult(`learning ${sub}`, await runOif(proj, argv, undefined, undefined, timeout))
          }

          if (flow === "check") {
            const type = f.type || args.subaction
            const map = {
              transition: "transition",
              scenarios: "scenarios",
              control: "control",
              lifecycle: "lifecycle",
              governance: "governance",
              reconcile: "reconcile",
            }
            if (!type || !map[type]) {
              return {
                title: "oif_flow check",
                output: "fields.type must be transition|scenarios|control|lifecycle|governance|reconcile.",
              }
            }
            const inputObj = pick(ins.input, f.input)
            if (inputObj === undefined) {
              return { title: "oif_flow check", output: "inputs.input (JSON object) is required." }
            }
            const path = materializeInput(proj, inputObj)
            let argv
            if (type === "lifecycle") argv = ["lifecycle", f.phase || "effect", "--input", path]
            else if (type === "reconcile") argv = ["reconcile", f.phase || "inventory", "--input", path]
            else argv = [map[type], "--input", path]
            return formatOifResult(type, await runOif(proj, argv, undefined, undefined, timeout))
          }

          if (flow === "work") {
            const sub = args.subaction || "phase"
            if (sub === "prepare") {
              const spec = pick(ins.spec, f.spec)
              if (spec === undefined) {
                return { title: "oif_flow work", output: "inputs.spec is required for prepare." }
              }
              return formatOifResult(
                "work prepare",
                await runOif(proj, ["work", "prepare", "--spec", materializeInput(proj, spec)], undefined, undefined, timeout),
              )
            }
            const input = pick(ins.input, f.input)
            if (input === undefined) {
              return { title: "oif_flow work", output: "inputs.input is required for phase." }
            }
            return formatOifResult(
              "work-phase",
              await runOif(proj, ["work-phase", "--input", materializeInput(proj, input)], undefined, undefined, timeout),
            )
          }

          if (flow === "skill-registry") {
            const out = f.output || join(proj, ".oif-state", "skill-registry.json")
            if (existsSync(out) && !f.force) {
              return {
                title: "oif_flow skill-registry",
                output: JSON.stringify(
                  { status: "exists", path: out, note: "Set fields.force=true or fields.output to regenerate." },
                  null,
                  2,
                ),
              }
            }
            return formatOifResult("catalog", await runOif(proj, ["catalog", "--output", out], undefined, undefined, timeout))
          }

          if (flow === "skill-resolve") {
            const registry = f.registry || join(proj, ".oif-state", "skill-registry.json")
            const userRoot = f.userRoot || join(homedir(), ".agents", "skills")
            const projectRoot =
              f.projectRoot ||
              [join(proj, ".agents", "skills"), join(proj, ".oif", "runtime", "skills")].find((p) =>
                existsSync(p),
              )
            const ensureRegistry = async () => {
              if (existsSync(registry)) return null
              const built = await runOif(proj, ["catalog", "--output", registry], undefined, undefined, timeout)
              return built.ok || built.code === 0 ? null : formatOifResult("catalog", built)
            }
            const directInput = pick(ins.resolveInput, f.resolveInput)
            if (directInput !== undefined) {
              const failed = await ensureRegistry()
              if (failed) return failed
              const inputPath = materializeInput(proj, directInput)
              const argv = ["resolve", "--input", inputPath, "--registry", registry, "--user-root", userRoot]
              if (projectRoot && existsSync(projectRoot)) argv.push("--project-root", projectRoot)
              const resolved = await runOif(proj, argv, undefined, undefined, timeout)
              if (!resolved.ok) return formatOifResult("resolve", resolved)
              return { title: "oif_flow skill-resolve", output: summarizeResolve(resolved.value, f.full), metadata: { ok: true } }
            }
            const plan = pick(ins.plan, f.plan)
            if (plan === undefined) {
              return {
                title: "oif_flow skill-resolve",
                output:
                  "Provide inputs.resolveInput (mgskill-resolve-input-v1 fact arrays, easy) or " +
                  "inputs.plan (mgskill-fact-builder-plan-v1, full provenance chain).",
              }
            }
            const failed = await ensureRegistry()
            if (failed) return failed
            const planPath = materializeInput(proj, plan)
            const v2 = join(tmp, `v2-${randomBytes(4).toString("hex")}.json`)
            const facts = join(tmp, `facts-${randomBytes(4).toString("hex")}.json`)
            const rinput = join(tmp, `resolve-${randomBytes(4).toString("hex")}.json`)
            const step1 = await runOif(
              proj,
              ["facts-build", "--plan", planPath, "--registry", registry, "--output", v2],
              undefined,
              undefined,
              timeout,
            )
            if (!step1.ok) return formatOifResult("facts-build", step1)
            const step2 = await runOif(
              proj,
              ["facts-compile", "--source", v2, "--registry", registry, "--output", facts, "--resolver-input-output", rinput],
              undefined,
              undefined,
              timeout,
            )
            if (!step2.ok) return formatOifResult("facts-compile", step2)
            const rootArgs = ["--input", rinput, "--registry", registry, "--user-root", userRoot]
            if (projectRoot && existsSync(projectRoot)) rootArgs.push("--project-root", projectRoot)
            const step3 = await runOif(proj, ["resolve", ...rootArgs], undefined, undefined, timeout)
            if (!step3.ok) return formatOifResult("resolve", step3)
            return {
              title: "oif_flow skill-resolve",
              output: f.full
                ? limit(
                    JSON.stringify(
                      { registry, plan: planPath, v2_input: v2, compiled_facts: facts, resolver_input: rinput, result: step3.value },
                      null,
                      2,
                    ),
                    60000,
                  )
                : summarizeResolve(step3.value, false),
              metadata: { ok: true },
            }
          }

          return { title: "oif_flow", output: "Unknown flow." }
        },
      }),
    },

    "shell.env": async (input, output) => {
      const proj = resolveProject([input.cwd, process.env.OIF_PROJECT, project])
      if (!proj) return
      output.env.OIF_PROJECT = proj
      output.env.OIF_OIF = join(proj, OIF_REL)
      output.env.OIF_RUNTIME = join(proj, RUNTIME_REL)
      output.env.OIF_CONFIG = join(proj, CONFIG_REL)
      output.env.OIF_LEDGER_INPUT = join(proj, LEDGER_INPUT_REL)
      if (input.sessionID) {
        output.env.OIF_SESSION_ID = input.sessionID
        ensureBinding(proj, input.sessionID)
      }
    },

    "chat.message": async (input, output) => {
      const prompt = textOf(output.parts)
      if (!prompt) return
      const payload = { session_id: input.sessionID, prompt }
      if (input.messageID) payload.turn_id = input.messageID
      const result = await hook("UserPromptSubmit", payload)
      if (!result.ok) {
        await log("warn", "OIF UserPromptSubmit capture failed", result)
        return
      }
      const context = additionalContext(result.value)
      if (!context) return
      if (context.startsWith("RECONCILE SOURCE FIRST") || context.startsWith("RECOVER SOURCE FIRST")) {
        advisories.set(input.sessionID, context)
      } else if (!ALWAYS_INJECT) {
        advisories.delete(input.sessionID)
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const result = await hook("SessionStart", { session_id: input.sessionID })
      if (!result.ok) {
        await log("warn", "OIF SessionStart read failed", result)
        return
      }
      const context = additionalContext(result.value)
      if (!context) return
      output.context.push(`## Objective Integrity (OIF)\n${context}`)

      if (INCLUDE_CARD && context.startsWith("READ FIRST")) {
        const status = await runProcess(project, RUNTIME_REL, [
          "status",
          "--config",
          configPath,
          "--logical-chat-id",
          input.sessionID,
        ])
        const projection = status.ok && status.value ? status.value.projection : null
        const card = readCard(project, projection)
        if (card) output.context.push(`## Objective Card\n${card}`)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const note = input.sessionID ? advisories.get(input.sessionID) : null
      if (note) output.system.push(`Objective Integrity advisory: ${note}`)
    },

    "tool.execute.before": async (input) => {
      const config = loadConfig(configPath)
      const classes = (config && config.tool_classes) || {}
      const cls = classes[input.tool]
      if (cls !== "mutating" && cls !== "mixed") return

      const result = await hook("PreToolUse", {
        session_id: input.sessionID,
        tool_name: input.tool,
        tool_call_id: input.callID,
      })
      if (!result.ok) {
        await log("warn", "OIF PreToolUse failed", result)
        return
      }
      if (permissionDenied(result.value)) {
        const reason =
          (result.value.hookSpecificOutput &&
            result.value.hookSpecificOutput.permissionDecisionReason) ||
          "objective continuity hold"
        const message = `OIF hold on ${input.tool}: ${reason}`
        advisories.set(input.sessionID, message)
        await log("warn", message, result.value)
        if (ENFORCE) throw new Error(message)
      } else {
        advisories.delete(input.sessionID)
      }
    },

    event: async ({ event }) => {
      if (!event || typeof event.type !== "string") return
      if (event.type === "session.created") {
        const sessionID =
          event.properties && event.properties.info && event.properties.info.id
        if (!sessionID) return
        const result = await hook("SessionStart", { session_id: sessionID })
        if (result.ok) {
          const context = additionalContext(result.value)
          if (context && context.startsWith("RECONCILE")) {
            advisories.set(sessionID, context)
          }
        }
      } else if (event.type === "session.idle") {
        const sessionID = event.properties && event.properties.sessionID
        if (!sessionID) return
        const result = await hook("Stop", { session_id: sessionID })
        const warning = result.ok ? systemMessage(result.value) : null
        if (warning) await log("warn", warning, { sessionID })
      } else if (event.type === "session.compacted") {
        const sessionID = event.properties && event.properties.sessionID
        if (sessionID) {
          await hook("PostCompact", { session_id: sessionID })
          advisories.delete(sessionID)
        }
      }
    },
  }
}

// Internal helpers exported for unit tests. Not a public API.
export const __internal = {
  resolveProject,
  loadConfig,
  runtimeSha256,
  textOf,
  additionalContext,
  permissionDenied,
  systemMessage,
  readCard,
  ensureBinding,
  genEventId,
  limit,
  compactContext,
  expandPlaceholders,
  materializeInput,
  summarizeResolve,
  pick,
  artifactInventoryDir,
  artifactProjectKey,
  newestInventory,
}
