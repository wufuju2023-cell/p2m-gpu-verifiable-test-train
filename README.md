# p2m-gpu-verifiable-test-train

OpenCode 插件。把「GPU kernel / 训练步」题目变成可判定的 RLVR 环境：agent 在盲工作区里
改 `solution.py`，插件用一套 gate 判定它是否真的解决了任务。

结构与 `p2m-agent-bench` 同构（`index.ts` 注册工具，`core.mjs` 放引擎，`cli.mjs` 脱离
会话驱动），区别是判定器从 `lake env lean` 换成了 8 道 gate。

## 工具

| 工具 | 作用 |
|---|---|
| `pgv_tasks` | 列出已安装的题（tier / policy / perf / 是否需要 kernel） |
| `pgv_run` | 造 run：按 `ids` 或 `tiers`+`per_tier` 抽样，每题 materialise 一个盲工作区 |
| `pgv_next` | 原子领取下一题，返回工作区路径与 brief |
| `pgv_check` | **核心**。子进程跑完整 gate 栈，返回逐 gate 判决 + 通过率 + 加速比 + hint |
| `pgv_submit` | 判分并记录；`failure == null && reward >= 0.6` 才算 solved |
| `pgv_status` | 按状态 / 按 tier 的计数与通过率 |
| `pgv_report` | 生成 `<run>/report.md` 能力表 |
| `pgv_oracle` | 跑全部 canary，返回 `min_power`（必须 1.0 才能训练） |
| `pgv_split` | 登记子任务（4 字段契约），返回可直接投喂 `subagent` 的 prompt |

`pgv_check` 是唯一决定分数的东西。它**不会**因为候选解把 CUDA 搞崩而带走调用方——
`pgv_grade.py` 永远在子进程里跑。

## CLI

```bash
node cli.mjs tasks
node cli.mjs run    --tiers K0 --per-tier 1 --seed demo
node cli.mjs next   --run <run>
node cli.mjs check  --task <id> [--run <run>] [--stage full|equiv|smoke]
node cli.mjs submit --task <id> [--evidence "..."]
node cli.mjs exec   --run <run> --timeout 600     # 起真实 agent，逐题跑完并判分
node cli.mjs status --run <run>
node cli.mjs report --run <run>
node cli.mjs oracle [--run <run>]
```

## 自测

```bash
node selftest.mjs --tasks k0_vadd_i32
```

断言：工作区不含隐藏材料 → gold 通过 → 每个 canary 被拒 → stub 被拒 → 记账正确。
这是改判定器之后必须先跑的东西。

## gate 栈

```
spec_hash  forbidden  import  smoke  memory  determinism
equiv_public  equiv_hidden  kernel_required  perf
```

详见仓库根目录 `docs/DESIGN.md` 与 `docs/THREAT_MODEL.md`。

## 奖励

```
hidden 未全过: 0.15 * (0.5*public + 0.5*hidden)
hidden 全过:   0.6 + 0.4*clamp(log2(speedup)/log2(target), 0, 1) [+0.2 证书]
```

## 部署

插件由 OpenCode 从 `~/.opencode2/plugins/` 自动发现。本仓库是源，部署是：

```bash
cp -r plugin/p2m-gpu-verifiable-test-train/. ~/.opencode2/plugins/p2m-gpu-verifiable-test-train/
```
