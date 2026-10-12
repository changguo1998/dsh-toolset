# 2026-10-13 交换输入模式语义（默认 steer / `<` followup）

- 层：TUI
- 接取条目（按标题引用）：〈交换输入模式语义：默认 `>` 走 steer、`<` 走 followup〉
- 开始：2026-10-13　状态：完成

## 目标

把「默认输入模式」与「`<` 模式」的投递语义互换：

- 默认（提示符 `>`）= **steer**：走官方 `agent.steer`（`send(m, "next-step", true)`）——运行中在**最近 step 边界**被核心认领（仍属当前回合），空闲时立即起一轮；
- `<` = **followup**：排队等下一回合（运行中进排队块、`next-turn` 队列；空闲时直接发送）；
- `$`（shell）/ `/`（slash）不变；`Alt+Enter`「打断并发送」契约不变（任何模式下都先 interrupt 再直发）；
- 模式字面量随语义改名（`"normal"` → `"steer"`、`"steer"` → `"followup"`），使名字与行为一致：默认模式就叫 `steer`，`<` 模式就叫 `followup`。

非目标：不改排队块的两种类型（`queued.kind = "followup" | "steer"` 是**投递类型**、不是输入模式，保持不变）；不改 `Alt+Enter` 语义；不新增模式。

## 调研

- 输入模式现状（`state.ts:85`）：`InputMode = "normal" | "shell" | "slash" | "steer"`，`MODE_SYMBOL = { normal: ">", shell: "$", slash: "/", steer: "<" }`（`layout.ts:1839`）；空输入按 `$` / `/` / `<` 切模式（`index.ts:2793-2800`），Backspace 空输入回退默认（`index.ts:2760`），任何提交后回退默认。
- 提交路径（`index.ts` 的 `submit`）：`slash` → 命令路由；`steer` → `next-step` 投递（运行中进排队块 `kind: "steer"`，空闲直发）；`shell` → 本地命令；其余（旧 `normal`）→ 运行中 `queued-push`（`kind` 缺省 = followup）、空闲直发。
- 三处「回退默认模式」与一处「Backspace 回退」都硬编码字面量 `"normal"`，改名后必须同步，否则回退会落到已删除的成员上（TS 会直接报错，属可编译期捕获）。
- 持久化面：输入历史**只在进程内**（`state.ts:771` 注释「不写入 tui-state.json」），`session-ui-state.ts` 的 `modes` 只存 plan / sandbox / permission / policy —— **无磁盘迁移面**（旧字符串不会从磁盘读回）。
- 观测面：`FakeAdapter.sendMessage(text, sessionId, target)` 记录 `sent`（全部）与 `steered`（`target === "next-step"`），`log` 记 `steer:` / `send:` 前缀 —— 现有用例靠它区分两种投递，交换后断言口径要跟着换。
- 文档口径：`README.md:170-171`（提示符符号表 + 输入模式语义）、`DESIGN.md:181`（输入区）；SPEC 未记输入模式。`Alt+Enter` 提示在 `hints.ts` 的默认提示行（「[Alt+Enter]打断并发送」）—— 不改。

## 决策

1. **模式字面量按语义改名**（`normal` → `steer`、`steer` → `followup`），而不是保留旧名换行为：名字与投递语义一一对应，避免「steer 模式其实是排队」这类反向阅读成本；改名面可控（4 个 src 文件 + 4 个测试文件），且无磁盘持久化面。
2. **`Alt+Enter` 在新默认模式下仍直发**：旧 `normal` 分支里 `interrupt` 会绕过排队直发，`steer` 分支则忽略 `interrupt`（打断后仍按 step 边界投递）。既然默认模式变成 steer，若照搬旧 steer 分支，`Alt+Enter` 在新默认模式下的「打断并发送」就会退化成「打断 + step 边界投递」—— 与提示行承诺不符。故两个分支都收敛为「`interrupt` → 打断后直发」，保证提示行口径在每种模式下都成立。
3. **不做模式别名兼容**（不保留 `<` 同时表示 steer 的旧行为）：两种语义互斥且用户明确要求交换；留后门只会让「按下 `<` 到底排队还是插话」重新变模糊。
4. **排队块类型不动**：`queued.kind` / 交付 `queued` 字段表达的是**投递类型**（`followup` / `steer`），与输入模式解耦；改名会让 `state.ts` / `layout.ts` / pipeline 的多处类型与快照口径无谓扩散。

## 规划 / 计划改动文件清单

- `src/app/state.ts`：`InputMode` 联合改名（`"steer" | "followup" | "shell" | "slash"`）、`initialState()` 的 `inputMode` / `inputHistoryDraftMode` 初值 → `"steer"`、`reduceInputHistory` 的回退字面量、相关注释口径。
- `src/app/index.ts`：模式键映射（`<` → `"followup"`）、`submit` 的两个分支交换位置与语义、`interrupt` 直发收敛、三处「回退默认模式」字面量、注释。
- `src/app/layout.ts`：`MODE_SYMBOL` 改为 `{ steer: ">", shell: "$", slash: "/", followup: "<" }` + 注释。
- `src/app/commands.ts`：`InputModeLike` 联合与 `completeCommandInput` 的缺省参数。
- `tests/steer-mode.test.ts`：按新语义重写（默认 = steer 投递；`<` = followup 排队/直发；`<` 提示符、幂等、Backspace 回退、提交后回退默认；宿主无 steer 时默认路径降级 + 提示）。
- `tests/steer-queued-display.test.ts`：构造 steer 排队态的按键改为「默认模式直接提交」（去掉先按 `<`）。
- `tests/input-history.test.ts`：模式字面量与「提交后回退」断言。
- `tests/completion.test.ts` / `tests/adapter.dsh.test.ts`：`completeCommandInput` 的模式参数与 `mode: "normal"` 字面量。
- `tests/app.test.ts`：受影响的模式/提示符断言（如有）。
- `TUI/README.md` / `TUI/docs/DESIGN.md`：符号表与语义描述交换。
- `TUI/docs/BACKLOG.md`：条目状态与收尾移除。

## 实现记录

- `src/app/state.ts`：`InputMode` 改为 `"steer" | "followup" | "shell" | "slash"`；`initialState()` 的
  `inputMode` / `inputHistoryDraftMode` 初值与 `reduceInputHistory` 的回退字面量改为 `"steer"`；注释口径同步。
- `src/app/layout.ts`：`MODE_SYMBOL = { steer: ">", shell: "$", slash: "/", followup: "<" }`。
- `src/app/commands.ts`：`InputModeLike` 联合与 `completeCommandInput` 的缺省模式 → `"steer"`。
- `src/app/index.ts`：
  - 模式键映射：空输入按 `<` → `"followup"`（`$` / `/` 不变）；三处「回退默认模式」与空输入 Backspace
    回退一律 `"steer"`；
  - `submit()` 分支重排：`slash`（不变）→ **`followup`**（原默认分支：运行中 `queued-push` 缺省 kind =
    followup + `sendMessage` 不带 target；空闲直发）→ `shell`（不变）→ **默认 = steer**（原 `<` 分支：
    运行中 `queued-push kind: "steer"` + `sendMessage(target: "next-step")`，空闲 `sendUserText`）；
  - `Alt+Enter` 收敛为两种模式都「打断后直发」：steer 路径的直达分支按 `interrupt ? undefined : target`
    传参（打断即放弃当前回合，不走 step 边界投递），保住提示行「打断并发送」口径；
  - 降级提示文案改为「宿主不支持 steer，已按 followup 投递」（旧文案「已按普通消息发送」在排队/直发
    两种情况下都不准确）。
- 测试：`tests/steer-mode.test.ts` 按新语义重写（7 例：默认即 steer / `<` 幂等与提示符 / `<` 空闲直发 +
  提交后回退 / 忙时两种排队 kind / `Alt+Enter` 两种模式都直发 / 宿主无 steer 降级 / 空 `<` Backspace 回退）；
  `tests/steer-queued-display.test.ts` 的 steer 排队改为**默认模式直接提交**、followup 排队改为先按 `<`；
  `tests/app.test.ts` 的默认提交断言由 `send:` 改 `steer:`、`<` 排队用例改走 `<`、压缩期间排队 kind 改
  `steer`；`tests/input-history.test.ts` / `tests/completion.test.ts` / `tests/layout4.test.ts` 的字面量同步。

## 测试与证据

- `tsc -p tsconfig.json --noEmit` → 通过；`npm run build` → 通过（`dist/src/app/layout.js` 内已核实
  `steer: ">"` / `followup: "<"`）。
- 全量 `sh scripts/test.sh` → **1517 / 1517 通过**（上一基线 1514；本任务把 `steer-mode.test.ts` 由 4 例扩到
  7 例，其余为既有用例改写）。
- 真机探针（隔离 `DSH_HOME` + 真 tmux，配方见 `archived/2026-10-13-tmux-detach-and-hmr-theme-exit.md`）：
  默认提示符 `> Type a message...`；按 `<` → `< Type a message...`；`0x7f` 退格 → 回 `>`；按 `/` →
  `/ Type a message...`；全程 `pane_dead=0` / `cmd=node`。
- 语义面（`next-step` 投递 / 排队 kind / Alt+Enter 直发）由 `FakeAdapter` 的 `steered` / `sent` / `log` /
  `interrupts` 断言覆盖（真机探针不触发模型调用，故交付侧不做真机断言）。
- 真机旁证（用户重启后的真实会话日志，`~/.dsh/sessions/<项目目录>/tui-*/session.v4.jsonl.zstd` 的
  `agent/inbox/spliced`）：交换生效**前**用户输入为 `target: "next-turn"`（followup），生效**后**同一 TUI
  会话内变为 `target: "next-step"`（steer）—— 端到端确认线上跑的是新默认模式。

## 收尾

- 用户确认后提交（2026-10-13）：BACKLOG 条目移除（其后条目顺延编号）、追踪文档移入 `TUI/docs/archived/`。
- 文档回写：`README.md`（提示符符号表 / 输入模式段 / 按键表 `Backspace`・`Enter` 两行 / 排队段）、
  `DESIGN.md`（输入区口径：提交语义、`Alt+Enter` 直发、空闲直达）。
- 提交：`feat(TUI)` 代码 + 用例；`docs(TUI)` 收尾（README / DESIGN / BACKLOG / 追踪文档）。
- 遗留：无（`InputMode` 无磁盘持久化面，无需迁移）。
