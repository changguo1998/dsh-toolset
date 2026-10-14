# 切换顶部面板焦点的快捷键重做（接取条目：TUI/docs/BACKLOG.md「切换顶部面板焦点的快捷键重做（`Tab` 与补全挤在一起, 且从未在提示行暴露）」、「按键提示信息与实际绑定对齐（审计 + 补齐 + 统一格式）」）

状态：决策　　开启：2026-10-14　　关闭：
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

（待补）

## 偏差

（待补）

## 测试与证据

（待补）

## 收尾

（待补）
