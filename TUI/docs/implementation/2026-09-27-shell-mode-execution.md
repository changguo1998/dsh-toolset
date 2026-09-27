# `$`（shell）模式的实际执行（接取条目：`TUI/docs/BACKLOG.md`「实现 `$`（shell）模式的实际执行」）

状态：测试（实现完成、机械验证通过，待用户人工确认）　　开启：2026-09-27　　关闭：——
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
审阅：用户 2026-09-27 逐条审阅第 5 条（本条），决策**通过**。

## 目标

`$` 模式下提交的内容按 **shell 命令执行**（不经模型），结果显示在 TUI 本地；实现前先定条目列出的五个待定项（执行通道 / 输出落位 / 是否进模型上下文 / 中断与安全 / 是否并入输入历史）。

## 调研

来源：TUI 源码与文档 + 现状核对。

- 现状：`$` 模式**只切提示符、无任何路由**——空输入按 `$` 进 `shell` 模式（`index.ts:1799-1808`），提交仍按普通消息走 `followup`；文档已如实记为「仅符号展示」（`TUI/README.md:125`「`$` shell 目前仅符号展示（提交同普通消息）」、`TUI/docs/DESIGN.md:165`「提交语义：普通文本走官方 followup，`/` 走命令路由」）。
- 执行通道候选：
  1. **本地子进程**（`node:child_process.spawn`，`shell: true`）——`node-pty` 已在设计里「评估、暂不引入」（`DESIGN.md:20` 的技术选型），故用非交互 spawn；
  1. 宿主 bash 工具面（`ctx.get('tools')` 或 bash 服务）——会把命令**变成模型侧一次工具调用**（可选审批面板联动），与「本地命令不经模型」的初衷相悖；
  1. `workflow`/`ptc` 等宿主执行面——权重过重，非本地 shell 语义。
- 输出形态候选：活动区瞬时行（本地输出与模型输出同区，按 `kind` 区分）vs 历史区 buffer 行（会被折叠窗口/语义锚点管理）；活动区行已有 `notice` / `tool-result` 等 kind 与 tone 配色可复用。
- 按键与中断：现有全局 `Esc` / `Ctrl+C` 不退出、`Alt+Enter` 打断并发送；无「终止子进程」键位。
- 安全闸门现状：`security-guard` 是**插件级**（工具面）护栏；TUI 本地执行绕开工具面即绕开它。

## 决策

选项 → 选定（本次实现自定，**待用户审阅**）：

1. **执行通道**：本地子进程（`spawn` + `shell: true`，非交互）——选定。理由：符合「本地 shell 不经模型」，不触发模型回合、不占审批链；`node-pty` 不引入（交互式命令本项不支持，见「明确不做」）。
1. **输出落位**：活动区，追加为本地行（新增 `DshEvent`/buffer kind，如 `kind: "shell"`，带命令回显行 + stdout/stderr 行 + 退出码摘要），有界缓冲（沿用活动区行数与截断机制）；**不进**历史区、不进会话与模型上下文。
1. **是否进会话/模型**：**不进**（硬写死）。理由：本地命令不应污染会话日志与模型上下文；与 `DESIGN.md` 「本地 shell」语义一致。
1. **中断与安全**：本项先做「跑完为止 + 有界超时（默认 30s，超时 kill 并提示）」；`Esc` 终止**留待后续**（需新增按键语义，超出本项范围）；危险命令**不做 TUI 侧黑名单**（避免与 `security-guard` 两套口径），改为执行前一行提示（命令回显即审计）。
1. **输入历史**：本项**不并入**历史（#34 输入历史另条实现，避免两条条目互相耦合）；实现后若用户要求，再单独加一条「shell 命令入历史」。

## 规划

任务拆分：

1. `src/app/index.ts`：`submit()` 增 `shell` 分流——本地执行（异步，不阻塞输入）；结果以事件入活动区；`$` 模式提交后回退 `>`。
1. 新增本地执行模块（如 `src/app/local-shell.ts`：`runShellCommand(cmd, opts) -> { code, stdout, stderr, timedOut }`，spawn 封装，纯 IO 边界，便于单测注入 fake）。
1. `src/app/adapter/types.ts` / `normalize.ts`：新增本地行事件（或复用 `notice` 携带逐行输出）——落地时按最小改动择一（倾向复用 buffer 行 + `kind:"shell"`）。
1. `src/app/layout/*`：活动区 shell 行渲染（命令回显 + 输出 + 退出码 tone）。
1. 测试：`$` 提交走本地执行（假 spawn 断言命令与 cwd）、退出码 / stderr / 超时三种结果渲染、输出不进历史区、模式回退、空命令不执行。
1. 文档：`TUI/README.md:125` 与 `TUI/docs/DESIGN.md:165` 的「仅符号展示」口径同步更新。

计划改动文件清单（**只改这些**）：

- `TUI/src/app/index.ts`
- `TUI/src/app/local-shell.ts`（新建）
- `TUI/src/app/state.ts`（buffer 行 kind，如需要）
- `TUI/src/app/layout.ts` / `TUI/src/app/layout/*`（shell 行渲染）
- `TUI/src/app/adapter/types.ts`（事件类型，如需要）
- `TUI/src/app/layout/hints.ts`（`$` 模式键位提示，如需要）
- `TUI/tests/`（新增 `shell-mode.test.ts`）
- `TUI/README.md`、`TUI/docs/DESIGN.md`（口径回写）
- 本追踪文档

明确不做：交互式 / 长驻命令（无 pty）；`Ctrl+C`/`Esc` 终止运行中的命令（留后续条目）；命令并进输入历史（留后续）；命令沙箱化（沿用进程权限）；不经模型上下文（见决策 3）。

## 实现记录

**实现（2026-09-27）**

1. `src/app/local-shell.ts`（新建）：`runShellCommand`（`spawn(cmd, { shell: true, stdio: ['ignore','pipe','pipe'] })`；stdout/stderr 全量收集；**stdin 关闭**以拒绝交互式命令挂死；超时缺省 **30s** → `SIGTERM`，宽限 1s → `SIGKILL`；单流输出上限 **2 万字符**截断并标记；`error`/`close` 归一为结果，不抛）、`shellResultLines`（命令回显 + stdout + stderr + 退出摘要；空行不产出）、`ShellRunner` 类型与常量。
1. `src/app/state.ts`：`BufferKind` 增 `"shell"`；新增 `appendShellLines`（kind=shell 行入 buffer、不并历史行）与 `{type:"shell-lines"}` action。
1. `src/app/layout/build-box.ts`：`kind === "shell"` 分支——**活动区**本地行（不进对话区），色义复用 notice 的 tone 表（回显 info / 成功绿 / stderr 与非零红 / 超时与截断黄），紧凑模式压单行。
1. `src/app/index.ts`：`AppDeps.runShell?` 注入点（缺省真实 `runShellCommand`）；`submit()` 增 shell 分流（异步执行、不阻塞输入；提交后清输入并回退 normal）；新增 `runLocalShell()`：**回显先行**入 buffer（即时可见 + 审计），执行完成后追加输出与摘要行——结果**只进 buffer**，不经 adapter、不进会话事件流与模型上下文。cwd 取 `currentProjectCwd(state) ?? process.cwd()`（活跃会话 cwd 优先）。
1. 测试：新增 `tests/shell-mode.test.ts`（4 例）；`tests/app.test.ts` 的 `makeApp` / `makeAppAtCwd` 注入 `noopShell` 假执行器（单测不真起子进程），并同步两条断言旧行为（「仅展示层」）的既有用例。

**关键取舍**：

- 执行器**不设危险命令黑名单**（决策 4）：命令回显即审计，护栏归 security-guard，避免两套口径；
- `Esc` 终止运行中命令**留后续**（决策 4）：需新增按键语义，本轮不做；超时 kill 是当前唯一终止路径；
- 命令**不并入**输入历史（决策 5）：与 TUI#34 解耦（历史已慢慢兼顾，但本轮不把 shell 命令写进历史，避免两条条目互相耦合）。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `npm run check`（tsc --noEmit） | 通过 |
| `npm test`（TUI 全量） | **1169 例全通过**（1169 pass / 0 fail，含新增 4 例与 2 例语义同步） |

新增用例（`tests/shell-mode.test.ts`，注入假执行器）：

1. `$` 提交走本地执行器：回显先行可见、stdout 逐行、退出摘要（耗时按实际断言）；**adapter 未收到任何消息**；提交后回退 normal（下一次普通输入才走 send）；
1. stderr 与非零退出码 → `error` tone；shell 行不带 `final`（**不进历史区**）；
1. 超时 + 截断 → 两条警告行（`超时` / `输出过长`，`warn` tone）；
1. 空输入提交不执行（执行器零调用）。

既有用例同步（旧「仅展示层」语义）：

- `tests/app.test.ts`「shell 模式提交」改为断言本地执行（`adapter.sent` 空、buffer 出现 `$ ls` 回显行、提示符回退）；
- `tests/app.test.ts`「模式键」一测的 `$` 段改为「提交不经模型」；
- `makeApp` / `makeAppAtCwd` 注入 `noopShell`（避免单测真跑子进程）。

真机行为待人工确认项：`$ls` 类实际命令的回显与退出摘要、长输出截断、慢命令 30s 超时。

## 收尾

- 已回写 `TUI/README.md`（输入模式一节：`$` 改为「本地命令执行」口径）与 `TUI/docs/DESIGN.md`（输入区语义补 `$` 本地执行与超时/截断参数）；
- 计划外文件：`TUI/src/app/layout/build-box.ts`（新增 shell kind 渲染分支，属落点必需）、`tests/helpers/appFakes.ts` 未改；
- 待办：用户人工确认（真机 `$` 命令回显/退出码/超时；确认后再定是否另开「Esc 终止」「命令入历史」条目）→ 条目转「完成」、本文档移入 `TUI/docs/archived/`。
