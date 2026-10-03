# 模板运行的全局预算（接取条目：`command-template/docs/BACKLOG.md`「模板运行的全局预算」）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给一次模板运行加**总预算**，并把今天隐含的最坏上界显式化：缺省 `totalTimeoutMs = maxSteps × stepTimeoutMs`（12 × 600 s = 2 h，与现状等价），可用配置收紧；预算耗尽 → 稳定错误码 `run_timeout`（附已用 / 预算 ms 与已完成步骤）。`README` 同步口径。

## 调研

- 现状：`steps.ts` 只有每步上限与步骤数上限——`RunTemplateOptions` 的 `maxSteps`（缺省 12）与 `stepTimeoutMs`（缺省 600000，未物化：`undefined` 时由 `subagent.ts:97` 用 600_000）；`runAgent` 候选并行与裁判步共用同一 `stepTimeoutMs`（`steps.ts:98-114,170-175`）。
- 上界：`README.md:73-74` 已写明「最坏耗时 = maxSteps(12) × stepTimeoutMs(600 s) ≈ 2 h 才回终态（无全局预算）」；`bestOf` 并行 + `judge` 会让单步最坏 ≈ 2 × stepTimeoutMs，故显式总预算有真实约束力。
- 落点：`src/main.ts`（`Config` 透传，现有 `maxSteps` / `maxBestOf` / `stepTimeoutMs` 同一模式）、`src/steps.ts`（执行）、`src/types.ts`（`CommandTemplateConfig` / `TemplateErrorCode`）+ 测试 + README。
- 测试替身：`tests/template.test.ts:147-174` `fakeDeps()`（`runAgent` 可覆盖）；现有 `runTemplate` 用例在 `:186-273`。

## 决策（待审阅）

1. `types.ts`：`TemplateErrorCode` 增 `run_timeout`；`CommandTemplateConfig` 增 `totalTimeoutMs?: number`（文档：缺省 = `maxSteps × stepTimeoutMs`）。
1. `steps.ts`：`RunTemplateOptions` 增 `totalTimeoutMs?`；起点记 `deadline = now + (totalTimeoutMs ?? maxSteps × stepTimeoutMs)`（`maxSteps` / `stepTimeoutMs` 均在本地物化其缺省）；每个 **agent** 步骤前检查剩余预算，`≤0` → `run_timeout`（保留 `collected` 步骤）；每次 `runAgent` 的有效 `timeoutMs = min(stepTimeoutMs, 剩余)`（候选与裁判共用）；`prompt` 步骤不耗预算、不检查（零耗时）。
1. `main.ts`：把 `config.totalTimeoutMs` 按既有省略模式透传给 `runTemplate`。
1. README：配置表增行；「终态与回收」段把「无全局预算」改为「总预算缺省 = 公式，可用 `totalTimeoutMs` 收紧；超限 → `run_timeout`」。
1. 口径取舍（不新增运行时校验，沿用本包「配置原样透传」约定）：`totalTimeoutMs` 非正 / 非有限数 → 视为未设、回落缺省公式。
1. 不做：不改 `subagent.ts`（超时执行仍由它承担）；不动取消 / 回收竞速路径；不设固定默认值（缺省即公式，行为与今天等价）。

## 规划

- 计划改动文件清单（**只改这些**）：`command-template/docs/BACKLOG.md`（状态）、本追踪文档、`command-template/src/{steps,types,main}.ts`、`command-template/tests/template.test.ts`、`command-template/README.md`。
- 验证：`command-template` 包 `check` / `build` / `test`；撤修复必红（去掉预算检查 → `run_timeout` 用例红）；根 `npm run check`。
- 明确不做：不动其它包；不顺手改相邻代码。

## 实现记录（2026-10-04）

- 子代理只读审阅（决策后、实现前）：通过；修订——① 口径校正：缺省 = 公式是**名义上界**（普通步成功耗时 ≤ `stepTimeoutMs` ⇒ 缺省下几乎不可能触发；随包 5 模板最多 4 步），README 不写「与现状等价」承诺，且原 2 h 算术低估（`bestOf` 并行 + `judge` 让单步最坏 ≈ `2 × stepTimeoutMs`）；② 阻断项：`min(stepTimeoutMs, 剩余)` 若得 ≤0 会让宿主立即 abort 并把预算超时**伪装**成「步骤超时（N ms）」→ `step_failed`——改为「剩余 ≤ 0 先闸门 + 失败且已过 deadline → 归因 `run_timeout`」；③ 「保留 steps」对 `/playbook` 用户不可见（`main.ts` 只用 code / error）→ 已完成步摘要写进错误文案；④ `stepTimeoutMs` 缺省物化（显式传 600000）与不传逐字节等价（`subagent.ts:97`），测试替身与取消路径不受影响；⑤ 非正 / 非有限预算 = 不设（显式 `Infinity` 分支，不依赖 NaN 比较）；⑥ `cordis.patch.yml` **不加** `totalTimeoutMs`（保持预算随 `stepTimeoutMs` 缩放；随包生效值 7200000 写进 README）。
- 代码：`types.ts`（`run_timeout` + Config 字段 + `RunOutcome.steps` / `StepDeps.runAgent` 注释）、`steps.ts`（预算闸门 + 有效超时 + 归因 + 文案）、`main.ts`（透传）。
- 未做：不改 `subagent.ts`、不动取消 / 回收竞速（审阅同意）；服务面 `totalTimeoutMs` 透传不单独测（先例：`maxSteps` / `maxBestOf` / `stepTimeoutMs` 同样只在 steps 层测）。

## 测试与证据

- `command-template` 包 `check` / `build`：exit 0；`npm test`：22 pass / 0 fail（新增 3 条：预算耗尽 → `run_timeout` + 步骤保留 + 文案、有效超时 = min、预算窗口内失败归因；`fakeDeps` 增记 `timeoutMs`）。
- 反向验证（撤修复必红）：撤闸门 + 撤 min + 撤归因 → 3 条新用例全红（19 pass / 3 fail）；恢复后复绿。
- 真机（环境限制未做，记账）：沙箱内 LLM 不可用，无法端到端跑含 agent 步的模板；验证 recipe——临时给 profile 的 command-template config 加 `totalTimeoutMs: 20000` → 跑 `/playbook code-review <file>` → 期望 `run_timeout` 文案含「已完成 N 步」与预算 / 已用 ms，且子会话被回收。单测已覆盖 `steps.ts` 全部分支与 `main.ts` 的三行透传模式。

## 收尾

- 回写：`command-template/README.md`（配置表 `totalTimeoutMs` 行、「终态与回收」段：启动闸门语义 / 名义上界 / `bestOf`+`judge` 2× / 随包有效值 7200000 ms；测试计数 22）。
- 新发现问题另立条目：`command-template/docs/BACKLOG.md`「小项三则」（候选全灭丢错误详情 / README 的 `SERVICE_FACE_METHODS` 守卫声称无实 / `/playbook show` 不显示预算）。
- 本文件移入 `command-template/docs/archived/`；`command-template/docs/BACKLOG.md` 清理所接条目（仅留未完成项）。
- 临时产物：无。
