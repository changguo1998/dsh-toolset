# 会话开局重复注入修复（去重读面纳入 inbox 待消费注入）（接取条目：`docs/BACKLOG.md`「新会话开局重复注入（符号指南与 ponytail 各多注入一次）」）

状态：关闭　　开启：2026-10-05　　关闭：2026-10-05
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按用户 2026-10-05 指示：

1. **修复真机缺陷**：开启新会话时，符号指南（`[符号规范]`）与 ponytail 阶梯被**重复注入**（`session-start` 一条 + 首个 `step-end` 又一条）。
1. `rule-engine` **不加注入段落上限**（`maxInjectionsPerTurn` 保持缺省 3；不走上一任务登记的「设为 4」方案）。
1. **BACKLOG 清理**：文档更新相关条目只保留项目级条目 1（全目录文档整理），其余（注入段数余量、ponytail 文档 sources / delivery 漂移）去掉。
1. **修复现在登记的所有代码问题**：本次范围内即上述重复注入；条目 3 的文档漂移随本次文档同步一并订正（不做「静默删条目」）。

## 调研（2026-10-05，证据取真机会话记录）

方法：解压当前会话记录 `~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/tui-09131f80-6faa-40d3-a19b-546bc9536ab9/session.v4.jsonl.zstd`，列出全部 `agent/inbox/spliced`（`source.kind === "rule-engine"`）与相邻边界事件，按 seq 对齐：

| seq | time（ms） | 事件 | 内容 |
| --- | --- | --- | --- |
| 6 | …672168 | inbox spliced | 注入 ①：3 段合并 1 条（skill-autoload + ponytail + 符号指南） |
| 17 | …676054 | step/end | 首个步边界（引擎在此判定去重） |
| 18 | …676055 | inbox spliced rm=1 | 注入 ① 被 claim（离开 next-step） |
| 19 | …676056 | inbox spliced | 注入 ②：2 段（ponytail + 符号指南）——重复 |
| 22 | …676061 | user/message | 注入 ① 进入可见投影 |

结论（根因）：

- `steer` / `inject` 注入先落 **inbox `next-step` 队列**，直到**下一个步边界**才被 claim 进会话（seq 18），随后才作为 user 消息进入可见投影（seq 22）。
- 引擎的 `step-end` 派发发生在同一步边界、且**早于 claim**（seq 17 < seq 18）。
- `dedupeInRecord` 只读**可见投影**（`sessions.get(id).deriveMessages()`）：此刻注入 ① 既不在投影、又无人读 inbox → 计数 0 → 符号指南与 ponytail 判定「没注入过」→ 注入 ②。
- skill-autoload 规则不挂 `step-end`，故重复的只有挂 `step-end` 兜底的符号指南与 ponytail；第二次之后注入 ① 已进投影，后续 `step-end` 判定命中、不再增长（本会话注入总数 = 2）。

旁证与宿主面依据：

- 上一会话（`tui-a665362e-…`，改造前）同模式：seq 6 开局注入、seq 19 步末再补一条指南。
- 宿主 `Session.deriveMessages()` 走 surface 节点（消息被 claim 前不投影）；`inbox` 投影由 `dsh-agent-loop` 注册（key `inbox`，状态 `{"next-turn": [...], "next-step": [...]}`，宿主持久重建），可经 `ctx.get('sessionProjections').stateOf(session, 'inbox')` 同步只读——仓库内先例：`task-engine` 读 `tokenUsage` 投影（`src/main.ts` 的 `resolve` + `stateOf`）。

## 决策

- **选定：去重读面 = 可见投影 + inbox 待消费注入**（`rule-engine/src/main.ts` 的 `sessionMessagesOf` 合并 `deriveMessages()` 与 inbox 投影里 `next-step` / `next-turn` 的消息）。
  理由：注入「已注入」的事实在其被消费前就已成立；inbox 投影是宿主的权威待投递状态、随会话日志持久重建（重启后仍准），不需要跨进程补偿的进程内账簿，也不依赖投递回调。
- **不选（备查）**：
  1. 提高 `maxInjectionsPerTurn`（用户明确不加）；
  1. 进程内「已写出未可见」账簿 + 投递失败回调（需改 `Injector` 接口与失败补偿；投递成功但消息被取消的边角会永久抑制补注入）；
  1. 去掉 `step-end` 兜底（会失去「`session-start` 时 agent 非 live、投递被跳过」的补注入路径）。
- **语义保持**：`dedupeInRecord` 仍是「记录里最多 N 条」；压缩把注入挤出记录后自然补回；读取失败一律 fail-open（照旧注入）；`session-start` 投递失败时 inbox 无该注入 → 首个 `step-end` 仍补注入。
- **不做**：不改 `maxInjectionsPerTurn`；不改消费者 `sources` / `delivery` / `directWrite` 缺省；不改 profile；不动 `docs/STATUS.md`。

## 规划

任务拆分：

1. `rule-engine/src/main.ts`：`sessionMessagesOf` 合并 inbox 待消费注入；新增 `ProjectionRegistryLike`（`ctx.get('sessionProjections')`）与 `pendingInboxMessages()`（防御读，异常 → 空数组，fail-open）。
1. `rule-engine/src/engine.ts`：注释口径（`messagesOf` / `dedupeInRecord` 判据 = 会话记录 = 可见投影 + 未消费 inbox）。
1. `rule-engine/tests/main.test.ts`：假 ctx 补 `sessions.get` / `ctx.get('sessionProjections')` / `agent.steer`；补回归用例（inbox 待消费 → 不重复注入；inbox 读不到 → 仍兜底注入）。
1. 文档同步：`rule-engine/README.md`、`rule-engine/docs/DESIGN.md`；符号指南侧口径（`symbol-normalizer/README.md`、`docs/DESIGN.md`、`src/guide.ts`、`src/main.ts`）；`ponytail/README.md` + `ponytail/docs/DESIGN.md`（订正 sources / delivery 漂移）。
1. `docs/BACKLOG.md`：新增本条目标〔进行中〕；移除条目 2 / 3（用户裁定）；收尾移除本条目。
1. 本追踪文档（收尾移入 `docs/archived/`）。

计划改动文件清单（**除此之外一律不改**）：

- `rule-engine/src/main.ts`
- `rule-engine/src/engine.ts`
- `rule-engine/src/types.ts`（实现中补入：`dedupeInRecord` / `directWrite` 的导出注释同口径）
- `rule-engine/src/tools.ts`（实现中补入：工具描述同口径）
- `rule-engine/tests/main.test.ts`
- `rule-engine/tests/engine.test.ts`（实现中补入：测试命名口径「投影判断」→「记录判断」）
- `rule-engine/README.md`
- `rule-engine/docs/DESIGN.md`
- `symbol-normalizer/src/main.ts`
- `symbol-normalizer/src/guide.ts`
- `symbol-normalizer/tests/main.test.ts`（实现中补入：注释口径）
- `symbol-normalizer/README.md`
- `symbol-normalizer/docs/DESIGN.md`
- `ponytail/README.md`
- `ponytail/docs/DESIGN.md`
- `docs/BACKLOG.md`
- `docs/implementation/2026-10-05-session-start-injection-dedup.md`（本文件）

## 实现记录

- `rule-engine/src/main.ts`：`sessionMessagesOf` 改为**会话记录读面** = `derivedMessagesOf(session)`（可见投影）+ `pendingInboxMessages(projections, session)`（inbox 投影的 `next-step` / `next-turn`）；新增 `ProjectionRegistryLike`（`ctx.get('sessionProjections')`，经 `readOptional` 读，缺席不影响加载）与两个私有读函数；读不到 / 抛错 → 空数组（fail-open），`sessions.get` 缺失时只退化为可见投影。
- `rule-engine/src/engine.ts`：文件头、`EngineOptions.messagesOf`、`#countInRecord`、`#collectRules` / `#collectConsumers` 的注释口径由「可见投影」改为「会话记录（可见投影 + 未消费 inbox，读面由接线层合成）」。
- `rule-engine/src/types.ts` / `src/tools.ts`：`dedupeInRecord` / `directWrite` 的注释与工具描述同步（「投影判断」→「记录判断」，计数面写明 inbox）。
- `rule-engine/tests/main.test.ts`：`fakeCtx` 扩展（`agent.steer`、`sessions.get` 的会话句柄、`ctx.get('sessionProjections')` 的假 inbox 投影，均为可变引用供测试模拟真机时序）；新增 2 例：
  1. **回归（真机竞态）**：session-start 注入后把消息放进 inbox 待消费 → 首个 `step/end` 不重复；claim 后（离开 inbox、进可见投影）仍不重复；记录清空 → `step-end` 兜底补一次；
  1. **fail-open / 来源过滤**：inbox 只有非本引擎消息不计入 → 兜底注入；`stateOf` 抛错不阻断 → 照旧注入。
- `rule-engine/tests/engine.test.ts`：两处测试命名口径「投影判断」→「记录判断」（引擎侧语义未变，输入即记录读面）。
- 文档同步：`rule-engine/README.md`（`dedupeInRecord` / `directWrite` 表行、「时序约束」补 inbox/claim 说明、已知限制行）；`rule-engine/docs/DESIGN.md`（§6 两条 + §10）；`symbol-normalizer` 四处（README、DESIGN、`src/guide.ts`、`src/main.ts` 注释）与测试注释；`ponytail/README.md`（注入时点、config 示例三行、契约行 `delivery`）、`ponytail/docs/DESIGN.md` 两条取舍——一并**订正 BACKLOG 条目 3 的 sources / delivery 漂移**（示例改为代码缺省 `steer` + `["session-start", "step-end"]`）。
- `docs/BACKLOG.md`：本条目标〔进行中〕；按用户裁定移除条目 2（注入段数余量——不加 `maxInjectionsPerTurn`）与条目 3（ponytail 文档漂移——本次订正后关闭）；条目 1 保留。

## 测试与证据

- 单包：`rule-engine` `npm run check` + `npm test` → **87/87 通过**（新增 2 例：inbox 竞态回归、fail-open / 来源过滤）。
- 反向（变异）验证：临时把 `sessionMessagesOf` 退回「只读可见投影」→ 新回归用例红（`AssertionError: inbox 待消费即算已注入 → 不重复注入`，86 pass / 1 fail）；恢复后 87/87 全绿。
- 单包：`symbol-normalizer` `npm run check` + `npm test` → 39/39；`ponytail` → 5/5。
- 全仓：`npm run check` ✓、`npm run build` ✓、`npm test` → **21 包全部 OK（fail 0）**（临时日志 `tmp/claude-check.log` 已清理）。
- dist 核对：`rule-engine/dist/src/main.js` 含 `pendingInboxMessages` 与 inbox 状态键 `next-step`。
- 根因证据：见「调研」表（真机会话记录）；上一会话 `tui-a665362e-…` 同模式旁证。
- 宿主面依据：`dsh-agent-loop` 注册 `inbox` 投影（`key: "inbox"`，状态 `{"next-turn","next-step"}`；其 `ReactLoopInbox` 自身即用 `stateOf(session, "inbox")` 读待投递）；`ctx.get('sessionProjections')` 读取先例见 `task-engine`（`readService` + `stateOf("tokenUsage")`，2026-10-02 已真机验证）。未新增宿主依赖。
- 未做 / **待人工确认**：真机新会话确认（需重启 `dsh --profile fff`；预期开局只有一条注入——`[RULE] 用 skill 工具加载 i-have-adhd` + `[符号规范]` + `[ponytail]` 合并为一条，同一回合步末不再出现第二条 ponytail / 符号指南）。本会话进程内是改前代码、无法热载；沙箱内不能启新 dsh（写 `~/.dsh/profiles/fff/cordis.yml` 被只读策略拦下）。

## 收尾

- 回写文档：`rule-engine/README.md`、`rule-engine/docs/DESIGN.md`、`symbol-normalizer/{README.md,docs/DESIGN.md}`、`ponytail/{README.md,docs/DESIGN.md}`、`docs/BACKLOG.md`。
- BACKLOG：本次条目（新会话开局重复注入）完成并清理移除；条目 2（注入段数余量）按用户裁定**不修**（不加 `maxInjectionsPerTurn`）后移除；条目 3（ponytail 文档 sources / delivery 漂移）随本次文档同步订正后移除；保留条目 1（全目录文档整理，用户择时）。
- 追踪文档：本文件移入 `docs/archived/`。
- 未做（记此备查）：`docs/STATUS.md`（用户择时）；真机确认（见「测试与证据」）；后备方案 ②③（见「决策」）。
