# 启动后自动触发首轮工具调用完成锚定（接取条目：TUI/docs/BACKLOG.md「启动后自动触发首轮工具调用（代替用户完成锚定解锁）」）

状态：关闭　　开启：2026-09-28　　关闭：2026-09-28
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

TUI 启动时（新建会话或未解锁的恢复会话），由 TUI 代替用户自动触发首轮工具调用，完成「锚定工具引导」的两阶段解锁，不必等用户先输入；`rule-engine` 的 `skill-autoload-on-unlock` 随之在启动阶段命中，两个行为 skill 在用户输入前完成加载。

## 调研

来源：`TUI/src/app/adapter/tool-bootstrap.ts`、`TUI/src/main.ts`、`TUI/src/app/adapter/normalize.ts`、`TUI/src/app/adapter/dsh.ts`、`TUI/src/app/adapter/types.ts`、`TUI/src/app/index.ts`、`TUI/docs/DESIGN.md`「锚定工具引导」、`TUI/README.md`、`TUI/tests/tool-bootstrap.test.ts`、`docs/WORKFLOW-STANDARD.md`。

- 锚定状态机：任务模式由**首个真实 user 消息**（`source.kind === "user"`，跳过注入）分类 spec/react/weak；首请求锁定（persona-only + contexts 清空 + core 工具集）；**首个 durable `tool/call`** 解锁（全量目录 + sections 回归，persona 恒定）；resume-safe（进程内 Set + `session.deriveMessages()` 派生；不可读 fail-open 降级全量，绝不锁死）。
- 捕获点：`agent/inbox/inserted`（先于首组装）与 `agent/pre-step`（兜底）都按 `source.kind === "user"` 过滤；消息投影路径（`sessionModeFromMessages`）同口径；但 `sessionMode` 的 **events 分支缺同款过滤**（rc.2 无公开 events，实际走投影路径，属口径不一致，本次顺带对齐）。
- 解锁判据：`isPromoted`（进程内 Set + `isPromotedFromEvents` / `hasToolCallInMessages`）——kickoff 门控复用同一判据（未解锁才发）。
- 发送面：`main.ts` 在 App 就绪后持有 `agentLike.followup`；消息必须带唯一 `id`（缺则 resume 校验 `lacks an identified message`）；`DshUserMessageLike.source` 现只声明 `{kind:"user"} | {kind:"plugin";plugin}`，需增补生产者自定义 kind 形态。
- 呈现（用户 2026-09-28 定：**按用户输入模式显示**，正文开头加 `[AUTO]` 前缀区分）：消息不带 notice form → 恢复路径天然折为用户块（`role:"user"`）；实时路径**不渲染**非 notice 的用户消息（`dsh.ts` 跳过——真实用户输入由本地回显覆盖），故需 App 侧程序化回显（复用提交路径：`beginTurnIfNeeded(true)` + `user-line`）。边界：本地标题兜底 `find(role==="user")` 可能取到这条（仅官方标题缺失时），待真机复核。
- 时序：`main({adapter})` 内部已调 `app.start()`（订阅事件 + 首帧）；恢复会话的 `history-restore` 会**整表替换** buffer（`state.ts:1686`），故恢复场景的 kickoff 要等历史折叠落定后再发，避免回显行被替换掉。

## 决策

1. **触发判据 = 会话未解锁**（不是「仅新建」）：`toolBootstrap` 未关 + 模型命中 `isDeepseekModel` + durable 记录可读且无 `tool/call`；判据不可读 → **跳过发送**（与 filter 的 fail-open 方向相反：filter 放行全量、kickoff 不发），并输出 stderr warn 说明跳过原因；含未解锁的恢复会话。（用户 2026-09-28 审阅定：补 warn）
1. **不加独立开关**：复用 `toolBootstrap`（kickoff 属锚定行为一部分）。（用户 2026-09-28 审阅确认）
1. **消息对状态机透明、对人按用户输入显示**（用户 2026-09-28 定）：`source.kind:"tool-bootstrap"`（不带 notice form），正文以 `[AUTO]` 开头；实时显示由 App 程序化回显（与提交同路径），恢复后折为用户块；补 `sessionMode` events 分支 kind 过滤（与投影分支同口径）。正文中声明「本条不作为会话标题的参考内容」；**不再做进一步的标题规避与校验，也不保证标题不受该条影响**（已知边界，接受）。
1. **模式缓存延后落定**：kickoff 请求用临时 weak persona、**不写 `modes` 缓存**；真实首消息到达才分类落定（此后 persona 恒定）——否则违反「模式由首个真实 user 消息决定」。（用户 2026-09-28 审阅确认）
1. **解锁判据/释放行为不动**：kickoff 是真实模型工具调用，TUI 不伪造 promoted、不写锚定状态。（用户 2026-09-28 审阅确认）
1. **位置与触发**：`main.ts` 计算门控并把 `bootstrapKickoffText` 传给 `main()`；App 调度与回显（新会话：启动后宏任务发送；恢复会话：等 `restoreStartupHistory` 落定后再发）；发送由 adapter 新方法 `sendBootstrapKickoff()`（`followup` 自定义 source 消息）完成；消息构造 / 门控 / 文本读取在 `tool-bootstrap.ts`（纯函数）；失败只 stderr warn、不重试。（用户 2026-09-28 审阅确认）

## 规划

任务拆分：

1. `tool-bootstrap.ts`：新增 `BOOTSTRAP_KICKOFF_TEXT`（`[AUTO]` 前缀）/ `buildBootstrapKickoffMessage()`（无 notice form）/ `shouldAutoKickoff()` / `firstUserText()`（events 分支带 kind 过滤）；`sessionMode` 改走 `firstUserText`；`resolveMode` 只在拿到真实文本时落定。
1. `types.ts`：`DshUserMessageLike.source` 增补生产者自定义 kind 成员；`DshAdapter` 增补可选 `sendBootstrapKickoff()`。
1. `dsh.ts`：实现 `sendBootstrapKickoff()`（构造消息 + `followup`）+ re-export 新符号。
1. `main.ts`：启动时计算门控（`shouldAutoKickoff`）→ 向 `main()` 传 `bootstrapKickoffText`。
1. `app/index.ts`：deps 接 `bootstrapKickoffText`；启动调度（新会话宏任务；恢复会话等历史折叠落定）+ `submitBootstrapKickoff()`（`beginTurnIfNeeded(true)` + `user-line` 回显 + `adapter.sendBootstrapKickoff()`）。
1. `tests/tool-bootstrap.test.ts`（消息形状 / 门控矩阵 / 文本读取与 kind 过滤 / 模式延后落定）与 `tests/adapter.dsh.test.ts`（`sendBootstrapKickoff` 的消息 source / `followup` 断言，视现有 harness 成本）。
1. 文档：本追踪文档；关闭时回写 `TUI/docs/DESIGN.md`（锚定一节）与 `TUI/README.md`（锚定段落）。

计划改动文件清单（**只改这些**）：

- `TUI/docs/BACKLOG.md`（条目登记与状态）
- `TUI/docs/implementation/2026-09-28-bootstrap-auto-kickoff.md`（本追踪文档）
- `TUI/src/app/adapter/tool-bootstrap.ts`
- `TUI/src/app/adapter/types.ts`
- `TUI/src/app/adapter/dsh.ts`（re-export 与 `sendBootstrapKickoff`）
- `TUI/src/main.ts`
- `TUI/src/app/index.ts`
- `TUI/tests/tool-bootstrap.test.ts`
- `TUI/tests/adapter.dsh.test.ts`（视 harness 成本；不便挂则在追踪文档记录原因）
- `TUI/docs/DESIGN.md`（关闭时回写）
- `TUI/README.md`（关闭时回写）

明确不做：不改 rule-engine（kickoff 工具调用即其触发源）；不加新配置键；运行期 `/new` 等非启动路径不接（如需另开条目）；不新增 notice 渲染分支、不改 `dsh.ts` 实时跳过逻辑（非 notice 注入实时仍不渲染）；不动宿主面 / 其它模块；不顺手改相邻代码。

## 实现记录

2026-09-28 决策审阅通过（6/6）后按规划 1–5 落地：

- `tool-bootstrap.ts`：导出 `firstUserText(session)` + 私有 `eventMessageKind(data)`（events 分支按 `source.kind` 过滤注入消息；投影分支沿用 `kind === "user"`），`sessionMode` 改走前者；kickoff 纯函数 `BOOTSTRAP_KICKOFF_TEXT`（`[AUTO]` 前缀 + 标题声明）/ `BootstrapKickoffMessage` / `buildBootstrapKickoffMessage()`（`randomUUID` + `source.kind:"tool-bootstrap"`）/ `shouldAutoKickoff()`（开关 + deepseek + 未解锁；不可读 → 不发并 warn）；`resolveMode` 只在拿到真实文本时写 `modes`（kickoff 那次请求临时 weak、不落定）；文件头补「启动自检」说明。
- `types.ts`：`DshUserMessageLike.source` 放宽为 `{ kind: string; plugin?: string }`；`DshAdapter` 增可选 `sendBootstrapKickoff()`。
- `dsh.ts`：实现 `sendBootstrapKickoff()`（`disposed` 守卫 + `activeAgent.followup(buildBootstrapKickoffMessage())`）；重导 `firstUserText` / `shouldAutoKickoff` / `BOOTSTRAP_KICKOFF_TEXT` / `buildBootstrapKickoffMessage` / `type BootstrapKickoffMessage`。
- `main.ts`：`main()` 增选项 `bootstrapKickoffText`；`apply()` 内 `shouldAutoKickoff({ enabled: config?.toolBootstrap ?? true, modelId: route.model ?? "", session: rawAgent.session, warn })` 通过才传正文（不通过即 undefined = 不发送）。
- `index.ts`：`AppDeps.bootstrapKickoffText`；字段 `kickoffPending`；`start()` 先 `startBootstrapKickoff()` 再 `restoreStartupHistory()`（挂起早于折叠路径上的同步早返）；`restoreStartupHistory` 的两处同步早返与链尾 `.finally` 均调 `flushKickoffPending()`；新增 `startBootstrapKickoff()` / `flushKickoffPending()` / `submitBootstrapKickoff()`（与提交同路径：`input-status running` + `beginTurnIfNeeded(true)` + `user-line` 回显 + `send.call(adapter)`）。

未做：`sessionModeFromMessages` 与 `firstUserText` 投影分支去重（规划外，未获批不做）；DESIGN / README 回写（关闭时）。

实现期发现、未处理：`restoreStartupHistory` 的陈旧早返（启动读到切换之间会话被切走）仍会 flush kickoff——窗口极窄，未加守卫。

## 测试与证据

- `npm run check`（根，全部子包 `tsc --noEmit`）：通过（exit 0，0 处 `error TS`）。
- `TUI && npm run build`：通过。
- `npm run test:tui`：1200 pass / 0 fail（TUI 全量；较实现阶段 +6 条新用例）。
- `npm run test:tui -- tool-bootstrap.test.ts`：32 pass（27 既有 + 5 新增：消息形状 / events 分支 kind 过滤 / 投影分支同口径 / 门控矩阵 / kickoff 不落定模式）。
- `npm run test:tui -- adapter.dsh.test.ts`：178 pass（+1：`sendBootstrapKickoff` 的 followup source 断言）。
- 首轮新用例失败 1 条（kickoff-only 会话误断言 spec 目录）：实现行为正确（临时 weak），断言写错；改为 weak persona + `["bash","read"]` 后通过。
- 真机验证（2026-09-28，用户回报 B1-B6 全部通过）：
  - B1 新会话启动 → `[AUTO]` 用户块 + 一次 shell 调用（pwd）→ 回「已就绪」→ 解锁；
  - B2 解锁后 `rule-engine` 的 `skill-autoload-on-unlock` 命中（两个行为 skill 在用户输入前加载）；
  - B3 首条真实输入仍决定模式，persona / 目录按它分类，未被 `[AUTO]` 拉成 weak；
  - B4 恢复未解锁会话：`[AUTO]` 块在历史折叠后出现且未被整表替换；
  - B5 已解锁会话重启：不重发、无 warn；
  - B6 本地标题兜底可能取到本条的已知边界（观察到，不修）。

## 收尾

- 回写 `TUI/docs/DESIGN.md`「锚定工具引导」：新增「启动自检 kickoff（2026-09-28）」一条（门控 / 时机 / 临时 weak 不落定缓存 / 标题兜底边界）。
- 回写 `TUI/README.md` 锚定段落：补启动自检一段（`[AUTO]` 消息、不参与分类、已解锁不发）。
- `TUI/docs/BACKLOG.md`：本条目从待办清理移除（TUI 待办清空；已完成项见 git 历史与 `TUI/docs/archived/`）。
- 本文件移入 `TUI/docs/archived/`（`git mv`，保留历史）。
- 未登记遗留项：`restoreStartupHistory` 陈旧早返仍 flush kickoff（窗口极窄，见「实现记录」）；`sessionModeFromMessages` 与 `firstUserText` 投影分支重复（规划外）。两者均不单独立项。
- 临时文件：无（未建 `tmp/` 产物）。
