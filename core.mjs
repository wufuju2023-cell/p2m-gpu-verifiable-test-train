/**
 * p2m-gpu-verifiable-test-train — core engine (plain ESM, node stdlib only).
 *
 * Turns a directory of task packages into an RLVR run:
 *
 *   pgv_run     sample tasks, materialise one blind workspace per task
 *   pgv_next    claim the next pending task, hand back a brief
 *   pgv_check   run the gate stack in a *subprocess* and return the verdict
 *   pgv_submit  check + record the attempt + mark the task done
 *   pgv_status  counts / pass rate / per-tier table
 *   pgv_report  markdown capability table
 *   pgv_oracle  canary calibration (is the oracle actually catching bugs?)
 *   pgv_split   register child missions with a 4-field contract
 *
 * Everything is deterministic given (tasks dir, seed, run id). No network.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

export const MODEL = "opencode-go/deepseek-v4.1-flash#max"
export const AGENT_ID = "pgv-eval"

// `PGV_ROOT` makes the whole plugin testable against a *pinned* checkout
// (`git worktree add /tmp/p2m-head <sha>`). With absolute paths baked in, every
// selftest silently grades the wrong tree instead of the tree it was
// started from - which is how a "pinned" acceptance ends up measuring a dirty
// working copy.
const PGV_ROOT = process.env.PGV_ROOT || "./p2m-gpu-verifiable"

export const PATHS = {
  root: PGV_ROOT,
  tasks: path.join(PGV_ROOT, "tasks"),
  runs: path.join(PGV_ROOT, "runs"),
  harness: path.join(PGV_ROOT, "harness"),
  opencode: process.env.PGV_OPENCODE || "~/.opencode2/bin/opencode",
  python: process.env.PGV_PYTHON || "python3",
}

export const TIERS = ["K0", "K1", "K2", "K3", "K4", "T1", "T2", "T3", "T4"]
export const DEFAULT_TIMEOUT_S = 900

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex")
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

export function writeJson(file, obj, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8")
  fs.chmodSync(file, mode)
}

export function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8")
}

export function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seedFrom(text) {
  return parseInt(sha256(String(text)).slice(0, 8), 16)
}

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 20 * 60 * 1000,
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    code: r.status ?? (r.error ? -1 : 0),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error) : ""),
  }
}

// ---------------------------------------------------------------------------
// task listing / sampling
// ---------------------------------------------------------------------------

export function listTasks(tasksDir = PATHS.tasks) {
  if (!exists(tasksDir)) return []
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => {
      const dir = path.join(tasksDir, d.name)
      const metaFile = path.join(dir, "task.json")
      if (!exists(metaFile)) return null
      const meta = readJson(metaFile)
      return {
        dir,
        id: meta.id ?? d.name,
        tier: meta.tier ?? "?",
        kind: meta.kind ?? "kernel",
        title: meta.title ?? d.name,
        policy: meta.policy ?? {},
        perf: meta.perf ?? {},
        budget: meta.budget ?? {},
        require_kernel: Boolean(meta.require_kernel),
        spec_combined_sha256: meta.spec_combined_sha256,
        n_public: (meta.cases ?? {}).public ?? null,
        n_hidden: (meta.cases ?? {}).hidden ?? null,
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.tier + a.id).localeCompare(b.tier + b.id))
}

export function sampleTasks({ ids, tiers, perTier = 2, seed = "pgv-1", tasksDir = PATHS.tasks } = {}) {
  const all = listTasks(tasksDir)
  if (ids && ids.length) {
    const byId = new Map(all.map((t) => [t.id, t]))
    const picked = ids.map((id) => byId.get(id)).filter(Boolean)
    const missing = ids.filter((id) => !byId.has(id))
    if (missing.length) throw new Error(`unknown task ids: ${missing.join(", ")}`)
    return picked
  }
  const want = tiers && tiers.length ? tiers : TIERS
  const rnd = mulberry32(seedFrom(seed))
  const out = []
  for (const tier of want) {
    const pool = all.filter((t) => t.tier === tier)
    if (!pool.length) continue
    const shuffled = pool
      .map((t) => ({ t, k: rnd() }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.t)
    out.push(...shuffled.slice(0, perTier))
  }
  return out
}

// ---------------------------------------------------------------------------
// run lifecycle
// ---------------------------------------------------------------------------

export function newRunId(seed) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
  return `${stamp}-${sha256(String(seed)).slice(0, 6)}`
}

export function runPath(runId, runRoot = PATHS.runs) {
  return path.join(runRoot, runId)
}

export function loadRun(runId, runRoot = PATHS.runs) {
  const dir = runPath(runId, runRoot)
  const file = path.join(dir, "run.json")
  if (!exists(file)) throw new Error(`unknown run ${runId} (${file})`)
  return { dir, ...readJson(file) }
}

// The contract fingerprint captured when the run was created, held in memory.
// `task.json` is writable by the candidate, so a hash stored there only catches
// edits that forgot to re-stamp (R18a). This map is the anchor: it is fixed
// before the agent's first tool call and lives outside the graded tree.
const RUN_ANCHORS = new Map() // `${run_id}/${task_id}` -> sha256 hex

export function specAnchor(taskDir) {
  const r = sh(PATHS.python, [path.join(PATHS.harness, "pgv_grade.py"),
                              "--task", taskDir, "--print-spec"], { timeout: 120000 })
  try {
    const line = r.stdout.trim().split("\n").filter(Boolean).pop()
    return JSON.parse(line).combined ?? null
  } catch {
    return null
  }
}

export function saveRun(run, runRoot = PATHS.runs) {
  writeJson(path.join(runPath(run.run_id, runRoot), "run.json"), run)
}

export function createRun({
  ids,
  tiers,
  perTier = 2,
  seed = "pgv-1",
  model = MODEL,
  timeoutS = DEFAULT_TIMEOUT_S,
  runRoot = PATHS.runs,
  tasksDir = PATHS.tasks,
  force = false,
} = {}) {
  const picked = sampleTasks({ ids, tiers, perTier, seed, tasksDir })
  if (!picked.length) throw new Error("no tasks matched")
  const runId = newRunId(seed)
  const dir = runPath(runId, runRoot)
  // The anchor says "the package did not change between createRun and grading".
  // It cannot say "the package was the original at createRun" unless something
  // outside the tree pins it -- so at least refuse to anchor a package that is
  // dirty against HEAD, and record which commit the package was taken from.
  const anchorBase = (() => {
    const r = sh("git", ["-C", PATHS.root, "rev-parse", "HEAD"], { timeout: 15000 })
    return r.code === 0 ? r.stdout.trim() : null
  })()
  fs.mkdirSync(dir, { recursive: true })

  const tasks = []
  for (const t of picked) {
    const envDir = path.join(dir, t.id)
    if (exists(envDir) && !force) throw new Error(`${envDir} exists (use force)`)
    const r = sh(PATHS.python, [
      path.join(PATHS.harness, "pgv_materialize.py"),
      "--task", t.dir,
      "--out", envDir,
      "--model", model.split("#")[0],
      "--force",
    ])
    if (r.code !== 0) throw new Error(`materialize ${t.id} failed: ${r.stderr || r.stdout}`)
    // Fail closed: a run without an anchor would silently grade against the
    // candidate-writable `task.json` (R18a). If the anchor cannot be captured,
    // the run must not start.
    const rel = path.relative(PATHS.root, t.dir)
    const insideRepo = Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel)
    if (anchorBase && insideRepo) {
      const d = sh("git", ["-C", PATHS.root, "diff", "--quiet", "HEAD", "--", rel],
                   { timeout: 15000 })
      if (d.code !== 0) {
        throw new Error(`task package ${t.id} has uncommitted changes against ` +
                        `${anchorBase.slice(0, 7)}; refusing to anchor a dirty package`)
      }
    }
    const anchor = specAnchor(t.dir)
    if (!anchor) throw new Error(`could not capture the contract anchor for ${t.id}`)
    RUN_ANCHORS.set(`${runId}/${t.id}`, anchor)
    tasks.push({
      id: t.id,
      tier: t.tier,
      kind: t.kind,
      title: t.title,
      task_dir: t.dir,
      env_dir: envDir,
      spec_anchor: anchor,   // persisted for resumes; RUN_ANCHORS wins when live
      repo: path.join(envDir, "repo"),
      status: "pending",
      attempts: 0,
      best_reward: 0,
      last_failure: null,
      started_at: null,
      finished_at: null,
    })
  }

  const run = {
    run_id: runId,
    anchor_base: anchorBase,   // the commit the task packages were taken from
    seed,
    model,
    timeout_s: timeoutS,
    created: new Date().toISOString(),
    dir,
    tasks,
  }
  saveRun(run, runRoot)
  return { run_id: runId, dir, model, seed, ids: tasks.map((t) => t.id), tasks }
}

export function claimNext(runId, runRoot = PATHS.runs) {
  const run = loadRun(runId, runRoot)
  const claimDir = path.join(run.dir, "state", "claims")
  fs.mkdirSync(claimDir, { recursive: true })
  for (const t of run.tasks) {
    if (t.status !== "pending") continue
    const lock = path.join(claimDir, `${t.id}.lock`)
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" })
    } catch {
      continue // someone else got it
    }
    t.status = "running"
    t.started_at = new Date().toISOString()
    saveRun(run, runRoot)
    return { run, task: t }
  }
  return { run, task: null }
}

// ---------------------------------------------------------------------------
// grading
// ---------------------------------------------------------------------------

const FAILURES = new Set([
  "SPEC_TAMPERED", "FORBIDDEN", "IMPORT", "SMOKE", "MEMORY", "NONDET", "STATEFUL",
  "EQUIV_PUBLIC", "EQUIV_HIDDEN", "EXTRA", "NO_KERNEL", "PERF", "TIMEOUT",
  // A tamper verdict is *also* a real verdict, and dropping it here is worse
  // than never having it: the agent is told "unknown failure class" and loses
  // the per-gate evidence that says which probe fired.
  "HARNESS_TAMPERED", "REF_TAMPERED", "TORCH_COMPUTE", "COMPILED",
])

/**
 * Read the verdict from a file, never from stdout.
 *
 * The solution runs in the same process as the grader, so it can print. If the
 * verdict came off stdout, a solution could register an `atexit` hook that
 * prints a fake `reward: 1.2` after the real one. The file is written by the
 * grader only, mode 600, and validated structurally here.
 */
export function readVerdict(file) {
  let v
  try {
    v = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (e) {
    return { ok: false, fatal: "GRADER_DID_NOT_ANSWER", detail: String(e.message || e) }
  }
  if (!v || typeof v !== "object" || !Array.isArray(v.gates) || v.gates.length === 0) {
    return { ok: false, fatal: "INVALID_VERDICT", detail: "missing/broken gates" }
  }
  if (typeof v.reward !== "number" || !Number.isFinite(v.reward) || v.reward < 0 || v.reward > 1.2) {
    return { ok: false, fatal: "INVALID_VERDICT", detail: `reward out of range: ${v.reward}` }
  }
  if (v.failure != null && !FAILURES.has(v.failure) && v.fatal == null) {
    // A class the harness grew after this plugin was written. Replacing the
    // whole verdict with INVALID_VERDICT is the wrong failure mode: `failure`
    // is already fail-closed, and `gates` is the only thing that explains it.
    // Keep the verdict, price it at zero, and name the class so the caller can
    // tell "the harness added a gate" from "the grader broke".
    v.unknown_failure = v.failure
    v.ok = false
    v.reward = 0
  }
  return v
}

export function gradeTask({ run, task, stage = "full", skipPerf = false, timeoutS } = {}) {
  const sol = path.join(task.repo, "solution.py")
  const outFile = path.join(task.env_dir, ".verdict.json")
  try { fs.unlinkSync(outFile) } catch {}
  const t0 = Date.now()
  let wallS = null
  try {
    wallS = readJson(path.join(task.task_dir, "task.json"))?.budget?.wall_s ?? null
  } catch {}
  // Anchor provenance matters: `memory` cannot be reached by the candidate,
  // `run.json` can (same uid), `none` means the old self-referential check.
  const live = run?.run_id ? RUN_ANCHORS.get(`${run.run_id}/${task.id}`) : null
  const anchor = live ?? task.spec_anchor ?? null
  const anchorOrigin = live ? "memory" : (task.spec_anchor ? "run.json" : "none")
  const r = sh(PATHS.python, [
    path.join(PATHS.harness, "pgv_grade.py"),
    "--task", task.task_dir,
    "--sol", sol,
    "--stage", stage,
    "--out", outFile,
    ...(anchor ? ["--expect-hash", anchor] : []),
    ...(skipPerf ? ["--skip-perf"] : []),
    ...(wallS ? ["--wall-s", String(wallS)] : []),
  ], { timeout: (timeoutS ?? 900) * 1000 })
  const verdict = readVerdict(outFile)
  if (verdict.fatal === "GRADER_DID_NOT_ANSWER") {
    verdict.exit = r.code
    verdict.stderr = (r.stderr || "").slice(-1500)
  }
  verdict.elapsed_s = verdict.elapsed_s ?? Number(((Date.now() - t0) / 1000).toFixed(2))
  verdict.anchor_origin = anchorOrigin
  verdict.anchor_base = run?.anchor_base ?? null
  return verdict
}

export function briefFor(task) {
  const readme = path.join(task.repo, "README.md")
  const body = exists(readme) ? fs.readFileSync(readme, "utf8") : ""
  return `# Task ${task.id} (${task.tier}, ${task.kind})

Workspace: ${task.repo}
Edit only \`solution.py\`. Run \`python3 check_local.py\` for local feedback.

${body}

## Machine feedback (the only verdict that counts)

Call the \`pgv_check\` tool (\`{"task_id": "${task.id}", "run": "${task.run_id ?? ""}"}\`)
after every meaningful change. It returns one JSON object with per-gate
pass/fail, the public and hidden pass counts, the measured speedup and a
\`failure\` class. A task is solved only when a **full-stage** check returns
\`failure: null\` and \`reward >= 0.6\`; \`stage: "equiv"\` / \`"smoke"\` are debug
shortcuts that skip the perf gate and never count as a solve.

Do not edit \`check_local.py\`, \`ref_public.py\` or \`task_public.json\`; the
grader ignores your copies and uses the originals.
`
}

function setStatus(run, task, patch, runRoot) {
  Object.assign(task, patch)
  saveRun(run, runRoot)
}

export function checkFor({ runId, taskId, stage = "full", runRoot = PATHS.runs } = {}) {
  const run = loadRun(runId, runRoot)
  const task = run.tasks.find((t) => t.id === taskId)
  if (!task) throw new Error(`run ${runId} has no task ${taskId}`)
  let maxEdits = null
  try { maxEdits = readJson(path.join(task.task_dir, "task.json"))?.budget?.max_edits ?? null } catch {}
  if (maxEdits != null && (task.attempts ?? 0) >= maxEdits) {
    return {
      run, task,
      verdict: { ok: false, failure: "BUDGET", reward: 0, gates: [{ gate: "budget", pass: false, error: `max_edits=${maxEdits} reached` }],
                 hint: "out of edit budget for this task", elapsed_s: 0 },
    }
  }
  const verdict = gradeTask({ run, task, stage })
  task.attempts = (task.attempts ?? 0) + 1
  if (stage === "full") {
    task.best_reward = Math.max(task.best_reward ?? 0, verdict.reward ?? 0)
    task.last_failure = verdict.failure ?? null
  }
  saveRun(run, runRoot)
  appendJsonl(path.join(run.dir, task.id, "attempts.jsonl"), {
    ts: new Date().toISOString(),
    attempt: task.attempts,
    stage,
    ok: verdict.ok,
    failure: verdict.failure,
    reward: verdict.reward,
    public_pass_rate: verdict.public_pass_rate,
    hidden_pass_rate: verdict.hidden_pass_rate,
    anchor_origin: verdict.anchor_origin ?? null,
    expect_hash_source: verdict.expect_hash_source ?? null,
    perf: verdict.perf ?? null,
  })
  return { run, task, verdict }
}

export function submitFor({ runId, taskId, evidence = "", runRoot = PATHS.runs } = {}) {
  const { run, task, verdict } = checkFor({ runId, taskId, stage: "full", runRoot })
  const solved = verdict.failure == null && (verdict.reward ?? 0) >= 0.6
  setStatus(run, task, {
    status: solved ? "done" : "pending",
    finished_at: solved ? new Date().toISOString() : null,
    ...(solved ? {} : { last_failure: verdict.failure }),
  }, runRoot)
  appendJsonl(path.join(run.dir, "results.jsonl"), {
    ts: new Date().toISOString(),
    task: task.id,
    tier: task.tier,
    solved,
    reward: verdict.reward,
    failure: verdict.failure,
    perf: verdict.perf ?? null,
    evidence: String(evidence).slice(0, 2000),
  })
  return { run, task, verdict, solved }
}

export function status({ runId, runRoot = PATHS.runs } = {}) {
  const run = loadRun(runId, runRoot)
  const byStatus = {}
  const byTier = {}
  for (const t of run.tasks) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
    const k = (byTier[t.tier] ??= { total: 0, done: 0, running: 0, pending: 0, best_reward: 0 })
    k.total++
    k[t.status] = (k[t.status] ?? 0) + 1
    k.best_reward = Math.max(k.best_reward, t.best_reward ?? 0)
  }
  const done = run.tasks.filter((t) => t.status === "done").length
  return {
    run_id: run.run_id,
    model: run.model,
    total: run.tasks.length,
    done,
    pass_rate: run.tasks.length ? done / run.tasks.length : 0,
    by_status: byStatus,
    by_tier: byTier,
    running: run.tasks.filter((t) => t.status === "running").map((t) => t.id),
    pending: run.tasks.filter((t) => t.status === "pending").map((t) => t.id),
  }
}

export function report({ runId, runRoot = PATHS.runs } = {}) {
  const run = loadRun(runId, runRoot)
  const st = status({ runId, runRoot })
  const rows = run.tasks
    .map((t) => {
      const reward = (t.best_reward ?? 0).toFixed(2)
      return `| ${t.id} | ${t.tier} | ${t.status} | ${reward} | ${t.attempts ?? 0} | ${t.last_failure ?? "-"} |`
    })
    .join("\n")
  const md = `# p2m-gpu-verifiable run ${run.run_id}

model: \`${run.model}\` · seed: \`${run.seed}\` · created: ${run.created}

pass rate: **${st.done}/${st.total}** (${(st.pass_rate * 100).toFixed(1)}%)

| task | tier | status | best reward | attempts | last failure |
|---|---|---|---|---|---|
${rows}

## per tier

| tier | total | done | running | pending |
|---|---|---|---|---|
${Object.entries(st.by_tier)
  .map(([k, v]) => `| ${k} | ${v.total} | ${v.done ?? 0} | ${v.running ?? 0} | ${v.pending ?? 0} |`)
  .join("\n")}
`
  const file = path.join(run.dir, "report.md")
  fs.writeFileSync(file, md, "utf8")
  return { file, markdown: md, summary: st }
}

// ---------------------------------------------------------------------------
// canary calibration: is the oracle actually able to reject bad solutions?
// ---------------------------------------------------------------------------

export function oracle({ runId, tasksDir = PATHS.tasks, runRoot = PATHS.runs } = {}) {
  const list = runId
    ? loadRun(runId, runRoot).tasks.map((t) => ({ id: t.id, task_dir: t.task_dir }))
    : listTasks(tasksDir).map((t) => ({ id: t.id, task_dir: t.dir }))
  const out = []
  for (const t of list) {
    const r = sh(PATHS.python, [path.join(PATHS.harness, "pgv_grade.py"),
      "--task", t.task_dir, "--sol", path.join(t.task_dir, "gold.py"), "--oracle"])
    let v
    try {
      v = JSON.parse(r.stdout.trim().split("\n").pop())
    } catch {
      v = { ok: false, error: (r.stderr || r.stdout).slice(-500) }
    }
    out.push({ id: t.id, power: v.power ?? null, canaries: v.canaries ?? null, gold: v.gold ?? null })
  }
  return {
    tasks: out,
    min_power: out.reduce((m, x) => Math.min(m, x.power ?? 0), 1),
    broken: out.filter((x) => (x.power ?? 0) < 1).map((x) => x.id),
  }
}

// ---------------------------------------------------------------------------
// decomposition contract (same shape as pab_split, but for kernels)
// ---------------------------------------------------------------------------

export const MISSION_FIELDS = ["goal", "inputs", "acceptance", "deliverable"]

export function validateMission(m, allowed = null) {
  const problems = []
  for (const f of MISSION_FIELDS) {
    if (!m[f] || String(m[f]).trim() === "") problems.push(`missing \`${f}\``)
  }
  const acc = String(m.acceptance ?? "")
  if (!/pgv_check/.test(acc) && !/check_local\.py/.test(acc) && !/pgv_grade\.py/.test(acc)) {
    problems.push("acceptance must name pgv_check / check_local.py / pgv_grade.py")
  }
  const text = JSON.stringify(m)
  if (/(find|locate|search).{0,20}(reference|solution|answer|spec\.py|hidden)/i.test(text)) {
    problems.push("mission asks to locate a hidden reference, which is forbidden")
  }
  if (allowed) {
    const imports = (m.imports ?? []).filter((x) => !allowed.includes(x))
    if (imports.length) problems.push(`imports not allowed: ${imports.join(", ")}`)
  }
  return problems
}

export function writeMissions({ runId, taskId, subtasks = [], runRoot = PATHS.runs }) {
  const run = loadRun(runId, runRoot)
  const task = run.tasks.find((t) => t.id === taskId)
  if (!task) throw new Error(`run ${runId} has no task ${taskId}`)
  const dir = path.join(run.dir, task.id, "missions")
  fs.mkdirSync(dir, { recursive: true })
  const accepted = []
  const rejected = []
  subtasks.slice(0, 16).forEach((m, i) => {
    const problems = validateMission(m)
    if (problems.length) {
      rejected.push({ index: i, problems })
      return
    }
    const id = `m${String(i + 1).padStart(2, "0")}`
    const body = `# mission ${id} — ${task.id}

goal: ${m.goal}

inputs: ${m.inputs}

deliverable: ${m.deliverable}

acceptance:
\`\`\`
${m.acceptance}
\`\`\`
${m.hint ? `\nhint: ${m.hint}\n` : ""}`
    fs.writeFileSync(path.join(dir, `${id}.md`), body, "utf8")
    accepted.push({
      id,
      file: path.join(dir, `${id}.md`),
      subagent: {
        prompt: `You are a child agent inside a verified GPU task.

${body}

Rules: work only inside ${task.repo}. Do not read anything outside it (in
particular nothing under tasks/ or harness/). When the acceptance command
prints a passing verdict, report the exact command output. If you cannot make
it pass, report the last error verbatim and stop.
`,
      },
    })
  })
  fs.writeFileSync(path.join(dir, "index.json"),
    JSON.stringify({ accepted: accepted.map((a) => a.id), rejected }, null, 2) + "\n", "utf8")
  return { task: task.id, accepted, rejected }
}

// ---------------------------------------------------------------------------
// lookup helpers used by the plugin (a sandboxed child only knows task_id)
// ---------------------------------------------------------------------------

export function allRuns(runRoot = PATHS.runs) {
  if (!exists(runRoot)) return []
  return fs
    .readdirSync(runRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && exists(path.join(runRoot, d.name, "run.json")))
    .map((d) => d.name)
    .sort()
    .reverse()
}

export function findTask(taskId, runId = "", runRoot = PATHS.runs) {
  const runs = runId ? [runId] : allRuns(runRoot)
  for (const id of runs) {
    const run = loadRun(id, runRoot)
    const task = run.tasks.find((t) => t.id === taskId)
    if (task) return { run, task }
  }
  return null
}

const HINTS = {
  SPEC_TAMPERED: "spec.py or task.json was modified. Restore the task; this is not solvable by editing the workspace.",
  FORBIDDEN: "the solution imports the reference or does file/subprocess IO. Remove it.",
  IMPORT: "solution.py must define solve(...) and import cleanly. Check the traceback.",
  SMOKE: "the very first public case is wrong. Get one case bit-exact before optimising.",
  MEMORY: "either an input was mutated in place, or a store ran past the end of a buffer. Add the store mask.",
  NONDET: "the same input twice gave different bits. Look for atomics without ordering, or uninitialised reads.",
  STATEFUL: "the same input twice gave the SAME wrong bits: the answer depends on how many times solve() has been called, not on its argument. Look for a cache, a counter, a one-shot flag or a fusion that only runs once.",
  EQUIV_PUBLIC: "some public case is wrong. Run python3 check_local.py for the per-case diff.",
  EQUIV_HIDDEN: "public passes but unseen shapes fail. Almost always a hardcoded size or a missing tail mask.",
  EQUIV_PUBLIC: "a case the task SHOWED you fails (pass_rate < 1). The visible contract is binding: this pays the progress band, not the 0.6 solve floor.",
  NO_KERNEL: "require_kernel: write a @triton.jit kernel, not a torch expression.",
  PERF: "this task has perf.hard=true: correctness is not enough, you must beat the target speedup.",
  EXTRA: "a task-specific semantic property failed (see verdict.gates[].checks). Matching one call is not enough; the property must hold across calls.",
  TIMEOUT: "out of budget. Narrow the search; stop polishing once check_local passes.",
  TORCH_COMPUTE: "this task forbids torch arithmetic inside solve (torch_math=forbid): the maths must be in the Triton kernel. torch is allowed only for allocation/metadata; the failing op is in verdict.gates[].error.",
  HARNESS_TAMPERED: "the solution patched the grader's own module (pgv_core). That is a hard fail, not a bug report: remove the sys.modules/pgv_core patching.",
  REF_TAMPERED: "the solution reached the reference implementation (rebinding, gc walking, re-importing). Solve the task instead of calling the oracle.",
  COMPILED: "torch.compile inside solve. Dynamo rewrites torch.manual_seed while compiling, and the judge cannot tell that apart from an oracle rebind, so it fails closed. Remove the torch.compile call; eager torch is fine where the task allows it.",
}

export function hintFor(v) {
  const known = HINTS[v?.failure] ?? (v?.fatal ? HINTS[v.fatal] ?? null : null)
  if (known) return known
  if (v?.unknown_failure) {
    return `the harness reported a failure class this plugin does not know (${v.unknown_failure}); `
      + "the gates below still say which check fired - believe them, not this message."
  }
  return null
}

export function compactVerdict(v) {
  return {
    ok: Boolean(v.ok),
    failure: v.failure ?? v.fatal ?? null,
    ...(v.unknown_failure ? { unknown_failure: v.unknown_failure } : {}),
    reward: v.reward ?? 0,
    public: `${v.public_pass_rate ?? 0}`,
    hidden: `${v.hidden_pass_rate ?? 0}`,
    gates: (v.gates ?? []).map((g) => ({
      gate: g.gate, pass: g.pass,
      ...(g.error ? { error: g.error } : {}),
      ...(g.passed != null ? { passed: g.passed, total: g.total } : {}),
      ...(g.failures ? { failures: g.failures } : {}),
    })),
    perf: v.perf ?? null,
    hint: hintFor(v),
    elapsed_s: v.elapsed_s,
  }
}


// ---------------------------------------------------------------------------
// launching a real agent into a materialised workspace
// ---------------------------------------------------------------------------

export function launchTask({
  runId, taskId, timeoutS = 900, runRoot = PATHS.runs, model = "",
} = {}) {
  const run = loadRun(runId, runRoot)
  const task = run.tasks.find((t) => t.id === taskId)
  if (!task) throw new Error(`run ${runId} has no task ${taskId}`)
  const brief = briefFor({ ...task, run_id: runId })
  const jsonl = path.join(task.env_dir, "agent.jsonl")
  const errlog = path.join(task.env_dir, "agent.err.log")
  const out = fs.openSync(jsonl, "w")
  const err = fs.openSync(errlog, "w")
  const child = spawn(
    PATHS.opencode,
    ["run", "--standalone", "--auto", "--agent", AGENT_ID,
     "--model", model || run.model, "--format", "json", brief],
    {
      cwd: task.repo,
      detached: true,
      stdio: ["ignore", out, err],
      env: {
        ...process.env,
        PWD: task.repo,
        PGV_RUN: runId,
        PGV_TASK: task.id,
        PGV_ENV_DIR: task.env_dir,
      },
    },
  )
  fs.closeSync(out)
  fs.closeSync(err)
  task.status = "running"
  task.started_at = new Date().toISOString()
  saveRun(run, runRoot)
  return { run_id: runId, task: task.id, pid: child.pid, jsonl, errlog, timeout_s: timeoutS, child }
}

export function waitFor(child, timeoutS) {
  return new Promise((resolve) => {
    let done = false
    const finish = (why) => {
      if (done) return
      done = true
      resolve(why)
    }
    child.on("exit", (code) => finish(`exit:${code}`))
    child.on("error", (e) => finish(`error:${e.message}`))
    setTimeout(() => {
      if (!done) {
        try { process.kill(-child.pid, "SIGTERM") } catch {}
        setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 10_000).unref?.()
        finish("timeout")
      }
    }, timeoutS * 1000).unref?.()
  })
}

export async function execRun({ runId, timeoutS = 900, runRoot = PATHS.runs, onTask = null } = {}) {
  const results = []
  for (;;) {
    const { task } = claimNext(runId, runRoot)
    if (!task) break
    const { child, jsonl } = launchTask({ runId, taskId: task.id, timeoutS, runRoot })
    const why = await waitFor(child, timeoutS)
    // the agent may have called pgv_submit itself; do not double-record it
    const after = loadRun(runId, runRoot).tasks.find((t) => t.id === task.id)
    if (after && after.status === "done") {
      results.push({ task: task.id, why, solved: true, reward: after.best_reward,
                     failure: null, jsonl, graded_by: "agent" })
      if (onTask) onTask(results[results.length - 1])
      continue
    }
    const res = submitFor({ runId, taskId: task.id, evidence: `agent ${why}`, runRoot })
    results.push({ task: task.id, why, solved: res.solved, reward: res.verdict.reward,
                   failure: res.verdict.failure, jsonl, graded_by: "harness" })
    if (onTask) onTask(results[results.length - 1])
  }
  return results
}
