# 切换顶部面板焦点的快捷键重做（接取条目：TUI/docs/BACKLOG.md「切换顶部面板焦点的快捷键重做（`Tab` 与补全挤在一起, 且从未在提示行暴露）」、「按键提示信息与实际绑定对齐（审计 + 补齐 + 统一格式）」）

状态：完成（真机 `dsh --profile fff-probe` 确认通过，2026-10-14）　　开启：2026-10-14　　关闭：2026-10-14
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把「切顶部面板焦点」（活动区 / 历史区 / 状态列循环）从 `Tab` 换到一个专用键，`Tab` 回归「补全 / 面板内切窗」的单一语义，并让新键在底部提示行可见。

边界（不在目标内）：不改面板内 `Tab` 语义（审批面板切窗、问答面板切窗、模型选择面板切列、历史列表切范围）；不改 `focus-panel-cycle` 的循环顺序与「跳过隐藏列」规则；不做按键提示的全面审计与格式统一（那是 `TUI/docs/BACKLOG.md`「按键提示信息与实际绑定对齐」的范围）。

## 调研

### 1. 现状绑定（来源：本仓源码）

- 键位分派：`src/app/index.ts:2644-2654` 的 `case "tab"` —— 补全面板打开时接受默认候选；否则**仅当 `inputText === ""`** 时派发 `focus-panel-cycle`。
- reducer：`src/app/state.ts:2276-2293`，循环 `null → history → activity → status → history`，按 `statusColumnVisible` / `lowerPanesVisible` 跳过隐藏列；**action 无参数**。
- 退出焦点：`Esc` 分支（`src/app/index.ts:2635-2653`）在 idle + 空输入 + 有焦点时把 `focusedPanel` 置回 `null`。
- `Tab` 的其他占用：`layout/hints.ts:27` / `:55` / `:63` / `:93`（历史列表切范围、审批切窗、模型选择切列、问答切窗）。
- 规格文档按「显隐开关」描述这两键：`TUI/docs/SPEC.md:125`（顶部区域构成里写「`Ctrl+S` 切换状态列显隐」）与 `:685`（状态列显隐的 P7 小节，含 reducer 与持久化口径）；`Ctrl+T` 下半区显隐在同章。`/help`（`index.ts:5327-5457`）**只有命令表、没有键表**。
- 显隐状态随会话持久化：`Ctrl+S` / `Ctrl+T` 分支各自调 `scheduleSessionStateSave()`（`index.ts:2575` / `:2584`），写入 `tui-state.json` 的 `statusColumn` 等字段（`adapter/session-ui-state.ts`）——新语义下「隐藏」这一半仍要保持写盘。

### 2. 候选键可用性（来源：本仓实测 + 本机 tmux）

- `Ctrl+H`（0x08，2026-10-14 用户提名用于会话区）：**与 Backspace 同一个字节**，当前栈无法区分 —— `renderer/input.ts:288-290` 把 `0x08` 与 `0x7f` 都解成 `{ name: "backspace" }`（无 `ctrl` 标记，测试 `tests/input.test.ts:118-119` 亦如此断言）；渲染层只用了 DEC 2026 同步输出（`renderer/screen.ts:21-25`），**未启用 kitty 键盘协议**；`stepCsi` 也不认 CSI-u（`CSI 104;5u`）。要真正区分需三件事同时成立：终端支持 + 应用启用 kitty 键盘协议并解析 CSI-u + tmux 转发扩展键（本机 tmux 3.4：`extended-keys [on|off|always]`，**仅在应用主动请求时转发**；另需 WezTerm 侧 `enable_kitty_keyboard`），属输入层新能力（≥1 天，且换终端即退化）。
- `Ctrl+O`（0x0F）：全仓无绑定（`grep 'ctrl && name === "o"'` 零命中）；解码无需新增代码——`renderer/input.ts:293-300` 的 `1..26` 通用分支已把 0x0F 解成 `{ name: "o", ctrl: true }`。
- `Ctrl+T`（0x14）：**已占用**，`src/app/index.ts:2580` 切换下半区显隐 ⟹ 条目里的候选 (b) 作废。
- `Shift+Tab`（`CSI Z`）：`renderer/input.ts:212` 起的 `CSI_LETTERS` 表**没有 `90`（'Z'）表项**，`stepCsi` 对未知终态返回 `undefined` ⟹ 该键当前被整键丢弃；走此路要加表项，且 `CSI Z` 不带参数，通用修饰符解析（`:184-192`）覆盖不到，需单独分支。
- tmux：本机 `tmux list-keys` 中 `C-o` 只出现在 **prefix 表**（`bind-key -T prefix C-o rotate-window`，即需先按前缀键），**裸 `Ctrl+O` 透传给应用**，不被截留。

### 3. 提示行现状（来源：本仓源码 + 实测宽度）

- `HINT_LINE`（`layout/hints.ts:18-19`）当前 **94 显示列**；渲染路径是 `truncateToWidth(hintLine(state), fullWidth)`（`layout.ts:2279`）⟹ **80 列终端下尾部 `[/help]更多命令` 已被截断**（既有问题，归「按键提示信息与实际绑定对齐」）。
- 追加 ` · [Ctrl+O]切换面板焦点` 后为 117 列；即使插到前部，也要先删掉现有键才可能落进 80 列。
- 格式口径：普通输入态用 `[键]文案` + `·`（分隔符两侧各一个空格）分隔（`hints.ts:18-30`）；`commandPanelHint` 是不带方括号的异类。本任务沿用方括号式。

### 4. 受影响用例（来源：本仓测试）

- `tests/app.test.ts:1277`「Tab 占位提示进 UI 缓冲(不影响 sendMessage)」：现依赖空输入下 `Tab` 触发重绘（焦点循环 → `paint`），焦点切换移走后需改写。
- `tests/layout4.test.ts:2376` 断言 `HINT_LINE` 含 `[Alt+Enter]` / `[Ctrl+L]`：若精简该行需同步。
- `tests/layout4.test.ts:2394`、`tests/ctrl-t-panes.test.ts:38`、`tests/status-column.test.ts:515` 直接驱动 reducer `focus-panel-cycle`，与键位无关，预期不动。
- `tests/input.test.ts` 存在，可作为 `CSI Z` 解析用例的落点（仅走决策项 1 的 (c) 时需要）。

### 5. `Ctrl+字母` 占用审计（2026-10-14，用户提问后实测）

| 键 | 字节 | 现状 | 位置 |
| --- | --- | --- | --- |
| `Ctrl+C` | 0x03 | 清空输入；750ms 内再次 = 退出确认 | `index.ts:2618` |
| `Ctrl+D` | 0x04 | idle + 空输入 → 退出确认 | `index.ts:2562` |
| `Ctrl+J` | 0x0A | 输入区插入换行（LF 与 Ctrl+J 同字节） | `index.ts:2610` |
| `Ctrl+L` | 0x0C | 强制整帧重绘 | `index.ts:2604` |
| `Ctrl+N` | 0x0E | 输入历史下一条 | `index.ts:2591` |
| `Ctrl+P` | 0x10 | 输入历史上一条 | `index.ts:2591` |
| `Ctrl+S` | 0x13 | 状态列显隐（本任务改语义为 聚焦 / 收起） | `index.ts:2571` |
| `Ctrl+T` | 0x14 | 下半区显隐（本任务改语义为 聚焦 / 收起） | `index.ts:2580` |
| `Ctrl+Space` | 0x00 | **无独立绑定**：解码为 `space` + ctrl，但消费侧只按 `name` 判 ⟹ 与裸 `Space` 同效 | `input.ts:291`、`index.ts:2297` / `:2369` / `:2504` |

- **无独立解析、不可用**：`Ctrl+H`（= 退格 0x08）、`Ctrl+I`（= Tab 0x09）、`Ctrl+M`（= Enter 0x0D）。
- **空闲且单字节无歧义**：`A B E F G K O Q R U V W X Y Z`。其中 `A E F K U W Y` 是 readline 的输入编辑键（行首 / 行尾 / 前移 / 删至行尾 / 删至行首 / 删词 / 粘贴），建议留给输入区编辑；`Q` 与 `S` 同属流控对（XOFF / XON），`Ctrl+S` 已在用 ⟹ 本应用 raw 模式已关 IXON，`Q` 理论可用（真机需验）；`V` 在 WezTerm / Windows 默认绑粘贴（类 Unix 透传）；`Z` = SUSP（raw 模式关 ISIG，不会挂起）。
- **面板态一律吞键**：审批 / 问答 / 模型选择 / 状态选项 / jobs / 命令面板 / 历史 七个分支在 `index.ts:2201-2560` 内 `return`，其后的全局 `Ctrl+` 分支（`:2562-2630`）只在**普通输入态**生效；picker 的筛选输入显式拒绝带 ctrl 的键（`picker-filter.ts:124`）⟹ **今天面板打开时 `Ctrl+S` / `Ctrl+T` 本来就无效**。

## 决策

### 决策项 1：键位与区域一一对应（2026-10-14 用户口径，取代「专用循环键」方案）

~~(a) `Ctrl+O` / (b) `Ctrl+T` / (c) `Shift+Tab` / (d) `/focus` 命令 / (e) (a) 与 (d) 并存~~ —— 由用户 2026-10-14 给出的设计口径取代：**不做循环键，改为「一键一区域」**。

用户口径要点（原文归纳）：保持键位与区域的对应（`Ctrl+S` = 状态列，`Ctrl+T` = 回合区）；**按一次聚焦该窗口**；**该窗口已聚焦时再按 = 隐藏它并把焦点交回会话区**。

落成规则：

- `Ctrl+S`：`focusedPanel !== "status"` → 显示状态列（若已隐藏）并聚焦；`focusedPanel === "status"` → 隐藏状态列 + 焦点回会话区（`null`）。
- `Ctrl+T`：同上，区域换成回合区（下半区，`lowerPanesVisible` / 焦点值 `"activity"`）。
- 可见但未聚焦时首次按键 = **只聚焦、不隐藏** ⟹ 收起一个可见面板需要两次按键（先聚焦、再按一次收起）。这是该口径的直接后果，已向用户说明。
- 既有 reducer 已在隐藏被聚焦面板时把 `focusedPanel` 清成 `null`（`state.ts:1842-1845`、`:1855-1858`），即「隐藏后回会话区」是既有行为；改动集中在键位分派 + 新增「聚焦指定面板」的 action。
- `Tab` 的焦点循环分支随之删除，`Tab` 回归「补全 / 面板内切窗」单一语义（`Esc` 退出焦点的行为不动）。
- **会话区键：选定 `Ctrl+E`（2026-10-14 用户裁定）**。0x05，`renderer/input.ts:293-300` 的 `1..26` 通用分支已能解码，现无绑定。~~(a1) 保留 `Ctrl+H` 仅空输入生效 / (a2) 上 kitty 协议 + CSI-u / (b) 改用 `Ctrl+O`~~ 三条候选均由本裁定取代。代价：readline 里 `Ctrl+E` = 行尾（输入编辑族），但该族已被用户环境占用一半（见下条），让出 `E` 可接受。
- **外部保留键（用户 2026-10-14 声明，区域键不得使用）**：`Ctrl+A` = screen（screen 默认前缀）、`Ctrl+B` = tmux（tmux 默认前缀）、`Ctrl+F` = herdr（用户自有配置）。⟹ 将来若做输入编辑，行首 / 前移 / 后移三个键位没有可用来源。
- **会话区键第二次按：选定「回到无焦点」（2026-10-14 用户裁定 2a）** —— `focusedPanel = null`（跟随最新），与会话区默认态一致；不采用「再按无操作」。
- **面板态：选定「不放行」（2026-10-14 用户裁定 1a）** —— 维持七个面板分支先吞键的现状（`index.ts:2201-2560` 内 `return`），`Ctrl+S` / `Ctrl+T` / `Ctrl+E` 只在普通输入态生效；不改「面板态吞键」契约。

### 决策项 2：是否保留「输入框为空才生效」

原问题（`Tab` 时代为给补全让位而设的空输入限制）**随决策项 1 失去对象**：`Ctrl+S` / `Ctrl+T` 是控制键，不与补全或打字冲突，不存在「让位」问题。原候选 (a) 取消限制 / (b) 保留限制一并作废。

### 决策项 3：提示行文案与统一格式（2026-10-14 用户口径，取代按宽度取舍的三个候选）

用户口径（原文要点）：

1. **缩写记号**：`Shift` → `S-`、`Ctrl` → `C-`、`Alt` → `A-`（例：`Ctrl+S` → `C-s`、`Alt+Enter` → `A-Enter`），全部提示行统一改用这套记号。
2. **按状态切换显示内容**：空 steer 输入（默认态）→ `C-{d,e,l,n,p,s,t}`；有输入内容 → `C-{c,j}`；**其他面板同样按各自状态只列当前可用键**。
3. **去掉装饰符号**：其他界面的三角符号（问答 / 审批提示行里的 `▶选项` / `▶草稿` / `▶题干`）一并去掉，所有提示行同一格式。

~~(a) 76 列含 `/help` / (b) 72 列保住「打断并发送」 / (c) 80 列贴边~~ 由本口径取代。

**已裁定（2026-10-14 追加）**：

- 提示行**允许 2 行、超宽折行** —— `hints.ts:3-5` 与 `layout.ts` 的「提示区恒占 1 行」契约一并改（面板态收益最大：历史列表现行文案 107 列，今天在 80 列终端被直接截断）。
- **`C-s` / `C-t` / `C-e` 三个区域键均不在提示行露出**（用户 2026-10-14 两次裁定，先撤 `s` / `t`、后补撤 `e`）⟹ BACKLOG 条目的验收 ③「提示行出现该键位」改为「区域键不露出（按用户裁定）」。
- 普通输入态两行文案（宽度实测）：空输入 `[C-d]退出 · [C-l]重绘 · [C-n/p]历史 · [/help]` = 45 列；有输入 `[C-c]清空 · [C-j]换行 · [/help]` = 31 列。

**已裁定（2026-10-14 收尾）**：(1) 键名后**保留短标签**，`/help` **保留**为固定尾巴；(2) 去 `▶` 的范围 = **只清提示行**（`hints.ts:54` 审批、`hints.ts:90` 问答），面板内容里的焦点标记保留 ⟹ `SPEC.md:444` 的规格只需改「提示区前缀」一句。

**统一格式细则（实现口径）**：所有 11 条提示行一律 `[键]短标签` + `·`（分隔符两侧各一个空格）分隔（2 行折行后不再需要省列，取消审批 / 问答的紧凑 `·` 与 `commandPanelHint()` 的无方括号写法）；键名统一 `C-` / `A-` / `S-` 记号与 `Tab` / `Esc` / `↑` / `↓` / `PgUp` / `PgDn` / `Space` / `Enter` 的既有拼写（补全与文件提及行的小写 `[tab]` / `[esc]` 一并改正）。

**提示行现状清单（`src/app/layout/hints.ts`，全部 11 条 + 格式不一致点）**：

| 常量 / 函数 | 现状文案要点 | 问题 |
| --- | --- | --- |
| `HINT_LINE` | `[Alt+Enter]打断并发送 · [Ctrl+L]重绘 · [Ctrl+J]输入换行 · [Ctrl+S]切换状态列 · [/help]更多命令` | 94 列（超 80）；未列 `C-d` / `C-e` / `C-n` / `C-p` / `C-t`；`Ctrl+S` 语义待改 |
| `COMPLETION_HINT_LINE` | `[tab]补全 · [↑/↓]选择 · [esc]收起` | 小写键名 |
| `FILE_MENTION_HINT_LINE` | `[tab]插入 · [↑/↓]选择 · [esc]收起` | 小写键名 |
| `HISTORY_LIST_HINT_LINE` | `[↑/↓]移动 · [Space]标记 · [a]全选 · [c]清空 · [d]删除 · [Tab]范围 · [Enter]切换 · [x]清理空会话 · [Esc]关闭` | 单字母键与 `[Tab]` / `[Esc]` 大小写混排 |
| `HISTORY_VIEW_HINT_LINE` | `[↑/↓]滚动 · [PgUp/PgDn]翻页 · [Esc]返回列表` | — |
| `HISTORY_ERROR_HINT_LINE` | `[Esc]关闭` | — |
| `HISTORY_CONFIRM_HINT_LINE` | `[y/Enter]确认 · [n/Esc]取消` | 斜杠并列两个键 |
| `approvalHintLine()` | `▶草稿·[Enter]提交·[Esc]取消·…`（`·` 无空格） | `▶` 装饰 + 分隔符无空格 |
| `PICKER_HINT_LINE` | `[输入]筛选 · [↑/↓]移动 · [空格]预选 · [Tab]切列 · [Enter]提交 · [Esc]清空/取消` | `[输入]` 不是按键 |
| `JOBS_HINT_LINE` | `[↑/↓]选择 · [PgUp/PgDn]翻页 · [Enter]取消 · [Esc]关闭` | — |
| `statusPanelHintLine()` | `[Enter]提交 · [空格]预选 · [↑/↓]选项 · [Esc]取消` | — |
| `questionHintLine()` | `▶题干·[Enter]下一题·…·[空格/1-9]标记·…`（`·` 无空格） | `▶` 装饰 + 分隔符无空格 |
| `commandPanelHint()` | `↑/↓ 选择 · PgUp/PgDn 翻页 · Enter 详情 · Esc 关闭` | **不用方括号**，与其余全不同 |

`▶` 出现处仅两处：`hints.ts:54`（审批）与 `hints.ts:90`（问答），且与面板内容里的焦点标记同源（`SPEC.md:444`）。

## 规划

### 任务拆分

1. 三项决策经用户裁定（本文件「决策」节补齐选定字母与理由）。
2. 改键位分派与提示行文案。
3. 补 / 改用例。
4. `npm run check` + `npm run build` + `npm run test:tui`。
5. 真机 `dsh --profile fff`（含 tmux 环境）人工确认循环切格与闭合。

### 计划改动文件清单

与决策无关（固定）：

- `TUI/src/app/index.ts` —— 重写 `Ctrl+S` / `Ctrl+T` 分支（聚焦 / 收起两态），删除 `case "tab"` 的焦点分支，补全面板打开时的优先级不变。
- `TUI/src/app/state.ts` —— 新增「聚焦指定面板」action（含目标隐藏时一并显示）。
- `TUI/src/app/layout/hints.ts` —— **全量重写提示行**（决策项 3 的记号 / 状态切换 / 去 `▶` / 统一分隔符），含 `hintLine()` 的分支口径。
- `TUI/tests/app.test.ts` —— 改写「Tab 占位提示」用例（`:1277`，现依赖空输入下 `Tab` 触发重绘）+ 新增 `Ctrl+S` / `Ctrl+T` / `Ctrl+E` 三态用例（未聚焦→聚焦、已聚焦→收起、隐藏→显示并聚焦、会话区再按回无焦点）。
- `TUI/tests/layout.test.ts` —— 提示行断言（现值断言与 `hintLine(state)` 分派断言）。
- `TUI/tests/layout4.test.ts` —— `HINT_LINE` 内容断言（`:2376` 断言含 `[Alt+Enter]` / `[Ctrl+L]`，改动后需同步）。
- `TUI/tests/focus-frame.test.ts` —— `:244` 用 `truncateToWidth(PICKER_HINT_LINE, 60)` 断言帧行，提示行改动后需同步。
- `TUI/docs/SPEC.md` —— 按键规格：`Ctrl+S` 条目（`:125`、`:685` 的 P7 小节）与 `Ctrl+T`（下半区显隐）改为「聚焦 / 收起」语义。
- `TUI/docs/BACKLOG.md` —— 条目状态（本回合标〔进行中〕；完成时标完成并清理移除）。
- `TUI/docs/implementation/2026-10-14-focus-panel-key.md` —— 本文件。

按决策分支：

- 会话区配键（决策项 1 待裁定项）时：同上的 `index.ts` / `state.ts` / `hints.ts` 落点内完成，不新增文件。
- `TUI/docs/COMMANDS.md` / `COMMANDS-SPEC.md`：原方案 (d) 的 `/focus` 命令随决策项 1 作废 ⟹ **本任务不动这两份文件**（不新增命令面）。

### 途中新增条目（不属本任务范围）

- `TUI/docs/BACKLOG.md`「『打断并发送』改为独立的输入模式（`!` 开头）」（2026-10-14 用户要求，登记时明确**现在不做**）：本任务只登记，不实现。

### 明确不做

- 不做按键提示的全面审计、键表统一与格式收口（`TUI/docs/BACKLOG.md`「按键提示信息与实际绑定对齐」）。
- 不改面板内 `Tab` 语义与 `focus-panel-cycle` 的循环顺序 / 跳过隐藏列规则。
- 不改 `Esc` 退出焦点的行为。

## 实现记录

### 代码（2026-10-14）

1. `src/app/state.ts`
   - 新增 `export type PanelId = "history" | "activity" | "status"`（取代 `PANEL_CYCLE` 常量与 `focus-panel-cycle` action）。
   - 新增 reducer 分支 `focus-panel{panel}`：`history` → 未聚焦则聚焦、已聚焦则回 `null`（会话区恒显示）；`status` / `activity` → 按「可见 && 已聚焦」判收起（`statusColumnVisible` / `lowerPanesVisible` 置 false + 焦点回 `null`），否则显示并聚焦。可见性参与判据，故「收起态再按」= 重新显示并聚焦（不回退成收起）。
   - `focusedPanel` 字段类型改用 `PanelId | null`；`status-column` / `lower-panes` 的注释改为「显式设值，供恢复回灌」。
2. `src/app/index.ts`
   - `Ctrl+S` / `Ctrl+T` 分支改派 `focus-panel`（仍各自 `scheduleSessionStateSave()`，收起态要写盘）。
   - 新增 `Ctrl+E` 分支 → `focus-panel{panel:"history"}`（无显隐可写盘，不触发保存）。
   - `case "tab"` 删除焦点循环分支，只保留「补全候选打开时接受候选」；`Esc` 退出焦点的注释同步。
3. `src/app/layout/hints.ts` — 全量重写（统一格式与状态切换）
   - `HINT_LINE`（空输入）改 `[C-d]退出 · [C-l]重绘 · [C-n/p]历史 · [/help]`（45 列）；新增 `HINT_LINE_WITH_INPUT` = `[C-c]清空 · [C-j]换行 · [/help]`（31 列）；`hintLine()` 尾部按 `inputText` 二选一。
   - 记号统一 `C-` / `A-` / `S-`；键名统一 `Tab` / `Esc` / `Space` / `Enter` / `↑` / `↓` / `PgUp` / `PgDn`（原小写 `[tab]` / `[esc]` 改正）。
   - 分隔符统一 `·`；审批 / 问答提示行去掉 `▶` 前缀；`commandPanelHint()` 改用方括号（`[Enter]详情` / `[Enter]中断` / `[r]刷新`）。
   - 问答提示把 `[空格/1-9]标记` 拆成 `[Space]标记` + `[1-9]标记`（斜杠并列键减少一处）；历史列表提示保持 9 段（86 列 → 折 2 行）。
   - 区域键 `C-e` / `C-t` / `C-s` **不在提示行露出**（用户裁定）。
4. `src/app/layout.ts` — 提示区 1 至 2 行动态高
   - 新增 `wrapHintLine(text, width, maxRows=2)`：按 `·` 边界贪心折行（键位与标签不拆开；单条目超宽才硬折；超 2 行截断——极窄终端不吞正文）与 `hintRowsFor(state, width)`。
   - `frameGeometry` 以 `hintRowsFor(state, cols)` 定提示区行数（footer = 交互区 − 提示行数，交互区总高仍恒定）；`buildFrame` 用 `wrapHintLine` 出行（不再截断）。
5. 文档：`docs/SPEC.md`（125 / 445 / 456 / 606 / 607 / 619 / 685 / 687 / 706）、`docs/DESIGN.md`（175 / 440）同步为「聚焦 / 收起两态 + 提示区 1 至 2 行 + 提示行统一格式」。

### 测试（2026-10-14）

- 改写 / 新增：`tests/layout4.test.ts`（`focus-panel` 三态用例全套 + hint 两态断言 + 提示区行数按几何反推）、`tests/ctrl-t-panes.test.ts`（收起 / 重新显示两态）、`tests/title-bar.test.ts`（Ctrl+S 两态 + 收起后列宽 0）、`tests/status-column-agents.test.ts`（按两次 Ctrl+S 才停轮询）、`tests/app.test.ts`（审批 / 问答提示断言、Esc / Ctrl+E 焦点、Tab 不再有全局语义）、`tests/question-window.test.ts`（焦点窗靠提示键位文案 + 焦点条）、`tests/layout.test.ts`、`tests/command-panel*.test.ts`、`tests/session-delete.test.ts`、`tests/color-semantics.test.ts`、`tests/pane-titles.test.ts`、`tests/layout-horizontal.test.ts`、`tests/status-column.test.ts`、`tests/small-terminal-warning.test.ts`。
- 新增测试辅助 `tests/helpers/focusFrameScenes.ts`：`focus-frame` 对照与冻结脚本共用的场景构造（唯一来源，见「偏差」2）。
- `tests/focus-frame.test.ts`：`stateFor` 改用共享辅助（修掉对 `focus-null` 用错 action 的缺陷）；`panel-picker@w60` 的「豁免行 + 专用断言」机制取消（该形态已随重冻进入基线），改为常规用例断言输入区 2 行 + 提示折 2 行。

## 偏差

1. **`▶` 焦点窗文字标记在实现里并不存在**。决策项 3 收官裁定写「去 `▶` 的范围 = 只清提示行（原 `hints.ts:54` 审批、`hints.ts:90` 问答），面板内容里的焦点标记保留」——实测 `src/app/components/**` 全无 `▶`：面板内的焦点窗指示是**左侧 1 列焦点条 / 滚动条滑块着色**（`ApprovalPrompt.ts:144`、`QuestionPrompt.ts:182`），`▶` 只出现在那两行提示文案里。故按字面执行「清提示行」后，`▶` 在本仓已无任何出现点（`docs/SPEC.md:445` / `:456` 与 `DESIGN.md` 的旧描述属**规格与实现本就不一致**，本次一并按实现改写）。**若要恢复文字级焦点窗标记，需新增渲染（超出本任务范围），待用户裁定。**
2. **`tests/fixtures/focus-frame-legacy.json` 已重冻**（15 场景）。原因：提示行文案与提示区行数都变了，且原冻结脚本的内容构造停在「内容不进 pipeline」的旧写法（脚本产出与测试断言的 state 不一致，`focus-null` 甚至用了已删除的 action），基线已不可信。做法：抽出 `tests/helpers/focusFrameScenes.ts` 让脚本与测试**共用**同一份场景构造后重冻，消除「双处各写一份」的错位根因；重冻记录写在脚本头部注释。`panel-picker@w60` 提示折 2 行 ⟹ 输入区由 3 行缩为 2 行（交互区总高恒 4 行），该场景已改为常规用例。
3. **真机验证走独立测试 profile**（用户裁定：新建测试用 profile，测完清理）。`dsh --profile fff` 的 profile **软链到主仓** `/home/guochang/Projects/dsh-toolset/TUI`（非本 worktree），本 worktree 又无 `node_modules` ⟹ 直接 build 会落到主仓。做法：`TUI/node_modules` 软链到主仓依赖 → `npm run build` 产出 worktree `dist/`；再建 `~/.dsh/profiles/fff-probe`（从 `fff` 复制 profile 配置，`@dsh-toolset/tui` 的 `link:` 指向本 worktree，其余包沿用主仓；`pnpm install --offline` 复用本机 store，46ms 完成），`dsh --profile fff-probe --dump-config` 组合树正常。验证结果见「测试与证据」，**profile 用后即删**（未动 `fff`）。
4. 提示行宽度实测与决策记录一致：空输入 45 列 / 有输入 31 列；历史列表 86 列（80 列终端折 2 行，第二行 20 列）；选择面板 63 列（60 列终端折 2 行）。
5. `TUI/docs/BACKLOG.md` 条目 #5「按键提示信息与实际绑定对齐」**未关闭**：本任务按用户口径改了「格式 + 状态切换 + 去装饰」，但该条目的核心诉求（绑定 ↔ 提示逐项对照审计、缺项补齐、`/help` 键表口径）仍在范围外（见本文件「明确不做」），条目保留。

## 测试与证据

- `npx tsc -p tsconfig.json --noEmit`（worktree 内以主仓 `TUI/node_modules/.bin/tsc` 执行）：**0 错误**。
- `node --experimental-transform-types --test tests/*.test.ts`：**tests 1584 / pass 1584 / fail 0**（约 7.5s；改动前同口径全绿，用于对比无回归）。
- `node --experimental-transform-types scripts/freeze-focus-frame.mts`：`frozen 15 scenes`（重冻后 `tests/focus-frame.test.ts` 17 用例全绿）。
- 提示折行实测（`tmp/wrap-probe.mts`，已清理）：200 / 100 列 1 行；80 列历史列表 2 行；60 列选择面板 2 行；40 / 16 列按条目折行且不超宽。
- **真机验证（2026-10-14，`dsh --profile fff-probe` 于 tmux 3.4 / 100x30 窗口）**：
  - 初始帧：状态列 + Session/Turn 两 pane 正常，提示区末行 = `[C-d]退出 · [C-l]重绘 · [C-n/p]历史 · [/help]`（**区域键未露出**，符合裁定）。
  - `Ctrl+T` 第一次：`┬── Turn ──` 段转焦点色 `159;238;250`，而 `├── Session ──` 保持边框色 `90;152;243` ⟹ 只聚焦回合区、不隐藏。
  - `Ctrl+T` 第二次：Turn 标题整段消失、Session 顶边铺满整宽 ⟹ 收起生效且焦点回会话区。
  - `Ctrl+S` 第一次：状态列第一列出现焦点色竖线 ⟹ 聚焦状态列（未收起）。
  - `Ctrl+S` 第二次：左缘框格列整列消失（`cat -A` 该行只剩 `$`）⟹ 收起后列宽 0。
  - `Ctrl+S` 第三次：状态列重新出现且第一列为焦点色 ⟹ 收起态再按 = 重新显示并聚焦（未回退成收起）。
  - `Ctrl+E`：`├── Session ──` 转焦点色 ⟹ 聚焦会话区。
  - `Ctrl+T`（收起态下）：Session / Turn 两 pane 回到初始布局 ⟹ 重新显示并聚焦。
  - `Tab`：画面逐行不变（对照 `sed -n '2p'`）⟹ Tab 已无全局焦点语义。
  - 清理：`tmux kill-session -t probe`；`rm -rf ~/.dsh/profiles/fff-probe`（`fff` 未改动）。

## 收尾

- 追踪文档归档：`TUI/docs/archived/2026-10-14-focus-panel-key.md`（本文件）。
- `TUI/docs/BACKLOG.md`：条目「切换顶部面板焦点的快捷键重做」已从清单移除（完成）；「按键提示信息与实际绑定对齐」保留（格式统一部分已完成，审计与 `/help` 键表口径未做，理由见「偏差」5）。
- 收尾清理：测试 profile `~/.dsh/profiles/fff-probe` 已删除、tmux 探针会话已关闭、worktree `tmp/` 下的临时探针脚本已删除；`~/.dsh/profiles/fff` 未作任何改动。
- 关闭后无残留相关变更（本文件移入 `archived/` 即最后一次文档变更）。
