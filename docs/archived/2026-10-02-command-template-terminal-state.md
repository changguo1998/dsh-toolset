# 命令模板的取消/超时终态（接取条目：`docs/BACKLOG.md`「命令模板的取消/超时终态」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`playbook` 命令（`command-template`）在**子代理死亡 / 取消 / 超时**时也可能返回终态，不再出现「命令悬挂」（无 `command/done`）；并保证子会话被**回收**。另外核清 `stepTimeoutMs`（缺省 600s）触发的 abort 是否真的中止子代理。

真机观察（2026-09-30 第三轮，用户并入本条目）：两笔 `code-review` 命令都**没有 `command/done`**，TUI 里两个子代理显示为不活动：`774a2cbc` 以 `flush on a closed handle` 结束（已死），`c57b192e` 停在第 23 步（无 `step/end`）。

## 调研（2026-10-02）

- **事件面**：`command/run` / `command/done` 是**宿主**命令框架的事件（`docs/host/DSH-CTX-API.md:63`；TUI 在 `TUI/src/app/adapter/dsh.ts:2193` 渲染）。命令 handler 返回即发 `command/done` —— 悬挂只能是**我们的 handler 没返回**。
- **调用链**：宿主命令 → `CommandTemplate.run()`（`main.ts:180-215`，**不抛**、错误转 `kind:"error"`）→ `runTemplate()`（`steps.ts`，逐步 `deps.runAgent`）→ `runOneShotAgent()`（`subagent.ts:82-133`）。
- **悬挂点**：`runOneShotAgent` 里 `await settleRun(run)`（`subagent.ts:124`）。宿主实现（`@deepseek-ai/dsh-subagent/lib/index.js:2720-2738`）＝ `await run.result` + `await run.dispose()`；子代理被杀（`flush on a closed handle`）时 `run.result` **可能永不落定** → `await` 永挂 → handler 不返回 → 无 `command/done` ✓ 与真机现象吻合。
- **超时/取消现状**：`subagent.ts:96-99` 用 `setTimeout(() => controller.abort(), timeoutMs)`（缺省 600s），`fuseSignals` 合并调用方 signal，并把合并后的 signal 传给宿主 `start` 请求 —— **parse 层面通了，但我们自己仍在无界地 await `settleRun`**：abort 只传给宿主，指挥不动我们的 await。故「超时/取消后命令仍悬挂」可解释，且「abort 是否真中止了子代理」在**我们的代码里没有任何确认点**。
- **回收面**：正常路径的 dispose 由宿主 `settleRun` 内部完成；abort/竞速路径若绕过 `settleRun`，**必须自己 dispose**（否则子会话不回收）。
- **既有测试**：`tests/subagent.test.ts` 已有 `loadHostModule` 注入替身（假 `subagents` + 假 `settleRun`）✓ 可直接扩悬挂/超时/取消用例。

## 决策

- **D1（终态保证，审阅后收紧）**：`start.call(...)` 与「等宿主结算 `settleRun(run)`」**都在** abort 信号竞速内（`raceAbort`）。abort 赢 → 抛可读错误（区分「调用方取消」与「超时」），`steps.ts` 转 `step_failed` → `run()` 返回 `kind:"error"`。**限定语**：保证的是**本仓侧**终态——宿主 `command/done` 由宿主命令框架在 handler 返回后写，且宿主自身也能因 append 失败丢 `done`（本仓改不到）。
- **D2（回收，审阅后修正）**：abort 路径**发起但不等待** `run.dispose()`（fire-and-forget，失败静默）。**原因（审阅实测）**：真机 provider 是 in-process `spawn`，其 `dispose()` 内部 `Promise.allSettled([handle.dispose(), result])`，而 `handle.dispose()` 还 `await machine.whenIdle()` —— **`result` 不落定 ⇒ `dispose` 也不落定**；原「await dispose 作兜底」等于把无界等待换个地方（审阅复现 `[host] HUNG (601ms)`）。正常路径的回收仍归宿主 `settleRun`。
- **D3（悬挂 promise 不炸进程）**：给 `settleRun` 的 promise 挂 no-op catch——竞速落败后它若迟到 reject，不能变成未处理拒绝（进程级告警）。
- **D4（超时语义）**：沿用**单个** `timeoutMs`（缺省 600s）setTimeout + `timedOut` 标志区分「超时」与「取消」；不新增配置项、不改 `stepTimeoutMs` 的外部语义。
- **D5（不做）**：不改 `steps.ts` / `main.ts` 结构（现有 `try/catch` + `kind:"error"` 已能转终态）；不加整条模板的全局超时（每步已界 + `maxSteps` 界步数）；不动宿主包；不改模板文件。
- **D6（验证，审阅后补强）**：单测 6 例：① 正常路径不重复 dispose；② `settleRun` 永挂 + 调用方取消 → 1s 内有界拒绝 + 文案含「被调用方取消（子会话 id）」+ 回收被发起；③ 同上走 `timeoutMs: 20` → 文案含「步骤超时（20 ms）后中止」；④ **宿主语义的 dispose（内部 `await result`）→ 仍必须有界**（P0-1 回归，本次核心）；⑤ `start` 悬挂 → 同样有界（P1-3 回归）；⑥ 中止后 `settleRun` 迟到 reject → 无未处理拒绝（等「已发生」的事实标志，不用固定时长）。
- **D8（真机验证口径，审阅后修正）**：TUI **没有取消命令的入口**（唯一 abort 在 `dispose()`；一次性子代理对 `interrupt` 是 no-op），且一旦 signal abort，宿主 `withAbort` 自己就会写 `command/done`——**真机无法把本仓竞速与宿主行为区分开**。因此真机判据改为「错误文案是否为本仓新增（被调用方取消 / 步骤超时）+ 子代理是否真的停（`/agents` running→inactive、子会话末事件）」；本机取消路径需另开 TUI 条目或临时脚本直接 `controller.abort()`。
- **D9（归因降级，审阅后修正）**：把「被杀 ⇒ result 永不落定」**降级为假设**。审阅证据：① `/new` 真机报的 `子代理未正常结束（killed）` 恰说明 result 已落定（`killed` 来自 `runOutcome` 的 aborted 映射）；② `flush on a closed handle` 是 session-persistence 的 teardown drain 文案，更像进程/会话被拆；③ 审阅解压本机 `~/.dsh/sessions` 全部日志：**无任何 playbook 的 `command/run`**，`774a2cbc` / `c57b192e` 会话目录不存在 → 原真机证据已不可复验；④ 真正可能无界的 await 在 step 内（agent-loop 只在工具落定/流 chunk 之间查 abort）。已确认的只有一件事：**宿主结算面可能无界**。
- **D7（文档）**：`command-template/README.md` 的边界/子代理节补「终态与回收」口径；模块 `docs/BACKLOG.md` 若已有相关条目则关闭或改写。

## 计划改动文件清单

- `command-template/src/subagent.ts`（竞速 + 回收 + 超时/取消文案）
- `command-template/tests/subagent.test.ts`（四例）
- `command-template/README.md`（终态/回收口径）
- `docs/BACKLOG.md`（开工标「进行中」→ 关闭时清理）、本追踪文档

## 实现记录

| 文件 | 改动 |
|---|---|
| `command-template/src/subagent.ts` | ① `timeoutMs` 计时器改为「置 `timedOut` 标志 + abort」，新增 `abortReason()`（区分「子代理运行被调用方取消」/「子代理步骤超时（N ms）后中止」）；② 新增 `settleOrAbort(run, settleRun, signal, abortReason)`：`Promise.race([settleRun(run), abort])`，竞速落败给 `settle` 挂 no-op catch（迟到 reject 不炸进程），并删掉 abort 监听；③ 新增 `withReclaim(run, reason)`：竞速落败路径自行 best-effort `run.dispose()`，失败并入文案；④ 中止/结算失败两类错误统一附「（子会话 id）」 |
| `command-template/tests/subagent.test.ts` | 新增 4 例（17 例全绿）：调用方取消 + settle 永挂 → 有界（\<1s）拒绝 + 文案含「被调用方取消（子会话 child-hang）」+ dispose **恰好 1 次**；`timeoutMs: 20` → 文案含「步骤超时（20 ms）后中止」+ 回收 1 次；中止后 `settleRun` 迟到 reject → `unhandledRejection` 探针为空；正常路径 → 不重复 dispose（回收仍归宿主 `settleRun`） |
| `command-template/README.md` | 「边界」新增**终态与回收**一条（竞速原因 + 真机现象 + 两条文案 + 回收口径 + 与 `command/done` 的关系） |

## 测试与证据（2026-10-02）

- 包内：`npm run check` / `build` 通过；`npm run test` **17 例全绿**（改前 13 例）。
- **dist 级端到端（真宿主结算面 + 永挂子代理）**：用 `CommandTemplateService` + 一个临时模板（单 `agent` 步骤）+ 假 `subagents`（`run.result` 永不落定、`dispose` 计数）+ **真** `@deepseek-ai/dsh-subagent` 的 `settleRun`：
  - **修复前**（旧 dist）：`await svc.run("t", …)` **永不返回** —— Node 报 `Detected unsettled top-level await`，即真机「命令悬挂 / 无 `command/done`」的本相复现 ✓；
  - **修复后**（重建 dist）：耗时 **41 ms** 返回终态
    `{"kind":"error","text":"模板 t 执行失败（step_failed）：步骤 s1 失败：子代理步骤超时（40 ms）后中止（子会话 child-hang）"}`，回收计数 **1** ✓。
  - 结论：`stepTimeoutMs` 的 abort 现在**必然**把命令带回终态（本仓侧）；abort 是否真的让**宿主**中止子代理，由宿主按 signal 处理——我们的兜底是自行 `dispose` 回收（真机复核见残余）。
- 全仓：`npm run check` / `build` / `test` 见下方关闭前复跑结果。

## 审阅（子代理，2026-10-02，设计 + 已落地实现一并审）

**结论：不通过**（阻断项成立，已按证据修正）→ 1 项阻断 + 3 项中 + 2 项低 + 漏项全部处置：

| 审阅发现 | 处置 |
|---|---|
| 【阻断】竞速兜底自身无界：`await run.dispose()` 与 `await run.result` 同生共死（in-process provider 的 dispose 内部 `Promise.allSettled([handle.dispose(), result])`，`handle.dispose()` 还 `await machine.whenIdle()`）→ 目标「任何路径都回终态」不成立。审阅复现：`[host] HUNG (601ms)` vs `[naive] … (20ms)` | 采纳：abort 路径**不等** dispose（`reclaimInBackground`，fire-and-forget、失败静默）；竞速本体保留。**用审阅原复现验收**：`[host] 子代理运行被调用方取消（子会话 child-hang） (20ms)`、`[naive] … (20ms)` ✓（不再 HUNG） |
| 【严重】根因归因未证实且与自身证据冲突（killed 说明 result 已落定；`flush on a closed handle` 是 teardown 文案；本机已无 playbook 的 `command/run` 可复验） | 归因降级为假设（D9）；README 改为「已确认：宿主结算面可能无界 / 未确认：触发条件」 |
| 【中】D6 的真机验证做不到也无鉴别力（TUI 无取消命令入口；宿主 abort 自己就写 `command/done`） | D8 改口径（文案鉴别 + 子代理是否真停）；本机取消列为残余 |
| 【中】测试模型失真（fake `dispose` 立即 resolve，恰好漏掉真机形态） | 新增 ④ 宿主语义 dispose（内部 await result）→ 仍有界（核心回归）；⑤ `start` 悬挂 → 有界；⑥ 迟到 reject 改为等「已发生」标志；共 **19 例** |
| 【中】`start.call` 不在竞速内 → 发布期卡住仍无终态 | `raceAbort` 同时覆盖 `start` 与结算（`start` 悬挂时还没有 run 句柄，无可回收） |
| 【低】README 新条目插在「不实现执行器」与其续行之间，拆坏了该列表项 | 续行已粘回原条目 ✓ |
| 【低】`fuseSignals` 在外层 signal 上的 abort 监听从不摘除（每步累积）；`timedOut` 与调用方 abort 竞态会误标「超时」 | `fuseSignals` 返回 `dispose()` 并在 `finally` 摘监听；中止文案优先判 `options.signal?.aborted` |
| 【漏项】模块 `DESIGN.md` 不存在（AGENTS.md 模块文档口径含它），计划与 D7 未提 | 记入模块 BACKLOG #2（补或明确不建） |
| 【漏项】无全局预算的最坏代价未写（`maxSteps(12) × stepTimeoutMs(600s) ≈ 2 h`） | README 边界写明该上界；模块 BACKLOG #1 = 加运行级总预算 |
| 【漏项】宿主侧残留未写（`result` 永不落定 ⇒ `subagent/end` 永不发） | 写入 README 边界与 D9 |
| 【漏项】D7 措辞与实际不符（本条目在**项目级** BACKLOG，模块 BACKLOG 当时为空） | 关闭记录写明只动项目级 |

## 关闭记录

- 条目从 `docs/BACKLOG.md` §2 清理（**项目级**；模块 `command-template/docs/BACKLOG.md` 新增 2 条后续项）；其余条目重编（executor 隔离 → #1，STATUS 对齐 → #2）；§1 索引 / §2 顺序依据 / §3 里程碑同步。
- **残余**：① 会话内生效需重启 TUI（`command-template` 已在 fff 挂载，`dist` 已重建）；② 真机「取消」路径不可达（TUI 无取消命令入口）——需要时另开 TUI 条目或临时脚本驱动 `controller.abort()`；③ 宿主侧 `subagent/end` 等生命周期事件仍取决于 `run.result`（本仓补不了）；④ 模块 BACKLOG #1（运行级总预算）/ #2（DESIGN.md 取舍）。
- 本追踪文档移入 `docs/archived/`。
