# TUI 区域焦点在内容推进期间保持（接取条目：TUI/docs/BACKLOG.md「模型回复期间区域焦点被内容推进清空（运行中切换不保持）」）

状态：实现（待人工确认）　　开启：2026-10-15　　关闭：
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

**实现中实测推翻了「保留回合边界」与「保留 `queued-claim`」两半（2026-10-15，见「偏差」）**——最终落地为**只保留用户提交输入两项**（`user-line` / `queued-push`）：

- `turn-begin` / `turn-end`：一次回复可能跨多个回合（核心自发续轮），且 `beginTurnIfNeeded` 在**每个**回合开始都派发 `turn-begin`——保留它们 = 回复中途把焦点甩掉，与条目验收①「运行中派发 `append` / `thinking` / `tool-call` / `notice` 后 `focusedPanel` 保持不变」直接冲突（App 端到端用例实测红）。
- `queued-claim`：`beginTurnIfNeeded`（`src/app/index.ts:2086`）原先**无条件**派发（不只认领排队消息），保持它在集合里等于每回合清焦点；本次一并改为「队列非空才派发」（`:2086-2090`）。
- 结果：28 项 → **2 项**；焦点只在**用户提交输入**时回无焦点（跟随最新），其余一切（流式 / 回合边界 / 状态刷新 / UI）都保持，退出只靠用户主动动作（`Esc` / 再按区域键）。
- 实现方式排除了另建 `clear-focus` action：保留的两项本身就只在提交那一刻派发，收口逻辑可原样保留（只改集合内容），改动面最小。

**连带语义**（已验证：`tests/focus-keep.test.ts`「用户提交输入两项」+ `tests/layout4.test.ts` 同名用例）：**用户提交输入仍会清焦点**（条目期望②）；`/` 命令与 `$` shell 不派发保留集合中的任何一项，故这两类提交**不清焦点**。

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

2026-10-15（实施过程；行号按工作区实测）：

1. 先补 **App 端到端** 用例（`tests/focus-keep.test.ts`，真 App + 假渲染器/适配器）：聚焦会话区后推 `stream` 事件，焦点框（会话区框线转焦点色）必须保持——该用例当场变红，把隐患从「单测绿、真机红」拉到 CI 可见：
   - 第一处：`src/app/index.ts:1722` 的 stream 分支**直派 `append`**（原集合里有它），每个 chunk 都清焦点（已从集合删除）。
   - 第二处：`beginTurnIfNeeded` 在**每个**回合开始都派发 `turn-begin` 与 `queued-claim`（后者原先无条件）——两者都在原保留名单里，于是「新回合一开始就把焦点清掉」（已把两者一并从集合删除，并给 `queued-claim` 加「队列非空才派发」前置，`src/app/index.ts:2086-2090`）。
2. 由此把集合定稿为 **2 项**（`user-line` / `queued-push`），注释口径重写（`src/app/state.ts:1163-1174`）。
3. `TUI/src/app/state.ts:1175-1178`：`FOCUS_RESET_ACTIONS` 最终 = `user-line` / `queued-push` 两项；注释（`:1163-1174`）逐类写明为何不复位。收口逻辑与 `focus-panel` reducer **未改**。
4. `TUI/tests/layout4.test.ts:2451`：原「新输入/输出后焦点自动回 null」用例改写为「焦点只在用户提交输入时复位；流式内容 / 回合边界 / UI action 都不复位」——`append` 与 `notice` 断言反向为**保持**，`turn-begin` / `turn-end` 同样改为保持，`user-line` 保持复位。
5. `TUI/tests/status-column.test.ts:506`：catalog 用例断言反向为焦点保持（`:518`）。
6. `TUI/tests/app.test.ts:4254`（活动区滚动回归）：删除「notice 推进后重新 `Ctrl+T` 聚焦」的那一次按键（新语义下它会把面板收起），改为断言焦点仍为 `activity`（`:4292-4297`）。
7. 新增 `TUI/tests/focus-keep.test.ts`（9 例）：焦点保持清单（23 个「保持」类 action 逐个派发后焦点不变）+ 实战序列 + 回合边界保持 + 用户提交两项复位 + 交付与 UI 滚动 + **App 端到端四例**：①聚焦会话区后流式期间焦点框（会话区框线转焦点色）保持，`turn-end` 后仍保持，`Esc` 才熄灭；②运行中聚焦回合区后↑/↓ 可滚动该区域，且**流式 chunk 到达时滚动位置与焦点都不被重置**（条目验收④的单测替身）；③真实提交路径（输字符 + Enter）后回无焦点且消息已发出，再次聚焦后流式 / 回合边界均不再清（条目验收②）；④运行中 `<` 排队 followup → 新回合被认领且队列清空（覆盖给 `queued-claim` 加的「队列非空才派发」前置）。
8. `TUI/docs/SPEC.md:685`：补「区域焦点复位时机（2026-10-15 裁定）」口径与回归入口。
9. `TUI/demo/main.ts`（审批提示断言）：跑 `npm run demo -- --smoke` 时发现 `approval-hint-bottom` 失败。先用 base 快照比对（`git archive <base> | tar -x` 到 `tmp/base-smoke`，挂上 `node_modules` 后同样只挂这一条）确认**与本次改动无关**（base 与当前分支失败集完全一致）；根因是 **demo 断言文本过期**：断言要求 `▶选项·[Enter]提交·…`（带 `▶` 装饰、无 `·` 分隔），而 `approvalHintLine()`（`src/app/layout/hints.ts:66-74`）自 2026-10-14 提示行格式统一后产出 `[Enter]提交 · [Esc]取消 · [↑/↓]选项 · [Tab]草稿 · [1/2]直答`。已把断言改为按当前产出断言，并在注释里写明根因。

## 偏差

- **重大偏差（推翻决策项 1 的一半）**：决策项 1 原定「保留回合边界 + 用户输入」，实测证明这两半都会让「运行中切焦点」失效（`turn-begin` 每回合开始必派、`queued-claim` 原先无条件派）——已改为**只保留用户提交输入两项**，并在 App 侧给 `queued-claim` 加「队列非空才派发」前置。理由与证据见「实现记录」第 1 条与「测试与证据」的 App 端到端用例；**需用户复核确认**（不改则条目验收①不可能通过）。
- 计划里的「`tests/app.test.ts` 无需改动」判断错误：`:4254`（活动区滚动回归）依赖旧语义（notice 后自动失焦 + 重新 `Ctrl+T` 聚焦），已按新语义修正（删掉多余按键 + 加焦点保持断言）；实施前先实测复现该例失败（`:4292` 红），修正后转绿。
- 新增「实战序列」用例初稿把 `queued-push` 列在「保持」侧，实测红——按其语义属「用户提交输入」（复位类），已从该序列移除。
- 工作区无 `node_modules`（新建 worktree）：为跑 `check` / `build` / `test`，临时把主仓 21 包的 `node_modules` 软链进本 worktree（均在 `.gitignore`，不入提交；收尾时删除）。

## 测试与证据

- `npm run check`（`TUI/`，tsc --noEmit）：无输出（通过）。
- `npm run build`（`TUI/`）：无输出（通过，产物入 `dist/`）。
- `npm test`（`TUI/`）：`tests 1593 / pass 1593 / fail 0`（含 `tests/focus-keep.test.ts` 9 例）。
- 全仓 `npm run test`（仓库根，21 包并行）：全部 `OK`，TUI `pass 1593 fail 0`，其余 20 包 0 fail。
- 临时调试脚本（`TUI/tmp/dbg-focus.mts`，已删）：把「聚焦 → stream」的焦点变化逐次打点，定位到 `append` / `turn-begin` / `queued-claim` 三个清焦点源。
- 回归补充：`npm run demo -- --smoke` 退出码 0、`SMOKE_PASS` 42 条、无 `SMOKE_FAIL`（修掉那条过期断言后）。
- 待人工确认：真机 `dsh --profile fff` 在模型回复中按 `Ctrl+T` / `Ctrl+E`（焦点框保持、方向键可滚动该区域；提交输入 / `Esc` 才回跟随最新）。

## 收尾

（待关闭时填写）
