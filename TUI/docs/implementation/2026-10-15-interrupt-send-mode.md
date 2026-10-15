# 「打断并发送」改为独立输入模式（`!`）+ Esc 取消打断（接取条目：TUI/docs/BACKLOG.md「『打断并发送』改为独立的输入模式（`!` 开头）」；「Esc 取消打断，打断统一由 `!` 模式承担」）

状态：决策　　开启：2026-10-15　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. 「打断并发送」从无模式快捷键（`Alt+Enter`）改为**第五种输入模式**：输入框为空时按 `!` 进入（与 `$` / `/` / `<` 同构——提示符切 `!`、`!` 被吞、空输入 Backspace 回退 `>`、任何提交后回退 `>`）；该模式下 `Enter` 提交 = **打断当前运行并发送输入内容**。
2. **打断的唯一入口收敛到 `!` 模式**：`Esc` 不再打断，`Alt+Enter` 不再有独立语义。
3. 该模式下**空输入提交 = 只打断**（忙时；不发送）。

## 调研

（来源：本仓代码 + 既有用例；行号为接取时（2026-10-15）的工作区版本）

- **输入模式现状**：`InputMode = "steer" | "followup" | "shell" | "slash"`（`src/app/state.ts:87`），初值 `inputMode: "steer"`（`:810`）；空输入按 `$` / `/` / `<` 切模式并吞键，注释明确记着「`!` 为普通字符」（`src/app/index.ts:2908-2921`）；空输入 Backspace 回退 `steer`（`:2877-2885`）；提交后各分支各自回退 `steer`。`InputHistoryEntry` 保存提交时的模式（`state.ts:95-99`、`:2782-2800`）——新模式自动随 `Ctrl+P` 回溯恢复。
- **提示符**：`MODE_SYMBOL: Record<InputMode, string>`（`src/app/layout.ts:1941`，渲染处 `:2310-2316`）。类型是 `Record<InputMode, …>`，增成员时 TS 直接暴露缺口。
- **类型联动面**：`src/app/commands.ts:375` 的 `InputModeLike` 与 `completeCommandInput(text, mode)`（`:397`）由 `recomputeCompletion`（`state.ts:2792`）传入状态里的模式 —— 不同步会编译失败（可编译期捕获）。
- **「打断并发送」现状**：只会由 `Alt+Enter` 触发 —— 解码层把 `ESC CR` / `ESC LF` 合并成单键 `meta+enter`（`src/renderer/input.ts:112-117`），`case "enter"` 按 `k.meta` 分流（`src/app/index.ts:2886-2887`），`submit(interrupt = true)` 的分支（`:3307-3320`）：先 `restoreQueued()`（排队登记按提交顺序并回输入框），再 `adapter.interrupt()`，然后**直发**（`sendUserText(text, text, undefined)`，不带 `next-step`）。空输入且无排队登记时是 no-op（`:3309-3310`）。
- **Esc 现状**（`index.ts:2835-2856`）：补全候选打开时只收候选；否则先 `restoreQueued()`，再 `agentStatus !== "idle"` 时 `adapter.interrupt()`，否则「输入为空 + 有面板焦点」时清焦点。既有用例断言「排队消息 Esc：退回输入框 + 清登记 + 打断」（`tests/app.test.ts:1064-1095`）与「Esc 打断运行」（`:553-560`）。
- **`interrupt()` 的宿主落点**：`adapter/dsh.ts:3290-3292` → `activeCancel?.()` = `rawAgent.cancel({ kind: "user" })`（赋值处 `:4212` / `:4272`）。既有注释说明「核心 `cancel` 会清自己的队列」（`index.ts:2837-2840`）——这正是 Esc / `Alt+Enter` 必须先 `restoreQueued()` 的原因。
- **宿主无「撤销单条队列项」接口**：队列观测面只有 `agent/inbox/*` 事件（`docs/host/DSH-CTX-API.md:63`、`:100`）；适配层对 `agent/inbox/spliced` 只做观测与 `inbox-claim`（`adapter/dsh.ts:2199-2213`）。要撤销单条只能靠 cancel 清空整个 `next-turn` 队列。
- **忙碌判定**：`agentBusy()`（`index.ts:3282-3288`）= `agentStatus !== "idle"` 或本地 `inputStatus === "running"` 或 `isCompacting(state)`（压缩期间算忙，`DESIGN.md:406`）。
- **既有断言与文档面**：`tests/app.test.ts:807-825`（Alt+Enter 先 interrupt 再直发）、`:1116-1135`（Alt+Enter 空输入 no-op）、`:1136+`（**非空输入**时 `!` / `$` / `/` 为普通字符）、`tests/steer-mode.test.ts:120-140`（Alt+Enter 在恰两种模式下都打断）、`tests/input.test.ts:78-94`（解码层合并，**本任务不动**）；文档 `TUI/README.md:157` / `:170-171` / `:318`、`TUI/docs/DESIGN.md:183` / `:186` / `:406` / `:458-459`。`TUI/docs/SPEC.md` 与 `TUI/docs/COMMANDS.md` 无输入模式 / Esc 打断条目（grep 确认）。

## 决策

1. **入口去留**：a) `Alt+Enter` 与 `!` 模式并存　b) 移除 `Alt+Enter`，只留 `!` 模式　→ **选定 b**（用户 2026-10-15 裁定「移除，只留 `!` 模式」）。打断入口唯一，语义不再分叉。
   1.1 **移除方式**：a) 解码层不再合并 `ESC CR` / `ESC LF`，App 侧删掉 meta 分支　b) 解码层不动（仍合并为单个 `meta+enter`），App 侧 `case "enter"` 忽略 `meta`　→ **选定 b**。理由：删合并后 `ESC CR` 会退化成「独立 `Esc` + `Enter`」两个事件 —— 而 Esc 在本任务后仍负责「关补全候选 / 清面板焦点」，等于给 `Alt+Enter` 附带一个与「发送」无关的副作用；且解码层用例（`tests/input.test.ts:78-94`）与本任务无关，不动更稳。
   1.2 **移除后 `Alt+Enter` 的落点**：a) 等效普通 `Enter`（忙时排队 / 空闲直发）　b) 吞掉、无操作　→ **选定 a**：按键不「失灵」，与「终端里 Alt+Enter 常被当作 Enter」的直觉一致，也避免用户以为输入没生效。
2. **`interrupt` 的触发条件**：a) 无条件调用（沿用 `Alt+Enter` 现状）　b) 仅 `agentBusy()` 时调用，空闲直发　→ **选定 b**（用户裁定「两条路径统一：忙时才 interrupt，空闲直发」）。理由：空闲时没有可打断的回合，而 `interrupt()` 落到宿主是 cancel，会连带清空核心 `next-turn` 队列 —— 空闲不该有这个副作用。
3. **`!` 模式空输入提交**：a) no-op（与现状 `Alt+Enter` 空输入一致）　b) 只打断（忙时打断，空闲 no-op）　c) 打断并发送空串　→ **选定 b**（用户 2026-10-15 补充要求「`!` + 空输入提交 → 打断」；c 无意义）。
   3.1 **空输入但有排队登记时**：a) 先 `restoreQueued()` 并入输入（并入后即非空）→ 走「打断并发送」　b) 只打断、放弃登记　→ **选定 a**：打断会清空核心队列，不并入就是静默丢用户输入（沿用 `index.ts:3291-3294` 的既有理由）。
4. **行首字面量 `!`**（如想让模型看到 `!ls`）：a) 与 `$` / `/` / `<` 同口径 —— 空输入按 `!` 即切模式并吞键，非空输入里 `!` 仍是普通字符，行首字面 `!` 只能靠粘贴　b) 双击 `!` 插入字面量（新模式专属特例）　→ **选定 a**（用户裁定）。零新增机制，五种模式键行为一致。
5. **Esc 的连带语义**：a) 保留打断 + 退回排队（现状）　b) 取消打断，且不再接管排队（只保留「关补全候选 / 清面板焦点 / 面板自有语义」）　c) 取消打断但保留退回排队　→ **选定 b**（用户 2026-10-15 要求取消 Esc 打断；连带的排队问题由用户裁定「Esc 不再接管排队」）。理由：宿主无「撤销单条队列项」接口（见调研），若仍退回，同一条消息会既留在核心 `next-turn` 队列又在输入框，下一回合重复发送。
6. **命名与符号**：`InputMode` 增 `"interrupt"`，`MODE_SYMBOL.interrupt = "!"`。不叫 `break` / `stop`：与提示行旧文案「打断并发送」同词，语义自解释。
7. **提示行是否露出 `!`**：a) 不改（`$` / `/` / `<` 现在也都不露出；「哪些键进提示行」正由待办「按键提示信息与实际绑定对齐」统一裁定）　b) 在空输入提示行加 `[!]打断并发送`　→ **选定 a**，避免与本任务无关的提示行口径冲突。

## 规划

任务拆分：

1. 代码：`InputMode` 增 `"interrupt"` + 模式键 `!` + 提示符 `!`（含类型联动面）。
2. 代码：`submit()` 改写 —— `interrupt` 来源由 `meta` 改为「当前模式 = `interrupt`」；空输入提交走「只打断」；`interrupt` 仅在 `agentBusy()` 时下发。
3. 代码：`case "escape"` 去掉 `restoreQueued()` 与 `interrupt()`（保留补全收起与清面板焦点）。
4. 测试：`!` 模式专门用例（新建 `tests/interrupt-mode.test.ts`）+ 既有 Alt+Enter / Esc 用例改写。
5. 文档：`README.md`（模式表、按键表、排队段）、`DESIGN.md`（输入区、排队段、压缩期间口径）。
6. 真机确认（`dsh --profile fff`）：`!` 提示符、忙时 `!` + Enter 打断并发送、`!` 空输入只打断、Esc 不打断、Alt+Enter 等效 Enter。

**计划改动文件清单**（清单外一律不改）：

- 代码：`TUI/src/app/state.ts`（`InputMode` 增 `"interrupt"` + 注释）、`TUI/src/app/index.ts`（模式键白名单、`case "enter"`、`case "escape"`、`submit()`、相关注释）、`TUI/src/app/layout.ts`（`MODE_SYMBOL`）、`TUI/src/app/commands.ts`（`InputModeLike`）。
- 测试：`TUI/tests/interrupt-mode.test.ts`（新建）、`TUI/tests/app.test.ts`（Alt+Enter 两例 → `!` 模式语义；Esc 两例 → 不打断、不退回）、`TUI/tests/steer-mode.test.ts`（两处 Alt+Enter 用例迁到 `!` 模式）、必要时 `TUI/tests/input-history.test.ts`（模式回溯含 `interrupt`）。
- 文档：`TUI/README.md`、`TUI/docs/DESIGN.md`、`TUI/docs/BACKLOG.md`（本步：两条条目状态）、本追踪文档。

**验收**：

1. 空输入按 `!` → 提示符 `! `、`!` 被吞；再按 `!` 幂等；Backspace 回退 `>`；提交后回退 `>`。
2. 忙时 `!` 模式 Enter（有文本）→ 先 `interrupt()` 一次、再直发（不带 `next-step`）；排队登记按提交顺序并入本次发送。
3. 空闲 `!` 模式 Enter（有文本）→ 直发，`interrupts === 0`。
4. `!` 模式空输入 Enter：忙 → `interrupts === 1` 且不发送；空闲 → 无操作（`interrupts === 0`、未发送）。
5. 非空输入里 `!` 仍是普通字符；`Ctrl+P` 回溯到 `!` 模式提交的条目时模式一并恢复。
6. Esc：忙时按 Esc → `interrupts === 0`，排队登记既不退回也不清空；补全候选打开时仍只收候选；面板态语义不变。
7. `Alt+Enter`（`meta+enter`）→ 与普通 Enter 等效：忙时进排队、空闲直发，不再打断。
8. `npm run check` + `npm run build` + TUI 全量 `npm test` 全绿。
9. 真机 `dsh --profile fff` 目视：`!` 提示符切换、运行中 `!` + Enter 打断并发送、`!` 空输入只打断、Esc 不再打断、Alt+Enter 不再打断。

**明确不做**：

- 不改 `TUI/src/renderer/input.ts`（保留 `ESC CR` / `ESC LF` → `meta+enter` 合并，见决策 1.1）。
- 不改提示行文案（`TUI/src/app/layout/hints.ts`，见决策 7）。
- 不改 `TUI/docs/SPEC.md`（无输入模式章节）、`TUI/docs/COMMANDS.md`（无 Esc 打断条目）。
- 不改排队登记的类型与渲染（`queued.kind = "followup" | "steer"` 是**投递类型**、不是输入模式）。
- 不改其它面板的 Esc 语义（审批 / 问答 / 模型选择 / 状态选项 / 历史会话 / `/jobs` / 退出确认）。
- 不改 `TUI/docs/STATUS.md`（用户择时更新）。

## 实现记录

- `src/app/state.ts`：`InputMode` 增 `"interrupt"`；类型注释写明「打断唯一入口」与 Esc / Alt+Enter 口径。
- `src/app/layout.ts`：`MODE_SYMBOL` 增 `interrupt: "!"`（`Record<InputMode, string>` 逼出该落点）。
- `src/app/commands.ts`：`InputModeLike` 增 `"interrupt"`（`recomputeCompletion` 传状态里的模式，不同步会编译失败）。
- `src/app/index.ts`：
  - 模式键白名单加 `!`（空输入切 `interrupt` 并吞键、同符号幂等；Backspace 回退与提交回退沿用既有分支）；
  - `case "enter"` 改为 `this.submit(this.state.inputMode === "interrupt")` —— 不再读 `k.meta`（Alt+Enter 等效普通 Enter；解码层按决策 1.1 不动）；
  - `case "escape"` 删掉 `restoreQueued()` 与 `interrupt()`，保留「补全候选收起」与「`agentStatus === "idle"` + 空输入 + 有面板焦点 → 清焦点」（与旧 `else if` 分支等价）；
  - `submit()`：空输入分支改为「`interrupt` 且 `agentBusy()` → 只打断，其余 no-op」；`interrupt` 分支的 `adapter.interrupt()` 加 `agentBusy()` 门（空闲直发不误触宿主 cancel）；`restoreQueued()` 文档注释与「Alt+Enter」措辞同步为 `!` 模式口径。
- 测试：新增 `tests/interrupt-mode.test.ts`（6 例：进入模式与提示符 / 幂等 / 非空输入里 `!` 为普通字符 / Backspace 与提交后回退 / 空闲直发 / 忙时打断后直发 / 历史回溯恢复模式）；
  `tests/app.test.ts` 改写 6 处（Esc 不打断、排队消息 Esc 不退回、模式键含 `!`、`!` 模式打断并发送、`!` 连带排队并入、`!` 空输入 + Alt+Enter 等效 Enter）；
  `tests/steer-mode.test.ts` 1 处（原「Alt+Enter 两种模式都打断」→「`!` 模式从默认与 `<` 前置态进入都打断直发」）；
  `tests/app.test.ts`「本地 slash 分级」的非法命令由 `/!` 改 `/1`（`!` 已成模式键会被吞；`/1` 仍走本地 `无效命令` 分支）。
- 冒烟（计划外但必需）：`demo/main.ts` 步骤 2 改「`!` 模式空闲直发 `hello`」、步骤 5 改「忙时 `!` 模式打断并发送 `rm tmp`」并加 5b「Alt+Enter 空输入 no-op」，断言标签 `dash-ordinary` → `interrupt-mode-send`、`alt-enter-send` → `interrupt-mode-send-busy`，两处 userblock 正则的 `!hello` → `hello`，文件头注释同步；`demo/mockAdapter.ts` 的 mock `/help` 文案同步。
- 文档：`README.md`（布局示意图提示行、排队段、输入模式段、提示区段、按键表 Backspace / Enter / Alt+Enter / Esc 四行）；`DESIGN.md`（输入区模式表 + 新增「打断入口」条、两处压缩期口径、排队段末尾的 `!` 模式 / Esc 条与回归清单）。

## 偏差

- **计划外文件 2 个（必需：均为断言旧行为的既有测试 / 演示面）**：`TUI/demo/main.ts`、`TUI/demo/mockAdapter.ts` —— 不改则 `npm run demo -- --smoke` 红（实测 `SMOKE_FAIL n=3`：`dash-ordinary` / `interrupt-exactly-once` / `question-esck-no-interrupt`）。
- `TUI/docs/SPEC.md` 未改：确认其无输入模式 / 按键表章节（与计划一致）。
- **真机 `dsh --profile fff` 未做**：该 profile 的 `@dsh-toolset/tui` 是 `link:/home/guochang/Projects/dsh-toolset/TUI`（**主工作区**，不是本 worktree），合并前本分支代码不经该 profile 生效。本地以 `npm run demo -- --smoke` + 全量单测替代；真机确认待用户裁定（临时改 profile 链接 / 合并后再验）。
- 本 worktree 无 `node_modules`（新建 worktree，依赖未安装），为跑 `check` / `build` / `test` 建了 `TUI/node_modules` → 主工作区 `TUI/node_modules` 的符号链接（`.gitignore` 覆盖、不入库；收尾时按需删除）。

## 测试与证据

- `npm run check`（TUI，`include` 含 `tests`）→ 通过（`tsc -p tsconfig.json --noEmit`，无输出即无错误）。
- `npm run build`（TUI）→ 通过；`dist/src/app/layout.js` 内含 `interrupt: "!"`（编译产物已核实）。
- `sh scripts/test.sh`（TUI 全量）→ **1600 / 1600 通过，0 失败**（其中 `tests/interrupt-mode.test.ts` 为本任务新增 6 例；改动前基线未单独测量，按此推算为 1594）。
- `npm run demo -- --smoke` → **退出码 0、42 个 `SMOKE_PASS`、无 `SMOKE_FAIL`**（改动前该冒烟 3 项红，见「偏差」；本任务已同步演示脚本与断言）。

## 收尾

（待关闭时补齐）
