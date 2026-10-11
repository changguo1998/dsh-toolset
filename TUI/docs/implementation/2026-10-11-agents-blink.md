# 状态列 Agents 块开头符号加闪烁（接取条目：`TUI/docs/BACKLOG.md` 第 1 条）

状态：进行中（接取与裁定完成，实现待接续）　　开启：2026-10-11　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

状态列 Agents 块在**有子代理运行**时, 块标题前导符号闪烁; 空闲/异常/非 TTY 时不闪或静态。

## 调研（现状，行号来自条目原文）

- 状态列 Agents 块 = 标题行 `Agents 运行中/总数`（蓝、**无前导符号**, `layout.ts:1320-1337`）+ 条目行 `● 别名 · 工作摘要`（`agentItemRows`, `layout.ts:1097-1112`：运行中 `● ` 黄 / 空闲 `○ ` 灰 / 异常 `! ` 红）。
- 现有时间驱动：`virt-tick`（250 ms, `index.ts:157,596`）与 `RunVirtState` 的渐进降频（`layout.ts:2269,2378`）。

## 接取裁定（①-⑥）

1. **闪哪一处**：**块标题前新增前导符号**（`● Agents 1/2`），不闪条目行的 `●`——条目行符号语义固定（运行/空闲/异常），动它会削弱状态信息；标题前导符号专职表达「有子代理在跑」。
1. **频率与占空比**：复用现有 **250 ms `virt-tick`** 相位，**50% 占空比**（相位偶数显示、奇数显示等宽空白）。不引入新的定时器，也不套用 `RunVirtState` 的渐进降频（那套表达的是「跑得久 → 变慢」，与「有没有在跑」无关）。
1. **谁闪**：**仅「有运行中子代理」时闪**；空闲不显示前导符号（标题回到现状形制）；异常（`diagnostic`）**常亮红** `!` 前缀，不闪——异常需要的是被看见，不是节奏。
1. **降级**：非 TTY、`NO_COLOR`、tick 未启动（如 demo / 一次性出帧的测试与嵌入用法）→ **静态显示** `●`（常亮）。缺省即静态，闪烁只在宿主明确提供相位时发生。
1. **tick 启动条件**：在现有 tick 的启动判据（`inputStatus=running`）之外**并上「有运行中子代理」**（`index.ts:594-600,932-940`）；tick 停的条件对称——两者都不成立才停。
1. **折叠层级（L1/L2）**：**保留闪烁**。折叠影响的是条目行与摘要，前导符号是块级指示，折起来更该看得见。

## 规划改动文件清单

- `TUI/src/app/layout.ts`：`statusBlocks` / agents 块标题行支持「前导符号 + 相位」；新增纯函数 `agentHeadSymbol(agents, phase)`（返回 `{ text, fg }`）便于单测。
- `TUI/src/app/index.ts`：tick 启动/停止判据并上「有运行中子代理」；把相位传给 `buildFrame`。
- `TUI/tests/`：帧断言（同 state 两相位 → 符号不同；空闲 → 无前导符号；异常 → 常亮 `!`；无相位 → 静态 `●`）；既有 Agents / 折叠用例不回归。

## 实现记录

### 锚点核对（2026-10-11 第 17 轮：条目里的行号已漂移，以本节为准）

| 目标 | 真实位置 |
| --- | --- |
| 状态列块构建（标题行 + 条目行） | `layout.ts` 的 `statusBlocks(...)`（定义 `:901`，调用 `:1164`） |
| Agents 条目行 | `layout.ts:870 agentItemRows(a, width)`（调用点 `:1034 rows: agentItemRows(a, width)`） |
| Agents 块标题行 | 同 `:1034` 附近的块组装处（`Agents 运行中/总数` 文本，非原条目写的 `:1320-1337`） |
| 定时器 | `index.ts:826-828`：`this.virtTimer = setInterval(() => this.virtTick(), VIRT_TICK_MS)`（250 ms，始终存在） |
| **相位门**（要改的判据） | `index.ts:1167-1171 virtTick()`：「仅 `inputStatus=running` 时推进」 |
| 相位载体 | `RunVirtState`（`state.ts:595` 字段 `runVirt`；`emptyRunVirt()` 见 `:767`） |

### 相位来源（裁定 ②/④ 的落地口径）

**不再新增 state 字段**：直接把 `state.runVirt` 的累计 tick 当相位（`phaseOn = ticks % 2 === 0`）——

- 裁定 ④ 自动成立：tick 没推进（demo / 一次性出帧 / 非 TTY）时相位恒为 0 → 静态 `●`；
- 裁定 ② 的 50% 占空比随之成立（每 250 ms 交替）；
- 裁定 ⑤ 只需改 `virtTick()` 的门：`inputStatus === "running" || agents 有运行中` 才推进。

### 第 18 轮实测更正（重要）

`buildFrame` **不直接调用** `renderStatusColumn`：全仓只有一处调用，在 `layout.ts:1400`（三元表达式里，
位于 `buildFrame` 定义 `:2409` **之前**的另一函数内）。所以相位要**先透到 `:1400` 那个函数**（它手上是否有
`state` 需先确认，见 `layout.ts:1390-1410`），再传给 `renderStatusColumn` 的可选参数。
第 18 轮曾把相位直接写在 `renderStatusColumn` 体内的 `state.runVirt.tokens`（编译报 `state` 未定义）→ 已 `git checkout` 回退，仓库保持全绿。

### 待做（下一轮照此实现，2-3 次编辑）

1. `layout.ts`：Agents 块标题行支持前导符号——新增纯函数 `agentHeadSymbol(agents, phase)`（返回 `{ text: "● " | "  " | "! ", fg }`），`statusBlocks` 调用处传入相位；折叠层级不动它。
1. `index.ts`：`virtTick()` 的门并上「有运行中子代理」（agents 数据来自 `state.agents`，与状态列同源）。
1. 帧断言：同 state 两相位 → 标题前导符号不同；无运行中 → 无前导符号；异常 → 常亮 `!`；相位 0 → 静态 `●`。）

## 测试与证据

（待补）

## 审阅记录

（待补）

## 收尾

（待补）
