# 退出前问题面板确认（接取条目：docs/BACKLOG.md「tmux 断连后 dsh 退出」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

退出类动作（至少 `Ctrl+D`）不再立即 `dispose`，而是弹出问答面板确认（默认选中「取消/留在 TUI」，Enter 确认高亮项、Esc 取消），防止任何「单字节误触/注入型」输入直接结束会话。

## 调研

来源：`TUI/src/renderer/input.ts`、`TUI/src/renderer/index.ts`、`TUI/src/app/index.ts`、`TUI/src/app/state.ts`、`TUI/src/app/question-transition.ts`、`TUI/src/app/components/QuestionPrompt.ts`、`docs/host/`、用户 2026-09-27/09-29 真机反馈与三次取证。

- **原症状**：用户 2026-09-27 报告「tmux detach 后 dsh 退出」。2026-09-29 复查多次不再复现；真机取证（`tmp/stdin-trace.mjs`）显示 attach/detach 期间 pane stdin 只收到 `q`（取证者按键），**无 `0x04`**。
- **沙箱复现（环境相关）**：隔离 `DSH_HOME` + `script` 包装 pty 下，真 `dsh --profile fff` 在 attach 握手约 1s 后收到一个 `0x04`（Ctrl+D）字节，4-11ms 内 `process.exit(0)`；调用栈固定为 `renderer.close() ← App.finishDispose() ← App.disposeWithExitClean()`，即 `App.dispose()`（入口仅三处：`Ctrl+D`（idle + 输入空）、750ms 双击 `Ctrl+C`、`/quit`）。信号与事件循环空转均已排除（SIGHUP/SIGTERM/SIGWINCH 追踪 + 4s canary 均正常）。
- **结论**：真机病因未复现；沙箱字节注入证明「单个 `Ctrl+D` 字节 = 无确认直接退出」这条链路真实存在且脆弱。用户裁定：不改按键、改退出语义（确认面板）。
- **现有机制（复用面）**：问答面板 `QuestionPanelState`（`state.ts`，支持单题两选项、`optionIndex` 高亮、Enter 提交/Esc 取消）；按键路由纯函数 `questionKeyDecision`（`question-transition.ts`）；提交/取消副作用在 App 的 `submitQuestion` / `cancelQuestion`（`answerQuestion` / `cancelQuestion` 调 adapter）；`QuestionPrompt.ts` 渲染。审批/问答期间按键先被面板吞掉（`handleQuestionKey`），且 `handleKey` 的问答分支在 `Ctrl+D` 判断之前。
- **退出路径**：`App.dispose()` 三入口；`main.ts` 的插件 unload 也调 `disposeApp()`（同路径）。用户的诉求措辞为「检测到退出信号时」。

## 决策

1. **不改按键，改语义**：`Ctrl+D`（idle + 输入空）与 750ms 双击 `Ctrl+C` 不再直接退出，改为打开问题面板确认；`/quit` 为显式输入、不弹面板（保持原语义）。信号强退（SIGINT/SIGTERM）由 renderer 处理、不经过 App，不在本次范围。
1. **面板形态**：复用问答面板机制（`question-open` + `QuestionPrompt`），合成面板 id `exit-confirm`；单题两选项——「取消」（默认高亮，留 TUI）与「退出 dsh」；Enter 确认高亮项、Esc 取消（与 `questionKeyDecision` 既有语义一致，零新增按键路由）。
1. **副作用隔离**：`submitQuestion` / `cancelQuestion` 对 `exit-confirm` 面板分支处理——确认「退出 dsh」才走原 `dispose()`，否则仅关面板；绝不调用 adapter 的 `answerQuestion` / `cancelQuestion`（合成面板没有宿主 ask）。
1. **守卫沿用**：`canExitOnCtrlD`（idle 且未压缩且输入空）保留为**是否弹面板**的前置判据（无法退出时维持现行为：吞掉并提示）；`/quit` 与双击 `Ctrl+C` 不再需要该守卫，直接弹面板。
1. **不接宿主面**：dsh 宿主的 SIGTERM/SIGINT 处理、`beforeExit` 兜底不动；tmux 环境不感知（不做 tmux 专用分支）。
1. **沙箱验证用注入字节**：`script` 包装 pty 在 attach 时注入的单字节 `0x04` 作为真机演化验证的替身——修复后单字节不再致退（面板弹出），用户可目视。

## 规划

任务拆分：

1. `state.ts`：`QuestionPanelItem` 复用；新增导出 `exitConfirmPanel()`（合成面板构造）或放 App 私有（实现时定，倾向 App 私有以减少 state 面改动）。
1. `index.ts`：`Ctrl+D` 分支 → `requestExitConfirm()`；双击 `Ctrl+C` 分支 → 同；新增 `requestExitConfirm()`（守卫 + `question-open` 动作 + paint）与 `exitConfirmPending` 判别；`submitQuestion` / `cancelQuestion` 增加 `exit-confirm` 分支。
1. 测试：`TUI/tests/` 新增或扩展用例——Ctrl+D 弹面板且不退出；Enter（默认「取消」）关面板不退出；下移 + Enter 走 `dispose`；Esc 关面板不退出；双击 Ctrl+C 同；`/quit` 仍直接退出。挂载点实现时按现有 App 测试 harness 确定（`app.test.ts` 有按键驱动）。
1. 文档：本追踪文档；关闭时回写 `TUI/docs/DESIGN.md`（退出契约一节）与 `TUI/README.md`（退出契约段落）。

计划改动文件清单（**只改这些**）：

- `docs/BACKLOG.md`（条目状态与口径更新）
- `docs/implementation/2026-09-29-exit-confirm-panel.md`（本追踪文档）
- `TUI/src/app/index.ts`
- `TUI/tests/app.test.ts`（或实现时确定的既有 App 测试文件）
- `TUI/docs/DESIGN.md`（关闭时回写）
- `TUI/README.md`（关闭时回写）

明确不做：不改 renderer 的按键解码；不改 `questionKeyDecision` 纯函数；不加 tmux 专用逻辑；不动宿主面与其它插件；不改 `/quit` 语义；不顺手重构相邻代码。

## 实现记录

2026-09-29：

- `TUI/src/app/index.ts`：
  - 新常量 `EXIT_CONFIRM_PANEL_ID = "exit-confirm"`（合成面板 id）。
  - 新字段 `exitConfirmOpen`（面板是否已开，幂等防叠）。
  - `Ctrl+D` 分支：守卫通过时 `this.dispose()` → `this.requestExitConfirm()`（注释同步）。
  - 双击 `Ctrl+C` 分支：同样改为 `requestExitConfirm()`。
  - 新方法 `requestExitConfirm()`：`question-open` 打开单题面板（题干「确认退出 dsh？」，选项「取消」（默认高亮）/「退出 dsh」）；`disposed` 与 `exitConfirmOpen` 双守卫。
  - 新方法 `finishExitConfirm(panel)`：按 `buildQuestionAnswers` 高亮回退语义取提交项，仅当为「退出 dsh」才 `dispose()`，否则仅关面板。
  - `submitQuestion()` / `cancelQuestion()`：`panel.id === EXIT_CONFIRM_PANEL_ID` 分支——本地收尾，**不调用** adapter 的 `answerQuestion` / `cancelQuestion`。
- `TUI/tests/exit-confirm.test.ts`（新增 4 条）：Ctrl+D 弹面板 + Esc 取消 + 可重开；Enter（默认项）不退出 / 数字 2 + Enter 退出且 adapter 零调用；双击 Ctrl+C 弹面板（单击仅清空输入）；`/quit` 仍直接退出。
- `TUI/tests/app.test.ts`（3 条旧断言随语义更新）：双击 Ctrl+C 两条改为「先确认、选 2 + Enter 退出」；「Ctrl+D idle+空输入」改为「先弹面板、确认后 dispose」；P8 一条改为「压缩期间连面板也不弹、空闲后可弹、取消后留 TUI、再确认才退出」。

## 测试与证据

- `npm --prefix TUI run check`：通过（0 处 `error TS`）。
- `npm run test:tui -- exit-confirm.test.ts`：4 pass / 0 fail。
- `npm run test:tui -- app.test.ts`：161 pass / 0 fail（含 3 条更新用例）。
- `npm run test:tui -- p8-compaction-active.test.ts`：4 pass / 0 fail。
- 全量门禁（2026-09-29）：根 `npm run check` 通过（0 处 `error TS`，15 包）；`TUI && npm run build` 通过；`npm run test:tui` 1204 pass / 0 fail（较上一任务 +4 条新用例）。
- 沙箱 tmux 单字节注入验证（`tmp/verify-exit-confirm.sh`，隔离 `DSH_HOME` + `script` pty 复现注入路径）：attach 后 pane 仍 `dead=0`（修复前同路径 `dead=1 status=0`）；pane 画面显示「退出：确认退出 dsh？」+「> 1. 取消」/「2. 退出 dsh」+ 底部提示 `▶选项·[Enter]提交·[Esc]取消`——单个 `0x04` 只弹面板，不再致退。
- 真机注意：用户 2026-09-29 的取证表明其环境 attach/detach 不注入字节，原症状已不复现；若再复发，按追踪文档「调研」一节的取证脚本（stdin 字节 + 信号 + 退出栈）重新采集。

## 收尾

- 回写 `TUI/docs/DESIGN.md`「退出契约」段：`Ctrl+D` / 双击 `Ctrl+C` 先弹退出确认面板，仅确认「退出 dsh」才 `dispose()`；`/quit` 保持直接退出。
- 回写 `TUI/README.md`「退出契约」段：同上口径（用户可见说明）。
- `docs/BACKLOG.md`：#49 从待办清理移除（原症状真机不复现 + 防误触加固完成）。
- 本文件移入 `docs/archived/`。
- 未登记遗留项：真机原症状（detach 后 dsh 消失）未定位到确定病因，已由确认面板兜住「输入型误触」这一类风险；若复发需重新取证。
- 临时文件：`tmp/` 下本轮实验产物已清理（仅留最终验证脚本 `tmp/verify-exit-confirm.sh` 供复现，关闭时一并删除）。
