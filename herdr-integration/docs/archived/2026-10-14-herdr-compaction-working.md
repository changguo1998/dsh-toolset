# 压缩会话历史期间显示为工作中（接取条目：herdr-integration/docs/BACKLOG.md「压缩会话历史期间应显示为工作中（现显示 idle）」）

状态：关闭　　开启：2026-10-14　　关闭：2026-10-14
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

上下文压缩（`/compact` 手动或自动触发）期间，herdr 面板上报 `working` 而不是 `idle`；压缩正常结束与带 `error` 结束都必须回落，不卡在 `working`；阻塞态优先级不变（压缩中同时 turn 阻塞仍上报 `blocked`）。

## 调研

来源：宿主包（全局安装的 dsh 0.9.4 依赖树，非本仓代码）+ herdr 0.9.4 文档与 schema + 本机会话日志实测 + 本包既有源码。

1. **根因（本包代码）**：活跃度只由根 agent 状态推导 —— `agentActive = roots.some((agent) => agent.status === "running")`（`src/main.ts:189`，启动期同口径 `:272`）。压缩在 turn 循环之外执行，不产生 `agent/status` 的 `running` 转移，故压缩全程 `agentActive === false`，`desiredState()`（`src/state.ts:55`）落到 `idle`。

2. **可用信号（宿主契约已核）**：压缩是会话事件，本包既有的 `session/event` 订阅（`src/main.ts:265`）即可收到，无需新增订阅面。声明见 `@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js` 的 `SessionEventMap`：

   - `compaction/start`：`{ compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null }`
   - `compaction/end`：`{ compactionId; sourceCommandId?; turn: number | null; error?: string }`
   - 另有 `compaction/summary` / `compaction/prune`（不做状态用）。

   发射点：`@deepseek-ai/dsh-compaction-basic/lib/index.js:469`（start）与 `:484`（成功 end）、`:495`（失败路径同样发 `compaction/end`，带 `error`）——**end 必然配对，含失败分支**。手动压缩 `owner === null`（无开放 turn），自动压缩 `turn` 为当前 turn。

3. **监听者收到的第一参数是 Session 实例**（`dsh-session/lib/index.js:1468` 把 `[this, event]` 传给 `session/event`；`Session.id` 取 `header.id`，`dsh-session/lib/types/index.js:356`），故订阅处可用会话 id 过滤。

4. **herdr 0.9.4 协议面**：`PaneReportAgentParams.message` 为可选字符串（`herdr api schema --json`），且官方文档「Agent state reporting」的示例就是 `state: "working"` + `message: "building docs"`（https://herdr.dev/docs/socket-api/ ），说明 working 态带 message 是被支持的展示语义（`state_labels` 是另一套展示覆盖机制，本包不用）。

5. **子 agent 压缩存在性（实测）**：解压本机 12 份会话日志（`~/.dsh/sessions/*/*/session.v4.jsonl.zstd`）统计 —— 其中 2 份为子 agent 会话（`origin: subagent`），**均无 `compaction/start`**；2 份根会话含压缩。样本不支持「子 agent 会压缩」，但订阅面确实会收到子会话事件（`session/event` 为会话作用域，根 ctx 订阅者收全部会话）。

## 决策

决策项 1（压缩计数口径）：选项 (a) 只算根会话；(b) 所有会话都算 —— **选定 (a)**。理由：与 README 既有边界「只跟踪根 agent」一致；子 agent 压缩不该点亮主面板（否则根 agent 空闲时面板显示工作中，语义错）。实现上用会话 id 比对 `currentSessionRef.id`（启动期同步后已就位）。

决策项 2（是否带 message）：选项 (a) 带，且只给 working 态；(b) 带并按状态切换、转换时改写；(c) 不带 —— **选定 (a)**。理由：herdr 的 `message` 是「记录当前态」的语义（每次 `pane.report_agent` 全量描述当前态），转 blocked/idle 时不再带 message 即已不显示，无需回头改写（选项 b 的额外发送路径改动没有收益）。文案在 `state.ts` 内定为常量 `COMPACTING_MESSAGE = "compacting context"`，由 `desiredState` 计算，避免调用方各写一份。

决策项 3（是否区分压缩类型）：选项 (a) 不区分；(b) 区分手动 `/compact`（`sourceCommandId` 非空）与自动压缩 —— **选定 (a)**。理由：两者都是 LLM 摘要在跑，观感一致；区分需两套文案与分支，收益有限。

## 规划

任务拆分：

1. `state.ts`：`desiredState()` 增第四参 `compacting`（压缩中），优先级 `blocked > working > idle`，working 两种来源（`agentActive` / `compacting`）共用，压缩期带 `COMPACTING_MESSAGE`。
2. `main.ts`：`session/event` 分支认 `compaction/start` / `compaction/end`，用 `Set<compactionId>` 配对（只收当前根会话的事件），end 无论有无 `error` 都移除条目；移除后重算并上报。
3. 单测：`tests/state.test.ts` + `tests/main.test.ts` 补压缩期用例（含 error 分支、blocked 优先、子会话过滤、未配对 end 兜底）。
4. `README.md`：「能力」表补压缩期一行，测试计数与概要同步。

计划改动文件清单（本清单之外的文件不改）：

- `herdr-integration/docs/BACKLOG.md`（条目状态：进行中 → 完成 → 收尾清理）
- `herdr-integration/docs/implementation/2026-10-14-herdr-compaction-working.md`（本文件）
- `herdr-integration/src/state.ts`
- `herdr-integration/src/main.ts`
- `herdr-integration/tests/state.test.ts`
- `herdr-integration/tests/main.test.ts`
- `herdr-integration/README.md`
- `tmp/verify-compaction-state.mjs`（临时验证物，不进提交，收尾删除）

明确不做：

- 不新增订阅面（复用既有 `session/event`）；不改 `BlockTracker`（压缩不是「等用户」，不复用阻塞语义 —— 见条目「不要复用 BlockTracker」）。
- 不区分 `/compact` 与自动压缩（决策 3），不读 `sourceCommandId`。
- 不上报 herdr 的 `done` 状态（本包只用 `working` / `blocked` / `idle` 三态，与现状一致）。
- 不做压缩进度百分比之类的新展示面（herdr 协议无此语义）。
- 不改 `src/herdr.ts`（message 透传路径已存在，`sendState` 已按 `message !== undefined` 附带）。
- 不改 `scripts/verify-herdr.mjs`（已支持 `node scripts/verify-herdr.mjs working "compacting context"`，真机验证够用）。

## 实现记录

- **2026-10-14 环境准备**：本 worktree 无 `node_modules`（`npm run check` 报 `tsc: not found`），在包内跑 `npm install` 装 devDependencies（typescript + @types/node，3 个包），此后 `check` / `build` / `test` 均可跑。基线：check 通过、test 35 例通过。
- **2026-10-14 `src/state.ts`**：新增导出常量 `COMPACTING_MESSAGE = "compacting context"`；`desiredState()` 增第四参 `compacting = false`（缺省保持原语义），优先级 `blocked > working > idle`，`compacting || agentActive` 即 working，其中仅 `compacting` 触发时带 `COMPACTING_MESSAGE`；文件头注释同步为两个 working 输入。
- **2026-10-14 `src/main.ts`**：新增内存态 `const compactionById = new Set<string>()`（按 `compactionId` 配对，重复 start 幂等、未配对 end 不误减）；`publish()` 把 `compactionById.size > 0` 传给 `desiredState`；`handleSessionEvent` 首参改名 `session`（原 `_session`）并新增 `sessionIdFrom()`，`compaction/start` / `compaction/end` 分支只认当前根会话（`currentSessionRef.id`）的事件，`end` 无论有无 `error` 都移除条目后重算上报；turn 分支语义与顺序不变（先处理压缩分支再走 turn 分支）。`src/herdr.ts` 未改：`sendState` 原本就按 `message !== undefined` 附带 message。
- **2026-10-14 单测**：`tests/state.test.ts` 补 3 例（压缩中→working 带文案、压缩中 + agent 活跃、blocked 优先于压缩）；`tests/main.test.ts` 补 5 例（压缩 start/end 往返、end 带 `error` 回落、压缩中 turn 阻塞 → blocked 且解除后回到压缩 working、子会话压缩被忽略、未配对 end / 畸形载荷不上报）。
- **2026-10-14 `README.md`**：「能力」节补「压缩期工作中」一条（含子会话过滤、error 回落、blocked 优先三点），blocked 表下补一句「三类来源都带各自的 message」；测试计数 35 → 43 与用例分布同步。
- **2026-10-14 临时验证物**：`tmp/verify-compaction-state.mjs`（用 `dist/` 编译产物 + 注入 sender / 假 ctx 跑一次压缩期往返，见「测试与证据」）；`tmp/herdr-schema.json` 等调研中间物。收尾时删除。

## 偏差

- 计划改动文件清单之外新增临时验证物：`tmp/verify-compaction-state.mjs`（以及调研中间产物 `tmp/herdr-schema.json`、`tmp/socket-api.html`）。理由：条目验收②要求真机证据，而本任务无法在会话内真跑 `/compact`（需要足够长的会话触发压缩），故用编译产物做一次等价的事件→状态往返作为替代证据；放在项目根 `tmp/`（AGENTS.md 约定的临时文件位置），不进提交、收尾删除。
- 条目验收②「真机 `dsh --profile fff` 跑一次 `/compact`，压缩全程面板显示工作中」未完成：只能在交互式 TUI 会话里发起，本 agent 会话内无法触发（见「测试与证据」的替代证据）；留待用户人工确认。
- 计划里「`main.ts` 按 `compactionId` 计数 start / end」落地为 `Set<compactionId>` 配对（不是计数）：语义等价且重复 start / 未配对 end 都不会偏移，理由记在代码注释。

## 测试与证据

- 机械验证（`herdr-integration/` 下执行）：

  - `npm run check` → 退出码 0（tsc --noEmit，无输出）。
  - `npm run build` → 退出码 0。
  - `npm test` → `ℹ tests 43 / ℹ pass 43 / ℹ fail 0`（基线 35 例，本次新增 8 例：state 3 + main 5）。

- 编译产物行为验证（`node tmp/verify-compaction-state.mjs`，注入记录器 sender，根会话 `s1` 起始 idle）：

  ```json
  [{"state":"idle"},{"state":"working","message":"compacting context"},{"state":"idle"}]
  ```

  即：`compaction/start`（根会话）→ `working` + `compacting context`；同批触发的子会话（`child`）`compaction/start` 未产生任何上报；`compaction/end`（带 `error: "boom"`）→ 回落 `idle`。

- 真机面（live pane `wQG:p1`，herdr 0.9.4，`herdr api snapshot` 核对）：

  - `node scripts/verify-herdr.mjs working "compacting context"` → 面板 `agent_status` 从 `done` 变 `working`（`state_change_seq` 426）；随后 `node scripts/verify-herdr.mjs idle` → 变 `done`（425）。说明编译产物经真实 socket 上报链路可用，`working` + message 报文被 herdr 接受。
  - **面板不显示 message**：`AgentInfo`（`herdr api snapshot`）没有 message 字段，故 message 只影响 herdr 侧展示，无法从 snapshot 断言；依据是 herdr 0.9.4 自带 schema（`pane.report_agent` 的 `message: string|null`）与官方文档「Agent state reporting」示例（`state: "working"` + `message: "building docs"`）。
  - 附注（与本任务无关，未追查）：手工上报 `idle` 后面板读回的是 `done`（`AgentInfo.agent_status` 枚举含 `done`，语义为「空闲且完成的工作未被查看」），非本插件上报值；本包仍只上报 `working` / `blocked` / `idle` 三态。

- 未验证项：真机 `/compact` 全程（见「偏差」）；README「能力」表的人工核对留待用户。

## 收尾

- **回写文档**：`herdr-integration/README.md`（「能力」节补「压缩期工作中」；blocked 表下补 message 说明；测试计数 35 → 43）——本包为轻量包，无 `DESIGN.md` 需回写；项目级 `docs/ROADMAP.md` 与根 `README` 不涉及；`STATUS.md` 按流程由用户择时更新（未改）。
- **BACKLOG 清理**：本条目（「压缩会话历史期间应显示为工作中（现显示 idle）」）已在收尾时从 `herdr-integration/docs/BACKLOG.md` 移除（只留未完成项；完成记录见本文件与 git 历史）。
- **归档**：本文件从 `herdr-integration/docs/implementation/` 移入 `herdr-integration/docs/archived/`（关闭后不再改）。
- **临时物清理**：删除 `tmp/verify-compaction-state.mjs`、`tmp/herdr-schema.json`、`tmp/socket-api.html`（均在项目根 `tmp/`，未进提交）；包内 `node_modules/` 与 `dist/` 由 `herdr-integration/.gitignore` 忽略，保留供后续迭代。
- **遗留项（不阻塞关闭）**：
  1. 真机 `/compact` 全程核对（条目验收②）未做——原因与替代证据见「偏差」；留给用户在真实长会话里跑一次 `/compact` 时顺带确认（面板应在压缩期间显示工作中 + `compacting context`）。
  2. 手工把状态报成 `idle` 时，herdr 面板读回的是 `done`（`AgentInfo.agent_status` 枚举含 `done`，语义为「空闲且完成的工作未被查看」）；本包只上报 `working` / `blocked` / `idle` 三态。是否要为「已完成未查看」另发 `done` 属新展示面，未开条目——若认为值得接，另登 BACKLOG。
- **无计划外残留**：除上述临时物外，工作区改动仅限「计划改动文件清单」列出的文件（`git status` 自查）。
