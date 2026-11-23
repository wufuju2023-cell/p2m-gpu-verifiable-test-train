import { Plugin } from "@opencode/plugin"

import {
  MODEL,
  PATHS,
  checkFor,
  claimNext,
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
  briefFor,
} from "./core.mjs"

/**
 * p2m-gpu-verifiable-test-train — the "agent-vs-machine" harness for GPU work.
 *
 * Same shape as p2m-agent-bench, but the artifact is a kernel/training step
 * instead of a Lean proof, and the verdict is a gate stack (spec hash, memory,
 * determinism, exact equivalence, hidden shapes, measured speedup) instead of
 * `lake env lean`.
 *
 * The heavy lifting lives in `core.mjs` so `cli.mjs` can drive the same code
 * out of process.
 */

type Options = {
  runRoot?: string
  tasksDir?: string
  timeoutS?: number
}

function json(value: unknown): { content: string } {
  return { content: JSON.stringify(value) }
}

function fail(error: unknown): { content: string } {
  const message = error instanceof Error ? error.message : String(error)
  return json({ ok: false, error: message })
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export default Plugin.define({
  id: "p2m-gpu-verifiable-test-train",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const runRoot = str(options.runRoot) || PATHS.runs
    const tasksDir = str(options.tasksDir) || PATHS.tasks
    const defaultTimeout = Number(options.timeoutS ?? 900)

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "pgv",
        description:
          "p2m-gpu-verifiable-test-train: sample verified GPU/training tasks, materialise blind workspaces, grade a kernel with a gate stack.",
      })

      editor.add({
        name: "tasks",
        description:
          "List the installed task packages (id, tier, kind, policy, perf target, whether a kernel is required). Use it before pgv_run.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "pgv", permission: "pgv_tasks", codemode: false },
        execute: async () => {
          try {
            return json({
              ok: true,
              tasks: listTasks(tasksDir).map((t) => ({
                id: t.id, tier: t.tier, kind: t.kind, title: t.title,
                policy: t.policy, require_kernel: t.require_kernel,
                perf: t.perf, cases: { public: t.n_public, hidden: t.n_hidden },
              })),
            })
          } catch (error) {
            return fail(error)
          }
        },
      })

      editor.add({
        name: "run",
        description:
          "Create a run: sample task packages (explicit `ids`, or `tiers` + `per_tier` seeded by `seed`), " +
          "materialise one blind workspace per task (public oracle only, hidden cases stay outside, " +
          "opencode.json with a path-scoped permission profile and the pgv-eval agent), and write run.json. " +
          "Returns the run id and the sampled ids.",
        input: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" }, description: "Explicit task ids (overrides tiers)." },
            tiers: { type: "array", items: { type: "string" }, description: 'Tiers, e.g. ["K0","K1","T1"].' },
            per_tier: { type: "integer", description: "Tasks per tier (default 2)." },
            seed: { type: "string", description: "Sampling seed (deterministic)." },
            model: { type: "string", description: `Defaults to ${MODEL}.` },
            timeout_s: { type: "integer", description: "Per-task wall clock (default 900)." },
            force: { type: "boolean", description: "Overwrite an existing run id." },
          },
          additionalProperties: false,
        },
        options: { namespace: "pgv", permission: "pgv_run", codemode: false },
        execute: async (input) => {
          try {
            const a = (input ?? {}) as Record<string, unknown>
            const res = createRun({
              ...(Array.isArray(a.ids) ? { ids: a.ids.map(String) } : {}),
              ...(Array.isArray(a.tiers) ? { tiers: a.tiers.map(String) } : {}),
              ...(typeof a.per_tier === "number" ? { perTier: a.per_tier } : {}),
              ...(typeof a.seed === "string" ? { seed: a.seed } : {}),
              ...(typeof a.model === "string" ? { model: a.model } : {}),
              ...(typeof a.timeout_s === "number" ? { timeoutS: a.timeout_s } : {}),
              ...(a.force === true ? { force: true } : {}),
              runRoot, tasksDir,
            })
            return json({
              ok: true, run_id: res.run_id, dir: res.dir, model: res.model,
              seed: res.seed, count: res.ids.length, ids: res.ids,
            })
          } catch (error) {
            return fail(error)
          }
        },
      })

      editor.add({
        name: "next",
        description:
          "Atomically claim the next pending task of a run and return its workspace path plus the exact brief " +
          "to hand to the agent. Concurrent-safe via an exclusive-create claim file.",
        input: {
          type: "object",
          properties: { run: { type: "string", description: "Run id from pgv_run." } },
          required: ["run"],
          additionalProperties: false,
        },
        options: { namespace: "pgv", permission: "pgv_next", codemode: false },
        execute: async (input) => {
          try {
            const { run, task } = claimNext(str((input as { run?: unknown })?.run), runRoot)
            if (!task) return json({ ok: true, run_id: run.run_id, task: null, reason: "no pending task" })
            return json({
              ok: true,
              run_id: run.run_id,
              task: {
                id: task.id, tier: task.tier, kind: task.kind,
                env_dir: task.env_dir, repo: task.repo,
                model: run.model, timeout_s: run.timeout_s,
              },
              brief: briefFor({ ...task, run_id: run.run_id }),
            })
          } catch (error) {
            return fail(error)
          }
        },
      })

      editor.add({
        name: "check",
        description:
          "Run the full gate stack on the current workspace in a subprocess and return the verdict: " +
          "spec_hash, forbidden, import, smoke, memory (guard-padded inputs), determinism, exact equivalence on " +
          "public and HIDDEN cases, kernel presence, and measured speedup. This is the only verdict that counts. " +
          "Never crashes the caller: a CUDA fault becomes a failure class.",
        input: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Task id, e.g. k0_vadd_i32." },
            run: { type: "string", description: "Run id (optional; searched across runs if omitted)." },
            stage: { type: "string", enum: ["full", "equiv", "smoke"], description: "Default full." },
          },
          required: ["task_id"],
          additionalProperties: false,
        },
        options: { namespace: "pgv", permission: "pgv_check", codemode: false },
        execute: async (input) => {
          try {
            const a = (input ?? {}) as Record<string, unknown>
            const runId = str(a.run) || String(process.env.PGV_RUN ?? "")
            if (!runId) return json({ ok: false, error: "run is required (or set PGV_RUN): a bare task_id could grade another run's workspace" })
            const hit = findTask(str(a.task_id), runId, runRoot)
            if (!hit) return json({ ok: false, error: `task ${a.task_id} not found in run ${runId}` })
            const res = checkFor({
              runId: hit.run.run_id,
              taskId: hit.task.id,
              stage: str(a.stage) || "full",
              runRoot,
            })
            return json({
              ok: true,
              run_id: hit.run.run_id,
              task_id: hit.task.id,
              attempts: res.task.attempts,
              best_reward: res.task.best_reward,
              verdict: compactVerdict(res.verdict),
            })
          } catch (error) {
            return fail(error)
          }
        },
      })

      editor.add({
        name: "submit",
        description:
          "Check and record the attempt. A task is solved only when every hard gate passes, the hidden cases " +
          "all pass, and reward >= 0.6. Marks the task done, appends to results.jsonl, and returns the verdict.",
        input: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Task id." },
            run: { type: "string", description: "Run id (optional)." },
            evidence: { type: "string", description: "Free-form note stored with the result." },
          },
          required: ["task_id"],
          additionalProperties: false,
        },
        options: { namespace: "pgv", permission: "pgv_submit", codemode: false },
        execute: async (input) => {
          try {
            const a = (input ?? {}) as Record<string, unknown>
            const runId = str(a.run) || String(process.env.PGV_RUN ?? "")
            if (!runId) return json({ ok: false, error: "run is required (or set PGV_RUN)" })
            const hit = findTask(str(a.task_id), runId, runRoot)
            if (!hit) return json({ ok: false, error: `task ${a.task_id} not found in run ${runId}` })
            const res = submitFor({
              runId: hit.run.run_id,
              taskId: hit.task.id,
              evidence: str(a.evidence),
              runRoot,
            })
            return json({
              ok: true,
              run_id: hit.run.run_id,
              task_id: hit.task.id,
              solved: res.solved,
              verdict: compactVerdict(res.verdict),
            })
          } catch (error) {
            return fail(error)
          }
        },
      })

      editor.add({
        name: "status",
        description: "Counts by status, pass rate and per-tier progress for one run. Compact JSON.",
        input: {
          type: "object",
          properties: { run: { type: "string", description: "Run id." } },
          required: ["run"],
          additionalProperties: false,
        },
        options: { namespace: "pgv", permission: "pgv_status", codemode: false },
        execute: async (input) => {
          try {
            return json({ ok: true, ...status({ runId: str((input as { run?: unknown })?.run), runRoot }) })
          } catch (error) {
            return fail(error)
          }
        },
      })

      editor.add({
        name: "report",
        description:
          "Write and return the Markdown capability table for a run (task, tier, status, best reward, attempts, " +
          "failure class) plus per-tier totals. Writes <run>/report.md.",
        input: {
          type: "object",
          properties: { run: { type: "string", description: "Run id." } },
          required: ["run"],
          additionalProperties: false,
        },
        options: { namespace: "pgv", permission: "pgv_report", codemode: false },
        execute: async (input) => {
          try {
            const res = report({ runId: str((input as { run?: unknown })?.run), runRoot })
            return json({ ok: true, file: res.file, summary: res.summary, markdown: res.markdown })
          } catch (error) {
            return fail(error)
          }
        },
      })

      editor.add({
        name: "oracle",
        description:
          "Calibrate the oracle: run every task's canaries (known-bad solutions) and confirm each is rejected, " +
          "then run gold.py and confirm it is accepted. `min_power` must be 1.0 before a tier is safe to train on.",
        input: {
          type: "object",
          properties: { run: { type: "string", description: "Limit to one run (optional)." } },
          additionalProperties: false,
        },
        options: { namespace: "pgv", permission: "pgv_oracle", codemode: false },
        execute: async (input) => {
          try {
            return json({ ok: true, ...oracle({ runId: str((input as { run?: unknown })?.run), tasksDir, runRoot }) })
          } catch (error) {
            return fail(error)
          }
        },
      })

      editor.add({
        name: "split",
        description:
          "Register child missions for a task. Each subtask is a CONTRACT with four required fields: " +
          "goal (one sentence), inputs (exact tensors/shapes/dtypes), acceptance (a command that runs " +
          "pgv_check/check_local.py), deliverable (the file + symbol). Rejected if a field is missing or the " +
          "text asks anyone to locate a hidden reference. Returns ready-to-paste subagent prompts.",
        input: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Task id (defaults to PGV_TASK)." },
            run: { type: "string", description: "Run id (defaults to PGV_RUN)." },
            subtasks: {
              type: "array",
              maxItems: 16,
              items: {
                type: "object",
                properties: {
                  goal: { type: "string" },
                  inputs: { type: "string" },
                  acceptance: { type: "string" },
                  deliverable: { type: "string" },
                  hint: { type: "string" },
                },
                required: ["goal", "inputs", "acceptance", "deliverable"],
                additionalProperties: false,
              },
            },
          },
          required: ["subtasks"],
          additionalProperties: false,
        },
        options: { namespace: "pgv", permission: "pgv_split", codemode: false },
        execute: async (input) => {
          try {
            const a = (input ?? {}) as Record<string, unknown>
            const taskId = str(a.task_id) || String(process.env.PGV_TASK ?? "")
            const runId = str(a.run) || String(process.env.PGV_RUN ?? "")
            if (!taskId) return json({ ok: false, error: "task_id required (or set PGV_TASK)" })
            const res = writeMissions({
              runId, taskId,
              subtasks: Array.isArray(a.subtasks) ? a.subtasks : [],
              runRoot,
            })
            return json({ ok: true, ...res })
          } catch (error) {
            return fail(error)
          }
        },
      })
    })

    console.log(
      `[p2m-gpu-verifiable-test-train] loaded · model=${MODEL} · tasks=${tasksDir} · runs=${runRoot} · timeout=${defaultTimeout}s`,
    )
    void loadRun
  },
})
