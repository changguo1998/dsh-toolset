# 语义面接线（`audit` / `entail`）（接取条目：`task-engine/docs/BACKLOG.md` #1）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

插件形态目前只接 `runCommand` / `snapshotPath` / `maxConcurrent`：**semantic 级验收缺 `audit` hook → 一律 fail-closed**；**`entail` 语义蕴含门缺 hook → 整门跳过**。即「双重门禁」的语义半边与 semantic 验收在真机**不生效**。期望：用 `ctx.subagents` 跑独立裁决子代理（audit run / entail run）接上，并定 prompt 与 `outputSchema` 口径。

## 调研（2026-10-02）

- **既有接口（已就位，无需改契约）**：
  - `src/acceptance.ts:12-26` → `AuditVerdict { pass; feedback?; structured? }`、`AuditRequest { frame; check; result?; outputSchema? }`；`AcceptanceHooks.audit?(req)`（`:40`）；缺 hook 时 `judgeAcceptance` 返回 fail-closed（`:82-86`，文案 `SEMANTIC_NOT_IMPL`）；声明了 `outputSchema` 但裁决无 `structured` 时也打回（`:103`）。
  - `src/engine.ts:110-114` → `EntailHook = (parent: Frame, children: ChildSpec[]) => Promise<{ ok: boolean; feedback: string }>`；`:331-335` 未配置即跳过，配置后不通过则 `rejectFrame(parentId, "gate:entail", feedback)`。
- **宿主面**：`ctx.subagents`（服务面 `start(name, request)` + `settleRun`）已在 subagent executor 后端里跑通（含 `agentOptions` 能力位、`stopReason`、计量）；裁决子代理与执行子代理走**同一条**宿主路径即可（父会话 catalog + 生命周期事件）。
- **父 agent 从哪来**：hooks 在 `apply` 期构造（引擎单实例），但裁决需要父 agent 归属 → 参照既有 `makeApprove(exec)` / `makeExecutor(exec)` 的「按次执行」模式：工具层每次执行前把 `exec.agent` 记到「当前 agent」，hook 读它（缺失就不传 `parent`，运行可用、仅目录归属降级）。
- **本仓同类先例**：`command-template/src/subagent.ts` 的一次性子代理（`start` + `settleRun` + 超时/取消竞速 + 回收）——裁决 run 需要同样的**有界**语义（否则 gate 悬挂）。

## 决策

- **D1（复用执行面，审阅后订正）**：抽出 `runChildOnce(opts, req)` 供 executor / audit / entail 共用；它直接 `await run.result`（**不**用 `settleRun`——那是 `@deepseek-ai/dsh-subagent` 的模块导出，本包不引宿主依赖），并带**超时 abort 竞速 + fire-and-forget 回收**（executor 分支原先无界：`controller` 从不 abort、`dispose` 在 in-process 下内部还 await `result`）。裁决 run 用同一 `spawn` provider（**不用 `fork`**：fork 继承父上下文，会污染裁判独立性）。
- **D2（audit prompt 口径 §16.2）**：prompt 含 ① 验收项原文（`check`）② 被审产出（`result`，按既有 8000 字符截断口径）③ 输出契约：**只输出一个 JSON 对象** `{"pass": boolean, "feedback": string}`（声明了 `outputSchema` 时再加 `"structured"` 字段并附 schema 原文，要求严格符合）。解析：先剥 \`\`\` 围栏，再 `JSON.parse`；`pass` 必须是 boolean，否则失败。
- **D3（entail prompt 口径 §17.2）**：prompt 含父验收清单 + 每个子项的 `id/title/spec/acceptance`，要求只输出 `{"ok": boolean, "feedback": string}`——判「所有子项验收都通过时，父验收必然成立吗」。
- **D4（失败一律 fail-closed，不假通过）**：服务缺失 / 发起失败 / 超时 / 取消 / 输出不可解析 / 字段类型不对 → `audit` 返回 `{pass:false, feedback:"audit run 不可用：<原因>"}`、`entail` 返回 `{ok:false, feedback:"entail run 不可用：<原因>"}`，并 `warn()`。与既有 `SEMANTIC_NOT_IMPL` 的取向一致（宁打回不假通过）。
- **D5（开关与超时）**：Config 增 `semantic?: { audit?: boolean; entail?: boolean; timeoutMs?: number }`——缺省 `audit: true` / `entail: true` / `timeoutMs: 120_000`；显式 `false` 时回到旧行为（audit 不接 → fail-closed 文案不变；entail 不接 → 跳过）。**默认开启**是本条目的目的（让语义面真机生效），超时防 gate 悬挂。
- **D6（当前 agent 捕获）**：`ToolExecuteCtx` 增 `noteAgent?(exec)`，`tools.ts` 在每次工具执行前调用（与 `makeApprove(exec)` 同处）；`apply` 里维护 `currentAgent` 供两个 hook 作 `parent`（缺失则省略 `parent`，不 fail）。
- **D7（模型）**：裁决 run 不覆盖模型（随宿主默认，与 executor「未声明不传 `agentOptions`」同口径）；不新增模型配置。
- **D8（验证，审阅后订正）**：① 新增 `tests/semantic.test.ts`（经 `apply` 真接线 + 假宿主）：裁决 JSON 解析 4 形态、两个 prompt 口径、entail 通过 / 不通过 / 不可用→跳过 / 关开关、audit 通过（含父帧证据汇总）/ 不通过 / 不可解析→fail-closed / 关开关、**父帧无验收不跑 entail**；② 假宿主**镜像宿主对 `parent` 的必填解引用**（缺 `session` 即抛 TypeError）——这是本条致命缺陷的回归守卫；③ 全仓 `check` / `build` / `test` **+ `npm run smoke:executor`**（executor 面重接的回归面）。
- **D9（文档）**：README「边界与外包」改写为「语义面已接线（audit / entail 经裁决子代理；开关与超时见 Config；失败 fail-closed）」；模块 BACKLOG 关闭该条目；本追踪文档记证据。

## 计划改动文件清单

- `task-engine/src/main.ts`（`runChildOnce` 抽取 + 两个 hook + Config `semantic` + `currentAgent`/`noteAgent`）
- `task-engine/src/tools.ts`（`noteAgent` 调用点）
- `task-engine/src/acceptance.ts` / `src/engine.ts`（仅在需要时补注释；接口不变）
- `task-engine/tests/{subagent-audit,acceptance,engine}.test.ts`（新增/扩充）
- `task-engine/README.md`（边界与外包改写）
- `task-engine/docs/BACKLOG.md`（开工标「进行中」→ 关闭时清理）、本追踪文档

## 实现记录

| 文件 | 改动 |
|---|---|
| `task-engine/src/main.ts` | ① 新增 `runChildOnce(opts, req)`（`ctx.subagents.start` + 终态等待 + **超时 abort 竞速 + fire-and-forget 回收**；能力位 / 父 agent / 模型与预算覆盖；失败变体带 `session`/`stopReason` 供计量）与 `abortPromise` / `reclaimRun`；② subagent executor 分支**重接**到 `runChildOnce`（保留计量 / `overBudget` / 截断与失败路径标注）；③ 新增 `parseVerdictJson`（剥 \`\`\` 围栏 + 仅收对象）、`auditPrompt`（§16.2）、`entailPrompt`（§17.2）；④ `auditHook` / `entailHook`：裁决 run → 解析 → `AuditVerdict` / `{ok, feedback}`，**失败一律 fail-closed**；⑤ `apply` 增 `currentExec` + `resolveService` / `agentOf` + `noteAgent`，并按 Config `semantic` 接线（`audit` / `entail` 缺省开、`timeoutMs` 缺省 120s）；⑥ Config 增 `semantic{audit,entail,timeoutMs}` |
| `task-engine/src/engine.ts` | `audit()` 的证据由 `f.result` 改为 `evidenceFor(f)`：叶子用自身产出；**父帧汇总子帧结论**（`- id（title）：result`）——否则父帧的 semantic 验收「无产出可审」，语义门形同虚设（实现中发现） |
| `task-engine/src/tools.ts` | `ToolExecuteCtx` 增 `noteAgent?(exec)`；三个工具（decompose / stop / execute）在 `execute(args, exec)` 首行调用（承担裁决 run 的 agent 归属） |
| `task-engine/tests/semantic.test.ts`（新） | 10 例：`parseVerdictJson` 4 形态、`auditPrompt` / `entailPrompt` 口径、entail 通过 / 不通过 / 不可解析 / 缺服务 / 关开关、audit 通过（含**父帧证据汇总**断言）/ 不通过 / 关开关（回既有 fail-closed 文案） |

## 测试与证据（2026-10-02）

- 包内：`npm run check` exit 0、`npm run build` 通过、`npm run test` **82 例全绿**（改前 72 例；含 executor 面重接的回归）。
- 全仓：`npm run check` / `build` / `test` 见关闭前复跑。
- 真机（重启后跑一次带 semantic 验收的任务）记残余。

## 审阅（子代理，2026-10-02，设计 + 并行落地实现一并审）

**结论：不通过** → 2 项高 + 4 项中 + 3 项低 + 漏项，全部处置：

| 审阅发现 | 处置 |
|---|---|
| 【高】裁决 run 缺 `parent`：宿主 `SubagentStartRequest.parent` **必填**（无条件解引用 `parent.session`），而 `noteAgent` 只有 `task_execute` 调用 → 会话首拆即 `TypeError … reading 'session'`；单测因假 `start` 不校验 `parent` 而全绿 | 改**按次注入**：`semanticHooksFor(exec)` 在 tools 层构造（`decompose` / `stop` 把 `exec` 传下去），删除 `currentExec` / `noteAgent`；裁决 run `requireParent: true`；工程侧 `engine.decompose(..., entail?)` / `stop(..., {audit?})` 增按次参数（先例 `execute(frameId, runner)`）；**假宿主镜像宿主的 parent 必填解引用**；顺手修 `approveFor(undefined)` → `approveFor(exec)`（human 级此前丢 agent） |
| 【高】`structured` 假保证：自报形状错也判通过 | 裁决走**宿主 `outputSchema` 信封**（`verdictEnvelope`）+ `runChildOnce` 传 `outputSchema`（能力位检查；缺位视为声明问题 → `retryable: false`）+ 取 `result.structured`；`readVerdictValue` 优先宿主校验结果、缺用回退文本解析；`acceptance.ts` 注释同步 |
| 【中】`currentExec` 跨会话串线 | 随按次注入消除（无共享可变） |
| 【中】entail 不可用会烧重试预算（实测 3 次 → 整树 failed） | `EntailHook` 增 `skipped?: boolean`：不可用类失败 → 跳过该门 + 告警（不 rejectFrame）；模型明确 `{ok:false}` 才打回；父帧无验收不跑 |
| 【中】竞速 catch 吞 `result` reject 且误标「被取消」 | `runChildOnce` **三态**：超时 / 调用方取消（retryable false）/ `run.result` reject（retryable true，文案「子代理运行失败」） |
| 【中】解析器过窄（散文 + 围栏即失败） | `parseVerdictJson` 加**平衡括号扫描**回退 + 围栏大小写不敏感 |
| 【低】entail prompt 缺父 `title`/`spec` | 已补（§17.2「无漂移」判据需要） |
| 【低】verdict `feedback` 未截断入事件流 | 截断 500 |
| 【低】`evidenceFor` 汇总后整体 8000 头截断（子项多时尾部证据丢） | 记边界（未改） |
| 【漏项】README Config 表缺 `semantic`；DESIGN :15/:48 过期；`acceptance.ts` / `types.ts` 注释失效；文件清单 / D8 未同步落地事实；「后端自报 `structured` ≠ audit `structured`」；裁决子代理可见 `task_*` 工具（重入隐患） | README 表 + DESIGN + 注释已改；清单/D8 已订正；「后端 structured ≠ audit structured」与 `toolFilter` 记入残余与模块 BACKLOG #2 |

## 关闭记录

- 条目从 `task-engine/docs/BACKLOG.md` 清理；模块 BACKLOG 现存 #1 = 裁决子代理 `toolFilter`（重入边界）。
- **残余**：① 会话内生效需重启 TUI（dist 已重建，包已挂 fff）；② **真机**确认（重启后跑一次带 semantic 验收的任务，看 audit run 与 `plan/acceptance-verdict`）未做；③ entail 保持**默认开**（已加缺失降级与「父帧无验收跳过」；代价是每次 decompose 多一次裁决 run，可用 `semantic.entail=false` 关掉——审阅建议「先默认关」，此处按「让语义面生效」的条目目标保持开并记此权衡）；④ `evidenceFor` 的 8000 头截断；⑤ 「后端自报 `structured`（workflow `value`）≠ audit `structured`」尚未写进 README 边界。
- 本追踪文档移入 `task-engine/docs/archived/`。
