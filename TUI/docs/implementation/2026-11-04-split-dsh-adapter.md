# 拆分 DSH 适配层（接取条目：`TUI/docs/BACKLOG.md`「拆 `TUI/src/app/adapter/dsh.ts` 的 `DshAdapter`」）

状态：规划　　开启：2026-11-04　　关闭：—
本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改.

## 目标

把 `TUI/src/app/adapter/dsh.ts` 的 3633 行真实适配层收成「显式上下文对象 + 按职责拆文件」: 先把 `createRealDshAdapter` 闭包里的状态与事件出口收成显式上下文对象, 再按「连接与会话 / 事件转接 / 审批桥 / 面板查询」四组搬进独立文件; 对外可见集合、事件顺序与帧内容一律不变.

## 调研

### 现状结构（`TUI/src/app/adapter/dsh.ts`, 3633 行）

| 行段 | 内容 | 行数 |
| --- | --- | --- |
| 1-117 | 文件头注释 + import + 兼容重导（类型 / 纯函数 / 子模块） | 117 |
| 118-288 | 全部 `export type` 重导出块 | 171 |
| 289-360 | `installSessionModelSelection`（顶层导出） | 72 |
| 361-403 | `createRealDshAdapter` 入口: `opts` 解构 + 闭包状态声明 | 43 |
| 404-506 | 事件出口三件套 `emit` / `deliver` / `deliverFinalize` / `deliverText` | 103 |
| 507-543 | `liveScope` + `ctxWindowCache` + `resolveContextWindow` | 37 |
| 544-667 | `withTurnBoundaries` + `doReadSessionSurface` | 124 |
| 668-864 | `restoreSessionState` | 197 |
| 865-1004 | `applyChunk` + `attemptMeta` + `onAssistantFrame` | 140 |
| 1005-1906 | `onSessionEvent`（会话事件归一化主体） | 902 |
| 1907-2021 | `toolCallsByCallId` + `settle` + `approvalAnswerer` + `pendingQuestions` + `questionAnswerer` | 115 |
| 2022-3419 | `adapter: DshAdapter` 对象字面量（65 个成员, 含 2 个 getter） | 1398 |
| 3421-3516 | `runtime.on` 接线（session/event、goal/activation、assistant-stream、agent/status、subagent、approval、jobs 订阅） | 96 |
| 3518-3632 | `return adapter` 之后的函数声明（`collectUnbind` / `dispatchCommand` / `finish` / `formatCommandError` / `emitAgentStatus`） | 115 |

### 计数（实测）

- 闭包状态变量 24 个: `activeSessionId` / `activeAgent` / `activeCommandAgent` / `activeCancel` / `activeDispose` / `sessionModelSeed` / `listeners` / `pendingApprovals` / `approvalSeq` / `disposed` / `runtimeUnbinds` / `activeCommands` / `emittedByBlock` / `completedBlocks` / `sessionSeq` / `lastToolBySession` / `rateBySession` / `renderedNoticeIds` / `stepEmitted` / `commandNames` / `workflowRuns` / `liveScope` / `attemptMeta` / `pendingQuestions` / `questionSeq` / `ctxWindowCache` / `toolCallsByCallId`.
- 二层箭头 helper 16 个; adapter 对象成员 65 个（其中 `get sessionId` / `get workflowRuns` 是 getter）.
- `runtime.on` 注册 7 处, 顺序敏感（`onSessionEvent` 的累计状态依赖注册先于首条事件; jobs 订阅在 `return adapter` 之前建立）.

### 事实更正（与条目措辞的差异）

条目写「`DshAdapter` 持有连接 / 会话 / 审批 / 工具事件等多组状态」; 实测 `DshAdapter` 是 `TUI/src/app/adapter/types/adapter-contract.ts:24` 的 **interface**, 状态全部在 `createRealDshAdapter` 的闭包里, 适配器本体是 2022 行起的对象字面量.本任务按实际结构做, 不改条目措辞（条目措辞的更正留给 BACKLOG 整理时处理）.

### 被引用面（决定「对外可见集合不变」的边界）

- 包外消费方（`src/app/state/*`、`src/app/components/*`、`src/app/index.ts`、`src/main.ts`、`tests/*`）只从 `./adapter/dsh.ts` 取**导出**: 类型、`installSessionModelSelection`、`createRealDshAdapter`、`normalizeHistoryMessages` 等; grep 未发现任何消费方直接引用 `dsh.ts` 的内部 helper 或闭包状态.
- `src/app/adapter/history-normalize.ts:69` 反向 `import { createRealDshAdapter } from "./dsh.ts"`（循环依赖, 现状既有）, 拆分后仍由 `dsh.ts` 导出该工厂, 不新增反向依赖.

### 测试与工具基线（2026-11-04 实测）

- `pnpm run test:tui`: tests 1829 / pass 1829 / fail 0 / skipped 0, duration 8243 ms.
- `pnpm -C TUI run check`: `tsc -p tsconfig.json --noEmit` 退出 0.
- `pnpm -C TUI run demo -- --smoke`: 末行 `SMOKE_OK sent=[...] interrupts=1`.
- 帧基线: `tests/focus-frame.test.ts` 逐行基线现成, 作为「帧内容不变」的守成证据; 本任务**不重冻**基线.

### 前史

`docs/archived/2026-10-28-history-cleanup-tui.md` 阶段 3 已按「一次一组」搬出 `normalize.ts` / `session-paths.ts` / `session-ui-state.ts` / `approval-tool-calls.ts` / `tool-bootstrap.ts`, 并裁定「余下 3604 行的 `adapter/dsh.ts` 是有状态主体, 继续拆需要上下文对象重构, 留待后续单独条目」——本条目即该裁定的接续.

## 决策

1. **上下文对象形态**: a 分节 state（`state.session` / `state.events` / `state.approval` 各一节）; b 单一扁平可变 `AdapterState` + 注释分区.
   选定 **b**: 搬迁优先于建模, 分节会让「同一字段被两组读写」（如 `activeSessionId` 同时供 events 与 session）产生跨节引用与额外类型守卫, 与「行为不变」的验收冲突; 扁平表的归属改由注释与文件分区表达.
2. **适配器组装方式**: a 对象 spread 合并各 part; b `Object.defineProperties` 合并各 part.
   选定 **b**: `get sessionId()` 与 `get workflowRuns()` 是 getter, spread 会在组装瞬间求值成常量, 直接改变语义（`sessionId` 是「当前活跃会话」的实时视图, 供启动早期 Mode 快照取用）.getter 属性描述符原样搬运.
3. **拆分范围**: a 严格按条目原文三组（事件转接 / 连接与会话 / 审批桥）, 面板查询面留在 `dsh.ts`; b 三组之外再加「面板查询」第四组.
   选定 **b**（用户 2026-11-04 裁定）: 面板查询是一组只读服务面（jobs / skills / agents / tools / settings / config / tasks / loops / memory / guard / workflows / search / council）, 与前三组无状态耦合, 独立后 `dsh.ts` 只剩装配与接线（约 800 行）; 该裁定超出条目原文的拆分范围, 已获用户明确同意.
4. **新文件命名**: `context.ts`（上下文对象 + 事件出口）/ `dsh-events.ts` / `dsh-session.ts` / `dsh-approval.ts` / `dsh-panels.ts`.
   选定: 带 `dsh-` 前缀避免与既有 `types/events.ts`、`types/session.ts` 混淆; 上下文对象不叫 `state.ts`, 避免与 `src/app/state.ts`、`types/adapter-contract.ts` 的既有 `State` 概念混读.
5. **`runtime.on` 接线位置**: 留在 `dsh.ts` 的「接线」段, 顺序与现有代码逐行一致, 不搬进 part 文件.
   理由: 注册顺序是隐式契约（会话事件先于首条事件到达、jobs 订阅先于 `return adapter`）, 搬移会改初始化顺序, 属行为改动.
6. **迁移规约**: 每一步只搬位置与改调用签名（`x` → `ctx.state.x` / `emit` → `ctx.emit`）, 函数体、注释、条件与分支顺序逐字保留; 不合并、不重命名、不顺手修.发现真缺陷只记「偏差」并在 BACKLOG 追加新条目, 不在本任务修.
7. **验证门**: 每步结束跑 `pnpm -C TUI run check` + `pnpm run test:tui`, 步骤 6 与 7 追加 `demo -- --smoke` 与 `tests/focus-frame.test.ts` 专项.
8. **测试零改动**: `tests/**` 不在改动清单内; 若某步必须改测试才能绿, 说明对内契约被改坏, 停下记偏差并请示, 不改测试迁就实现.
9. **提交粒度**: 决策点先答「否」, 后按用户裁定「提交然后继续」单独提交规划文档（`acfd3837`）; 后续三个提交点（实现后 / 测试后 / 关闭后）仍按 `docs/WORKFLOW-STANDARD.md` §5 各问一次, 默认建议合并.

## 规划

### 步骤（每步结束必须 check + test 绿）

| 步 | 内容 | 目标文件 | 预计行数 | 验证 |
| --- | --- | --- | --- | --- |
| 0 | 记录基线（已完成, 见「调研」） | — | — | 1829/1829、check 0、`SMOKE_OK` |
| 1 | 新建上下文对象: `AdapterState`（24 个字段）+ `createAdapterContext(opts)` + 事件出口三件套与 `listeners` / `runtimeUnbinds` / `collectUnbind`; `dsh.ts` 内全部闭包状态改为 `ctx.state.*`, `emit` / `deliver*` 改为 `ctx.*` | 新增 `adapter/context.ts`; 改 `dsh.ts` | ~200 | check + test |
| 2 | 搬「事件转接」: `onSessionEvent` / `applyChunk` / `onAssistantFrame` / `withTurnBoundaries` / `attemptMeta` / `liveScope` 与相关 Map, 导出一个 `createEventBridge(ctx)`; `dsh.ts` 只留调用 | 新增 `adapter/dsh-events.ts`; 改 `dsh.ts` | ~1200 | check + test |
| 3 | 搬「审批桥」: `pendingApprovals` / `settle` / `approvalAnswerer` / `pendingQuestions` / `questionAnswerer` / `toolCallsByCallId`, 导出 `createApprovalBridge(ctx)` | 新增 `adapter/dsh-approval.ts`; 改 `dsh.ts` | ~180 | check + test |
| 4 | 搬「连接与会话」: `doReadSessionSurface` / `restoreSessionState` / `resolveContextWindow` / `ctxWindowCache` 与会话切换、模型目录、会话 UI 状态相关成员, 导出 `createSessionBridge(ctx)` | 新增 `adapter/dsh-session.ts`; 改 `dsh.ts` | ~420 | check + test |
| 5 | 搬「面板查询」: jobs / skills / agents / tools / settings / config / fork / tasks / loops / memory / guard / workflows / search / council / group / contract 等只读服务面成员, 导出 `createPanelBridge(ctx)` | 新增 `adapter/dsh-panels.ts`; 改 `dsh.ts` | ~900 | check + test |
| 6 | `dsh.ts` 收尾: 用 `defineProperties` 组装各 part + 剩余成员（连接与会话入口、命令分派、jobs 订阅、`runtime.on` 接线、`installSessionModelSelection`、兼容重导）, 重写文件头结构注释 | 改 `dsh.ts` | 3633 → ~800 | check + test + smoke + 帧基线 |
| 7 | 回写 `TUI/docs/DESIGN.md` 的 adapter 目录说明（第 109-110 行）, 跑 `format` 与全仓 `pnpm run check` | 改 `TUI/docs/DESIGN.md` | — | check / test / smoke |
| 8 | 关闭: 条目标「完成」并从 BACKLOG 移除, 追踪文档移入 `TUI/docs/archived/` | 改 `TUI/docs/BACKLOG.md`; 移动本文档 | — | git diff 自查 |

### 计划改动文件清单

新增:

- `TUI/src/app/adapter/context.ts`
- `TUI/src/app/adapter/dsh-events.ts`
- `TUI/src/app/adapter/dsh-approval.ts`
- `TUI/src/app/adapter/dsh-session.ts`
- `TUI/src/app/adapter/dsh-panels.ts`
- `TUI/docs/implementation/2026-11-04-split-dsh-adapter.md`（本文档）

改动:

- `TUI/src/app/adapter/dsh.ts`
- `TUI/docs/BACKLOG.md`（条目状态「进行中」→「完成」, 关闭时移除）
- `TUI/docs/DESIGN.md`（步骤 7 回写）

明确不改（出现需求先请示并补进清单）:

- `TUI/tests/**`、`TUI/demo/**`、`TUI/src/app/index.ts`、`TUI/src/main.ts`、`TUI/src/app/state/**`
- 其它 33 个包、根 `package.json` 与 `scripts/`
- 不改任何函数体行为; 不重冻 `tests/focus-frame.test.ts` 的逐行基线; 不执行 `TUI#2`（`index.ts` 拆分）范围内的任何改动; 不新增依赖

### 风险与对策

| 风险 | 对策 |
| --- | --- |
| getter 在组装时被求值成常量 | 决策 2: `Object.defineProperties` 原样搬描述符; 步骤 6 用 `tests/focus-frame.test.ts` + `adapter.dsh.test.ts` 的 `sessionId` 断言守 |
| 注册顺序被搬移改变 | 决策 5: 接线段不动; 每步 diff 只含「行位置变化」 |
| 跨文件循环 import | 所有 part 只 import `context.ts` 的类型与 `types.ts`; part 之间不互相 import（事件桥需要审批桥时经 `ctx` 上的回调, 由 `dsh.ts` 组装时注入） |
| 某步 test 转红且原因不明 | 该步只回滚本步改动, 把现场与命令输出写进「偏差」后再请示, 不连续重试 |

## 用户裁定记录（2026-11-04）

1. **拆分范围**: 追加「面板查询」第四组 —— 新增 `adapter/dsh-panels.ts`, `dsh.ts` 目标约 800 行（见决策 3）.
2. **决策点提交**: 先答「否」, 后裁定「可以, 提交然后继续」—— 规划文档单独提交为 `acfd3837`（`docs(tui): 拆分 DSH 适配层的规划与追踪文档`）, 实现继续; 其余提交点仍按 §5 逐点询问.

## 实现记录

按「机械搬迁 + 后缀改写」一次成型（未逐步落盘, 见偏差 1）:

1. 用一次性脚本 `tmp/split-dsh.mjs` 从原 `dsh.ts` 抽取: 状态声明 → `context.ts` 的 `createState()` 对象; `emit` / `deliverFinalize` / `deliverText` / `deliver` → `context.ts` 的 `createAdapterContext()`; 事件转接（`isCorrectiveEvent` / `applyChunk` / `onAssistantFrame` / `onSessionEvent` / `recordAgentRate` / `emitAgentStatus`, 原 337-359 与 859-1901 行）→ `dsh-events.ts`; 会话面（`resolveContextWindow` / `withTurnBoundaries` / `doReadSessionSurface` / `restoreSessionState` 与 23 个成员）→ `dsh-session.ts`; 审批桥（`settle` / `approvalAnswerer` / `questionAnswerer` 与 7 个成员）→ `dsh-approval.ts`; 面板查询（`workflowRows` 与 32 个成员）→ `dsh-panels.ts`.
2. 改写规则: 状态标识符加 `s.`（`context.ts` 内加 `state.`）、`emit` / `deliver*` 加 `ctx.`、`toolCallsByCallId` → `ctx.toolCalls`; 只在代码段替换（注释 / 字符串 / 模板字面量按词法跳过）。
3. 对象成员按起始行切分（65 个成员逐一归类, 脚本断言总数）, 成员前的说明注释回挂到该成员, 避免串组。
4. `dsh.ts` 只剩: `assembleAdapter`（`Object.defineProperties` 合并, 保留 getter）、工厂装配、`runtime.on` 接线（顺序不变）、jobs 订阅、`dispatchCommand` / `finish` / `formatCommandError` / `collectUnbind`、`runCommand` / `dispose` 两个成员、`installSessionModelSelection` 与全部兼容重导。
5. 生成后清理: 未使用 import 删除、同源 import 合并、`format`（prettier）统一格式、新文件头注释改为仓库根相对路径（`TUI/src/app/...`）。
6. 文档回写: `TUI/docs/DESIGN.md` 文件树 adapter 段（第 109-111 行）与两处行为说明（第 416 / 553 行）改点到新文件。

行数变化（`wc -l`）:

| 文件 | 行数 |
| --- | --- |
| `adapter/dsh.ts` | 3633 → 577 |
| `adapter/context.ts` | 新增 206 |
| `adapter/dsh-events.ts` | 新增 1161 |
| `adapter/dsh-session.ts` | 新增 766 |
| `adapter/dsh-approval.ts` | 新增 179 |
| `adapter/dsh-panels.ts` | 新增 992 |

## 偏差

1. **未按计划逐步落盘**: 计划是「每步一搬、每步 check + test 绿」; 实际用一次性脚本搬完全部四组后统一验证（`check` → 单测 → 冒烟）。原因: 五组改动都在同一文件内互相引用, 只搬一组时状态前缀与成员归属仍会二次改写, 分步的中间态无法独立编译。证据: 脚本一次生成, 首轮 `tsc` 仅剩 import / 状态声明边界类错误, 修完即绿。
2. **两处为目标结构必需的微改（非纯搬迁）**: ① jobs 订阅里的局部 `const events = jobsSvc.events` 与注入的 `events` 桥重名 → 改名 `jobsEvents`（3 行）; ② 被搬代码里 state 标识符作对象简写（`{ activeSessionId }`）与 getter 名（`get workflowRuns()`）不能加前缀 → 改写为 `{ activeSessionId: s.activeSessionId }` / 保留 getter 名（语义等价）。
3. **`dsh.ts` 比计划的约 800 行更小（577 行）**: 面板成员与 `workflowRows` 全部搬走后, 装配与接线本身只有约 240 行, 其余是兼容重导（`export type` 大块）与 `installSessionModelSelection`。
4. **`isCorrectiveEvent` / `isReplaceOp` 位置**: 原为 `dsh.ts` 的模块级私有函数, 现搬进 `dsh-events.ts`（唯一使用方）; 未新增导出。
5. **`TUI/docs/DESIGN.md` 的 `src/app/adapter/dsh.ts:1` 类注释路径警告**: 沿用仓库现有写法（`src/app/...`）与既有 588 处存量同类, 未在本任务一并改（属项目级 backlog「清理 .ts 注释里的简写路径」）。新文件头改用完整路径, 不新增该类警告。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `pnpm -C TUI run check` | 退出 0（`tsc -p tsconfig.json --noEmit`） |
| `pnpm run test:tui` | tests 1829 / pass 1829 / fail 0 / skipped 0, 8208 ms（与拆分前基线同为 1829） |
| `pnpm run test:tui -- tests/focus-frame.test.ts` | pass 1 / fail 0（帧逐行基线未重冻, 内容一致） |
| `pnpm -C TUI run demo -- --smoke` | 末行 `SMOKE_OK` |
| `pnpm -C TUI run build` | 退出 0（`tsc -p tsconfig.json`） |
| `pnpm run check`（全仓 34 包） | 退出 0 |
| `node dev/standard/index.mjs` | `check:docs` 通过: 错误 0 / 警告 653（新增 0 条, 见偏差 5） |

拆分前后对拍: 适配器对外导出集合未变（`src/app/{index.ts,main.ts,state,components}` 与 `tests/` 的 import 路径零改动）; 事件注册顺序未变（`user-questions` → `session/event` → `goal/activation` → `assistant-stream` → `agent/status` → `subagent/*` → `approval/request` → jobs, 与拆分前一致）。
未验证: 真机 `smoke:pty`（需模型凭据, 与拆分前同样的环境限制）; `install.sh --sync` 后的主 profile 行为（属用户按需执行）。

## 收尾

（未开始）
