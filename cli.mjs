#!/usr/bin/env node
/**
 * CLI driver — same core the plugin tools call, usable from a plain shell.
 *
 *   node cli.mjs tasks
 *   node cli.mjs run    --tiers K0 --per-tier 1 --seed pilot-1
 *   node cli.mjs next   --run <run>
 *   node cli.mjs check  --task <id> [--run <run>] [--stage full|equiv|smoke]
 *   node cli.mjs submit --task <id> [--evidence "..."]
 *   node cli.mjs status --run <run>
 *   node cli.mjs report --run <run>
 *   node cli.mjs oracle [--run <run>]
 *   node cli.mjs split  --task <id> --goal "..." --inputs "..." \
 *                       --acceptance "python3 check_local.py" --deliverable "solution.py:solve"
 */

import fs from "node:fs"
import path from "node:path"

import {
  PATHS,
  checkFor,
  claimNext,
  execRun,
  compactVerdict,
  createRun,
  findTask,
  listTasks,
  loadRun,
  oracle,
  report,
  status,
  submitFor,
  writeMissions,
} from "./core.mjs"

function flag(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith("--") ? v : true
}

function multi(name, { comma = false } = {}) {
  const out = []
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) {
      const v = String(process.argv[i + 1])
      out.push(...(comma ? v.split(",").filter(Boolean) : [v]))
    }
  }
  return out
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n")
}

const cmd = process.argv[2]

try {
  switch (cmd) {
    case "tasks":
      out({ ok: true, tasks: listTasks(PATHS.tasks) })
      break

    case "run": {
      const tiers = multi("tiers", { comma: true })
      const ids = multi("ids", { comma: true })
      const res = createRun({
        ...(ids.length ? { ids } : {}),
        ...(tiers.length ? { tiers } : {}),
        perTier: Number(flag("per-tier", 2)),
        seed: String(flag("seed", "pgv-1")),
        ...(flag("model") ? { model: String(flag("model")) } : {}),
        force: Boolean(flag("force", false)),
      })
      out({ ok: true, run_id: res.run_id, dir: res.dir, ids: res.ids, count: res.ids.length })
      break
    }

    case "next": {
      const { run, task } = claimNext(String(flag("run")))
      out(task
        ? { ok: true, run_id: run.run_id, task: { id: task.id, tier: task.tier, repo: task.repo } }
        : { ok: true, run_id: run.run_id, task: null })
      break
    }

    case "check": {
      const hit = findTask(String(flag("task")), String(flag("run", "")))
      if (!hit) throw new Error("task not found")
      const res = checkFor({ runId: hit.run.run_id, taskId: hit.task.id, stage: String(flag("stage", "full")) })
      out({ ok: true, run_id: hit.run.run_id, task_id: hit.task.id, verdict: compactVerdict(res.verdict) })
      break
    }

    case "submit": {
      const hit = findTask(String(flag("task")), String(flag("run", "")))
      if (!hit) throw new Error("task not found")
      const res = submitFor({
        runId: hit.run.run_id,
        taskId: hit.task.id,
        evidence: String(flag("evidence", "")),
      })
      out({ ok: true, solved: res.solved, verdict: compactVerdict(res.verdict) })
      break
    }

    case "status":
      out({ ok: true, ...status({ runId: String(flag("run")) }) })
      break

    case "report": {
      const res = report({ runId: String(flag("run")) })
      out({ ok: true, file: res.file, summary: res.summary })
      break
    }

    case "oracle":
      out({ ok: true, ...oracle({ runId: String(flag("run", "")) }) })
      break

    case "exec": {
      const res = await execRun({
        runId: String(flag("run")),
        timeoutS: Number(flag("timeout", 900)),
        onTask: (r) => process.stderr.write(`[exec] ${r.task} ${r.why} solved=${r.solved} reward=${r.reward} failure=${r.failure}\n`),
      })
      out({ ok: true, results: res })
      break
    }

    case "split": {
      const goals = multi("goal")
      const inputs = multi("inputs")
      const acc = multi("acceptance")
      const del = multi("deliverable")
      const subtasks = goals.map((g, i) => ({
        goal: g, inputs: inputs[i], acceptance: acc[i], deliverable: del[i],
      }))
      out({ ok: true, ...writeMissions({ runId: String(flag("run")), taskId: String(flag("task")), subtasks }) })
      break
    }

    default:
      process.stderr.write(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 16).join("\n") + "\n")
      process.exit(2)
  }
} catch (e) {
  out({ ok: false, error: e instanceof Error ? e.message : String(e) })
  process.exit(1)
}
void path
void loadRun
