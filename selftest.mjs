#!/usr/bin/env node
/**
 * selftest.mjs — end-to-end proof that the harness is wired correctly, with no
 * LLM in the loop.
 *
 *   1. materialise a blind workspace for every task in --tasks (default: one)
 *   2. assert the workspace does NOT contain the hidden material
 *   3. copy gold.py in  -> must be solved
 *   4. copy a canary in -> must be rejected
 *   5. restore the stub -> must be rejected
 *
 * Exit 0 only if every assertion holds.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PATHS, checkFor, createRun, findTask, hintFor, readJson, readVerdict } from "./core.mjs"

const FAILS = []
const LINES = []

function ok(cond, msg) {
  LINES.push(`${cond ? "ok  " : "FAIL"}  ${msg}`)
  if (!cond) FAILS.push(msg)
}

function copy(src, dst) {
  fs.copyFileSync(src, dst)
}

/**
 * The verdict contract, checked without touching a GPU.
 *
 * A class the harness grows after this plugin was written used to replace the
 * whole verdict with INVALID_VERDICT -- real case: `TORCH_COMPUTE` came back
 * with 0 gates and no hint, so the agent was told the grader was broken
 * instead of which torch op it was not allowed to call.
 */
function verdictContract() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgv-verdict-"))
  const base = {
    ok: false, reward: 0, fatal: null,
    public_pass_rate: 1, hidden_pass_rate: 1,
    gates: [{ gate: "torch_math", pass: false, error: "torch math op mul_ used inside solve" }],
  }
  const write = (name, v) => {
    const f = path.join(dir, name)
    fs.writeFileSync(f, JSON.stringify(v))
    return readVerdict(f)
  }

  const known = write("known.json", { ...base, failure: "TORCH_COMPUTE" })
  ok(known.failure === "TORCH_COMPUTE", "verdict: known tamper class survives (not INVALID_VERDICT)")
  ok((known.gates ?? []).length === 1, "verdict: known tamper class keeps its gates")
  ok((hintFor(known) ?? "").includes("torch_math=forbid"), "verdict: TORCH_COMPUTE gets a hint")

  const unknown = write("unknown.json", { ...base, failure: "SOME_FUTURE_GATE" })
  ok(unknown.failure === "SOME_FUTURE_GATE", "verdict: unknown class is kept, not swallowed")
  ok(unknown.unknown_failure === "SOME_FUTURE_GATE", "verdict: unknown class is named")
  ok((unknown.reward ?? -1) === 0, "verdict: unknown class is fail-closed on reward")
  ok((unknown.gates ?? []).length === 1, "verdict: unknown class keeps its gates")

  const broken = write("broken.json", { ...base, gates: [] })
  ok(broken.fatal === "INVALID_VERDICT", "verdict: structurally broken verdict still rejected")

  fs.rmSync(dir, { recursive: true, force: true })
}

function main() {
  verdictContract()

  const wantIds = process.argv.includes("--tasks")
    ? process.argv[process.argv.indexOf("--tasks") + 1].split(",")
    : ["k0_vadd_i32"]

  for (const id of wantIds) {
    const taskDir = path.join(PATHS.tasks, id)
    if (!fs.existsSync(taskDir)) {
      ok(false, `${id}: task package missing`)
      continue
    }
    const meta = readJson(path.join(taskDir, "task.json"))
    let run
    try {
      run = createRun({ ids: [id], seed: `selftest-${id}-${Date.now()}`, force: true })
    } catch (e) {
      ok(false, `${id}: createRun failed: ${e.message}`)
      continue
    }
    const env = path.join(run.dir, id)
    const repo = path.join(env, "repo")

    // ---- blindness ------------------------------------------------------
    const leaks = ["spec.py", "canary", "gold.py", "secrets.json"]
      .filter((p) => fs.existsSync(path.join(repo, p)))
    ok(leaks.length === 0, `${id}: workspace is blind (leaked: ${leaks.join(",") || "none"})`)
    ok(fs.existsSync(path.join(env, "secrets.json")), `${id}: secrets.json written outside the repo`)

    const sol = path.join(repo, "solution.py")

    // ---- gold must pass -------------------------------------------------
    copy(path.join(taskDir, "gold.py"), sol)
    const gold = checkFor({ runId: run.run_id, taskId: id }).verdict
    ok(gold.failure == null, `${id}: gold accepted (failure=${gold.failure})`)
    ok((gold.reward ?? 0) >= 0.6, `${id}: gold reward ${gold.reward} >= 0.6`)
    const sp = gold.perf?.speedup
    LINES.push(`      gold: reward=${gold.reward} public=${gold.public_pass_rate} hidden=${gold.hidden_pass_rate} speedup=${sp ? sp.toFixed(2) : "n/a"}`)

    // ---- every canary must be rejected ----------------------------------
    const cdir = path.join(taskDir, "canary")
    const canaries = fs.existsSync(cdir) ? fs.readdirSync(cdir).filter((f) => f.endsWith(".py")) : []
    ok(canaries.length > 0, `${id}: has canaries (${canaries.length})`)
    for (const c of canaries) {
      copy(path.join(cdir, c), sol)
      const v = checkFor({ runId: run.run_id, taskId: id, stage: "equiv" }).verdict
      // Rejected is not enough: if the failure class is not in the plugin's
      // FAILURES set, `verdictOf` downgrades it to INVALID_VERDICT and the
      // agent loses the per-gate evidence. Assert the class is recognised.
      ok(v.ok === false && v.fatal !== "INVALID_VERDICT",
         `${id}: canary ${c} rejected (${v.failure ?? v.fatal ?? "ACCEPTED"})`)
    }

    // ---- stub must be rejected -----------------------------------------
    copy(path.join(taskDir, "workspace", "solution.py"), sol)
    const stub = checkFor({ runId: run.run_id, taskId: id, stage: "smoke" }).verdict
    ok(stub.ok === false, `${id}: stub rejected (${stub.failure ?? stub.fatal ?? "ACCEPTED"})`)

    // ---- the run bookkeeps correctly -----------------------------------
    const hit = findTask(id, run.run_id)
    ok(hit != null, `${id}: findTask resolves the run`)
    ok(hit.task.attempts >= canaries.length + 2, `${id}: attempts recorded (${hit.task.attempts})`)
    void meta
  }

  process.stdout.write(LINES.join("\n") + "\n")
  if (FAILS.length) {
    process.stdout.write(`\nSELFTEST FAIL (${FAILS.length})\n`)
    process.exit(1)
  }
  process.stdout.write(`\nSELFTEST PASS\n`)
}

main()
