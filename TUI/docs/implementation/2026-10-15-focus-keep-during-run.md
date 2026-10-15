# TUI 区域焦点在内容推进期间保持（接取条目：TUI/docs/BACKLOG.md「模型回复期间区域焦点被内容推进清空（运行中切换不保持）」）

状态：规划　　开启：2026-10-15　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

模型回复（流式正文 / 思考 / 工具调用 / 通知 / 回合边界等）期间，`Ctrl+E`（会话区）/ `Ctrl+T`（回合区）/ `Ctrl+S`（状态列）设定的区域焦点**不被内容推进清空**，焦点框保持、该区域的方向键滚动持续可用；焦点只在用户**显式动作**时退出。

边界（不在目标内）：不改区域键的三态语义（未聚焦 → 聚焦；已聚焦 → 收起 / 回无焦点）本身；不改无焦点时的「跟随最新 / 自动滚动」行为；不动提示行与 `/help` 键表（属 BACKLOG「按键提示信息与实际绑定对齐」）；不涉及相位符号闪烁抖动（BACKLOG「相位符号闪烁引发版面抖动」，用户裁定挂起）。

## 调研

来源：本仓源码（行号按 `7aba7ae` 工作区核对）+ 既有规格文档。

### 1. 现状机制：焦点复位挂在 action 白名单上

- `FOCUS_RESET_ACTIONS`（`src/app/state.ts:1166-1195`）共 **28** 项，可归四类（括注 = 本次裁定后的去留）：
  - **流式内容**（去掉，17 项）：`append` / `thinking` / `tool-call` / `tool-result` / `retry` / `retry-started` / `step` / `subagent` / `workflow` / `command` / `code-dispatch` / `hook` / `schedule` / `feedback` / `compaction`（+ `-summary` / `-prune`）——运行中每个 chunk 一次。
  - **回合边界**（**保留**）：`turn-begin`（`src/app/index.ts:2081`）/ `turn-end`（`:1855`）。
  - **用户输入**（**保留**，3 项）：`user-line`（`src/app/index.ts:3242`）/ `queued-push`（`:3370` 等）/ `queued-claim`（`:2086`）。
  - **状态刷新（非内容）**（去掉，6 项）：`notice` / `goal-change` / `todo-write` / `jobs-changed` / `permission-catalog` / `agent-preset-catalog`——后两项的现有测试注释即写作「内容推进语义：catalog 更新（外部状态变化）后自动回无焦点」（`tests/status-column.test.ts:506-518`），但 `permission-catalog` / `agent-preset-catalog` 无参（仅 `names` / `ids`），与 `jobs-changed`（无参）同属面板候选刷新，不是会话内容。
- 四类合计 28 项（17 + 2 + 3 + 6），已与集合逐项 diff（无遗漏 / 无多余）；计数原先写作「27 项 / 流式 18」两处已更正。

### 2. 区域键本身不限制运行中，但焦点保持不住

- 三个区域键无 `agentBusy()` 门（`src/app/index.ts:2572`、`:2583`、`:2594`）：运行中按键会真的 `apply(focus-panel)` 并 `paint()`。
- 但流式期间紧随其后的 `append` / `thinking` 立即把 `focusedPanel` 写回 `null`——观感即「运行中切不过去 / 切了立刻掉」。
- 面板滚动按 `focusedPanel` 分流（`src/app/index.ts:2701` 起）；无焦点时 `↑` / `↓` 走对话区（`scrollDialogueBy`，`:2724`），焦点被清后 Turn 面板随即不可滚。

### 3. 退出焦点的现有出口

- **idle + 空输入 + `Esc`**（`src/app/index.ts:2663-2668`）；运行中 `Esc` 是**打断运行**（`:2661-2662`），不退焦点。
- **再按同一区域键**：`focus-panel` reducer 两态（`src/app/state.ts:2276-2305`）——`history` 回 `null`；`status` / `activity` **收起该区**（几何变化、需整帧重排）且焦点回 `null`。
- **提交输入**：没有任何显式清焦点代码，复位实际由 `user-line` / `queued-push` / `queued-claim` 这些 action 的副作用完成（`src/app/index.ts:3242`、`:3370`、`:2086`）。
- **输入字符**：`insertChar`（`src/app/index.ts:5592`）只派发 `input`，该 action 不在集合内——**焦点态下打字不清焦点**（改动前后同）；改动前「按 Ctrl+T 再打字」的实际结果是：焦点被首个流式 chunk 清掉，再打字反而没有副作用。

### 4. 滚动与锚点

- 对话区是否跟随最新由 `state.followBottom` / `dialogueTop` 表示（`src/app/state.ts:1765-1771`）；有焦点时本就没有自动跟底，焦点保持**不新增**行为差异。

### 5. 焦点重置路径全集（用户 2026-10-15 要求补充）

按「谁触发」分 4 类（`focusedPanel` 的直接写入点：`src/app/state.ts:785` / `:1623` / `:1842-1845` / `:1855-1858` / `:2287` / `:2296` / `:2304` / `:2323`，`src/app/index.ts:2668`）：

1. **内容推进白名单（唯一无用户动作即发生的路径，运行中掉焦点的主因）**——`src/app/state.ts:1166-1195` 共 **28** 项（流式内容 17 + 回合边界 2 + 用户输入 3 + 状态刷新 6；本次收窄为 5 项，见「决策」决策项 1），命中即统一清为 `null`（收口 `:2322-2324`），四小类：
   - 流式内容：`append` / `thinking` / `tool-call` / `tool-result` / `retry` / `retry-started` / `step` / `subagent` / `workflow` / `command` / `code-dispatch` / `hook` / `schedule` / `feedback` / `compaction`（+ `-summary` / `-prune`）——运行中每个 chunk 一次。
   - 回合边界：`turn-begin`（`src/app/index.ts:2081`）/ `turn-end`（`:1855`）。
   - 用户输入：`user-line`（`src/app/index.ts:3242`）/ `queued-push`（`:3370` 等）/ `queued-claim`（`:2086`）。
   - 无内容载荷的状态刷新：`notice` / `goal-change` / `todo-write` / `jobs-changed` / `permission-catalog` / `agent-preset-catalog`。
2. **显式退出（用户按键）**——idle + 空输入 + 已有焦点按 `Esc`（`src/app/index.ts:2663-2668`，直接写 `focusedPanel: null`）；再按同一区域键（`focus-panel`，`src/app/state.ts:2283-2305`：`Ctrl+E` 回 `null`，`Ctrl+T` / `Ctrl+S` **收起该区** + 回 `null`）。运行中 `Esc` 是打断运行（`:2661-2662`），**不**退焦点。
3. **切换 / 恢复会话**——`history-resume-ok`（`src/app/state.ts:1558`）与 `session-switch`（`/new`，`:1597`）各自的返回对象里显式 `focusedPanel: null`（`:1623`）；`history-restore`（启动 `--resume` / `-c`，`:1583`）**不写** `focusedPanel`——启动时初值本就是 `null`（`:785`），故不构成额外重置点。
4. **经用户动作间接触发**——`submit()`（`src/app/index.ts:3304` 起）无显式清焦点代码，复位由所派发 action 的副作用完成：默认模式（steer）与 followup 排队派发 `queued-push`、`sendUserText` 派发 `user-line`、`turn-begin` 后派发 `queued-claim`——三条路径都落在第 1 类；`/` 命令与 `$` shell **自身不清焦点**（仅当命令开新回合时经 `turn-begin` 清）。另 `status-column{visible:false}` / `lower-panes{visible:false}` 在焦点正落在被隐区时把焦点移开（隐藏即不聚焦，`state.ts:1842-1845` / `:1855-1858`）。

补充：`insertChar`（`src/app/index.ts:5592`）只派发 `input`，该 action 不在集合内——**焦点态下打字本身不清焦点**；故「Ctrl+T 后打字」的实际结果是焦点被首个流式 chunk 清掉，打字无副作用。

### 6. 受影响的既有测试（现状断言 = 清焦点）

- `tests/layout4.test.ts:2451-2484`：`append`（`:2464`）与 `notice`（`:2477`）后断言 `focusedPanel === null`；`user-line`（`:2472`）同。
- `tests/status-column.test.ts:506-518`：`permission-catalog` 后断言回无焦点。
- `tests/ctrl-t-panes.test.ts:33-55`、`tests/layout4.test.ts:2414-2450`、`tests/title-bar.test.ts:227`：`focus-panel` 三态，若不改三态语义则应保持通过。

## 决策

> 决策项用数字、选项用 abcd，选定项写明字母与理由。**决策项 1 / 2 / 3 / 4 已由用户裁定**（2026-10-15），决策项 5 结论 = 维持现状（见该项）。

### 决策项 1：`FOCUS_RESET_ACTIONS` 的收口范围（已裁定）

- (a) 整体撤销：删掉白名单与 `reduceState` 末尾的清焦点收口，焦点完全由用户显式动作改变。
- (b) 只豁免流式类（`append` / `thinking` / `tool-*` / `notice` 等），保留 `turn-*` 与用户输入类：回合边界仍清焦点。
- (c) 撤销清焦点 + 把「非内容」项（`permission-catalog` / `agent-preset-catalog` / `jobs-changed` 等）一并归为不清焦点，用户输入类改为「仅默认模式提交时显式清」。

**选定：用户 2026-10-15 裁定——去掉流式内容（17 项）与无内容载荷的状态刷新（6 项）两类，保留回合边界（2 项）与用户输入（3 项）两类**（即 (b) 与 (c) 的折中：豁免范围同 (c)，用户输入类不改，不需要新增显式清焦点路径）。

- 保留清焦点（5 项）：`turn-begin` / `turn-end` / `user-line` / `queued-push` / `queued-claim`。
- 不再清焦点（23 项）：流式内容 17 项 + 状态刷新 6 项（`notice` / `goal-change` / `todo-write` / `jobs-changed` / `permission-catalog` / `agent-preset-catalog`）。
- 结果：28 项 → 5 项；模型流式输出期间焦点不再被清，「回合边界 / 用户提交输入」两个自然分界点仍会清。
- 实现方式排除了另建 `clear-focus` action：保留的 5 项本身就只在「回合开/合」与「用户提交输入」时派发，收口逻辑可原样保留（只改集合内容），改动面最小。

**待确认的连带语义**（实现阶段验证并回写本条）：用户输入类保留后，**用户提交输入仍会清焦点**（条目期望②），与提交模式无关；`/` 命令与 `$` shell 不派发保留集合中的任何一项，故这两类提交**不清焦点**（仅当命令开新回合时才经 `turn-begin` 清）。

### 决策项 2：运行中 `Esc` 是否同时退焦点（已裁定）

- (a) 维持现状：运行中 `Esc` 只打断，不退焦点；退焦点只在 idle + 空输入时。
- (b) 运行中 `Esc` 先打断、再退焦点（一次按键两件事）。

**选定 (a)**（用户 2026-10-15「2, 3, 4 保持不变」）：`Esc` 在运行中已有明确语义（打断，提示行「打断」），退焦点仍可走 idle + `Esc` 或再按区域键。不改 `src/app/index.ts` 的 `escape` 分支。

### 决策项 3：运行中「再按同一区域键」是否保留收起（已裁定）

- (a) 维持现状：`Ctrl+S` / `Ctrl+T` 在已聚焦时**收起该区**（几何变化、整帧重排）并回无焦点。
- (b) 运行中改为「只回焦点、不收起」；收起仅 idle 允许。
- (c) 统一改为「再按只回焦点」（任何时刻都不收起），收起改由 `/` 命令或两条既有 action（`status-column` / `lower-panes`）承担。

**选定 (a)**（用户 2026-10-15「2, 3, 4 保持不变」）：收起是用户主动按键，沿用 2026-10-14 的裁定；运行中的整帧重排在 `bbc4fda` 已验证可用。不改 `focus-panel` reducer。

### 决策项 4：焦点保持期间新内容是否推进会话区底部锚点（已裁定）

- (a) 维持现状：有焦点即不自动跟底（聚焦 = 冻结阅读位置）。
- (b) 焦点在会话区时仍自动跟底（只有滚动操作才冻结）。

**选定 (a)**（用户 2026-10-15「2, 3, 4 保持不变」）：与「聚焦即可稳定阅读」一致，无焦点 / 有焦点两条既有路径的现状都不改。

### 决策项 5：提交输入后是否回无焦点（条目期望②）

- (a) 维持：任何模式下提交成功即回无焦点（跟随最新）。
- (b) 仅默认模式（`>` steer）提交回无焦点；`/` 命令、`$` shell、`<` followup 排队不清焦点。

**结论：维持现状（同 (a) 的效果），但不新增显式清焦点路径**——决策项 1 保留了用户输入 3 项，提交路径的清焦点由它们的既有副作用完成（`queued-push` 与 `user-line` 在排队登记与回显时派发）；`/` 命令与 `$` shell 不清焦点属既有行为，本次不改。用户 2026-10-15 未单列该议项，按「2, 3, 4 保持不变」的口径一并维持。

## 规划

1. `src/app/state.ts`：把 `FOCUS_RESET_ACTIONS`（`:1166-1195`）从 28 项收窄为 5 项（回合边界 2 + 用户输入 3），并同步注释口径（`:1163-1165`）——收口逻辑 `:2322-2324` 原样保留。
2. `tests/`：改 `tests/layout4.test.ts:2451-2484`（`append` `:2464` 与 `notice` `:2477` 的断言反向：改为焦点保持；`user-line` `:2472` 的断言保留）、`tests/status-column.test.ts:506-518`（catalog 不再清焦点）。新增文件 `tests/focus-keep.test.ts`：焦点保持（流式与状态刷新各类抽样）、清焦点（保留的 5 项）、idle 空输入 `Esc` 仍退焦点、提交输入后回 `null`。
3. `TUI/docs/SPEC.md`：`:685` 焦点与显隐一节补「退出时机 / 保持范围」口径（流式与状态刷新保持；回合边界、用户提交输入、`Esc`、再按区域键四出口）。

### 计划改动文件清单

- `TUI/src/app/state.ts`（`FOCUS_RESET_ACTIONS` `:1166-1195` 收窄为 5 项 + 注释口径 `:1163-1165`；收口 `:2322-2324` 与 `focus-panel` `:2276-2305` **不改**）
- `TUI/tests/layout4.test.ts`、`TUI/tests/status-column.test.ts`（现状断言改写）+ 新文件 `TUI/tests/focus-keep.test.ts`（保证焦点事件边界）
- `TUI/docs/SPEC.md`（`:685` 一节）
- `TUI/docs/BACKLOG.md`（条目状态：进行中 → 完成 + 收尾清理）

### 明确不做

- 不改区域键「一键一区域」的三态语义、不改提示行内容与露出策略、不改 `/help` 键表、不改无焦点时的跟随最新行为、不碰相位闪烁抖动与活动区开关（另有 BACKLOG 条目）。

## 实现记录

（待决策定稿后追加）

## 偏差

（待实现后填写）

## 测试与证据

（待实现后填写）

## 收尾

（待关闭时填写）
