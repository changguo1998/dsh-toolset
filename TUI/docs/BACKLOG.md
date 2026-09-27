# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，本文件内唯一，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**不复用已退役号段（≤ 33）**，`TUI/src`、`TUI/tests` 注释中的 `TUI#n`（n ≤ 26）均为旧编号的历史引用；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。

## 待办（共 9 条）

- **待办** **#34 输入历史：记录已提交的命令/输入，输入态按 ↑/↓ 翻看前几条**：输入状态下按 ↑ 取上一条已提交内容、↓ 取更新的条目（到底回到当前草稿），可连续翻看前 N 条；`/` 命令与普通用户输入同一份历史（或分开两份，实现时定）。范围：历史存放位置（进程内 vs 随会话写入 `tui-state.json`）、去重与上限条数待定；不与既有 `↑/↓` 语义冲突（焦点面板滚动 / `/history` 面板移动已占用同一按键，按焦点态分流）。落点：输入态按键映射（`src/app/index.ts`）+ state/reducer（`src/app/state.ts`）+ 可选持久化。来源：用户 2026-09-27 提出。状态：进行中（追踪文档见 docs/implementation/）。优先级 P2。

- **待办** **#35 问题面板编辑自定义答案时，←/→ 移动光标**：问题面板（`ask_user_question`）的自定义答案输入（`item.custom`，`question-custom` action）目前只能在串尾追加/退格，无法在文本中间定位；改为 ←/→ 在输入串内左右移动光标，插入与退格在光标处生效，渲染显示光标位置；其余按键行为不变（Tab 切焦点窗、`↑/↓` 选项移动）。落点：`src/app/state.ts`（question 状态与 `question-custom` reducer）、`src/app/index.ts`（输入态按键映射）、问题面板组件渲染。来源：用户 2026-09-27 提出。状态：完成（2026-09-27 真机确认通过，追踪文档已归档）。优先级 P2。

- **待办** **#36 新增 `<` 前缀触发的输入状态（steer 模式）：提交的消息进 steer 队列**：仿现有前缀模式（输入框为空时按 `$` → shell、按 `/` → slash，`src/app/index.ts:1799-1808`；类型 `InputMode` 在 `src/app/state.ts:99`；提示符映射在 `src/app/layout.ts:2290-2294`），新增 `<` 触发的一档：该模式下提交的消息**不排到下一回合**，改走宿主 **`agent.steer`**（= `send(m,'next-step',true)`，进 next-step 队列并唤醒），在当前回合的下一个 step 边界被认领、可续回合；空闲时 steer 会立即起一轮。落点：`inputMode` 联合类型 + 提示符表 + 模式键分支（与 `$`/`/` 同判定：输入框空且非 ctrl，幂等、提交后回退 `>`）+ `submit()` 的模式分流（新增 steer 分支）+ adapter 新增投递方法（`activeAgent.steer` 缺失时 warning 降级为 `followup`）。附注：现有 `shell`（`$`）模式目前只切提示符、无实际路由，本条不动它。来源：用户 2026-09-27 提出。状态：完成（2026-09-27 真机确认通过，日志取证 next-step，追踪文档已归档）。优先级 P2。

- **待办** **#37 实现 `$`（shell）模式的实际执行**：`$` 模式当前只切提示符、**无任何路由**（空输入按 `$` 进入 `shell` 模式，提交仍按普通消息走 followup；`TUI/README.md:125`、`TUI/docs/DESIGN.md:165` 已如实记为「仅符号展示」）。实现：`$` 模式下提交的内容按 **shell 命令执行**（不经模型），结果显示在本地。实现前先定的待定项：① 执行通道——宿主 bash 工具面 / 本地子进程（`TUI/docs/DESIGN.md:20`：node-pty 已评估、暂不引入）；② 输出落位与形态——进活动区还是历史区、大输出是否折叠/截断、是否显示退出码与耗时；③ 是否进会话与模型上下文（本地 shell 通常不进模型历史，需明确写死）；④ 中断与安全——Esc/Ctrl+C 终止、超时上限、危险命令是否过 `security-guard`；⑤ 命令是否并入 #34 的输入历史。落点：`submit()` 的 shell 分支 + adapter 新增执行方法 + 渲染；实现时同步改 `TUI/README.md:125` 与 `TUI/docs/DESIGN.md:165` 的口径。来源：用户 2026-09-27 提出（核对 #36 时发现 `$` 模式为空壳）。状态：进行中（追踪文档见 docs/implementation/）。优先级 P2。

- **待办** **#38 问题面板的「上一条消息」段改走 markdown 渲染并取消青色**：面板描述窗顶部的问题前正文（`panel.source`，活动区正文复述，≤6 行）当前是**纯文本 + 醒目青色**（`QuestionPrompt.ts` 的 `sourceText` 段；青色为 3.2.10 人工反馈所加），与题干 / detail 的 markdown 口径不一致（旧 TUI#6 曾裁定该段保持纯文本——本条即改该裁定）。改为：与题干同口径走 markdown 子集（`panelMarkdownRows`，样式段不含行首 1 列，渲染时补空格 / bar），颜色回默认前景（去掉 `fg:"cyan"`），空行与折行口径随 markdown 渲染统一。落点：`src/app/components/QuestionPrompt.ts`。来源：用户 2026-09-27 提出。状态：完成（2026-09-27 真机确认通过，追踪文档已归档）。优先级 P2。

- **待办** **#39 垂直状态栏（最左状态列）显示 agents 信息（只读）**：状态列现有 **Goal → Todo → Jobs** 三块，新增 **Agents** 块，只读展示当前会话的 agents（子代理）信息（label / id / depth / 运行中·空闲等状态），沿用既有块样式、块间虚线 `╌`、折叠分级（L0-L3）与「无数据时整块省略」口径；纯展示，不接受按键、不提供中断/关闭入口。落点：数据源候选 `src/app/adapter/dsh.ts`（既有 agents 列举路径已按宿主能力择路 `listDescendants` / `listChildren`）+ 状态列内容树与 state。来源：用户 2026-09-27 提出。状态：完成（2026-09-27 真机确认通过，追踪文档已归档）。优先级 P2。

- **待办** **#40 CLI `--resume` / `-c` 启动恢复后历史区为空（不渲染既有消息）**：`main.ts` 在 App 创建前走 `agents.resume`；历史行折叠只在 `/session` 切换路径（`resumeToSession` → `history-resume-ok`）发生，CLI 启动恢复只经 `restoreSessionState` 回填 model/mode/goal/todo → 活动区空，需手动 `/session` 再切一次才可见会话内容（agent 侧上下文已恢复）。落点：`src/app/index.ts`（启动后补一次 surface 折叠）/ `adapter/dsh.ts`（暴露「本次启动为恢复」或启动即 emit 历史行）/ `tests/`。来源：2026-09-27 修复旧 TUI#19 时隔离环境 PTY 实测（见其追踪文档「测试与证据」）。状态：进行中（追踪文档见 docs/implementation/）。优先级 P2。

- **待办** **#41 锚定两阶段解锁后自动加载两个 skill（`i-have-adhd` 模拟用户指令、`karpathy-guidelines`）**：会话启动走完锚定工具引导的两阶段（首请求锁定小工具集 → 首个 durable `tool/call` 解锁全量工具目录）后，自动加载 `i-have-adhd`（以**模拟用户指令**方式注入）与 `karpathy-guidelines` 两个 skill——开局即带上行为约束与输出风格，免去每次手工触发。注入路径与落点待定：解锁点挂钩在 `src/app/adapter/dsh.ts`，注入可复用用户消息注入面（`agent/inbox` next-step / followup）或 skill 加载面。来源：用户 2026-09-27 提出。状态：进行中（追踪文档见 docs/implementation/）。优先级 P2。

- **待办** **#42 TUI 声明了未使用的 `chalk` 依赖（与「零运行时依赖」口径冲突）**：`TUI/package.json` 的 `dependencies` 含 `chalk`，但 `src/`、`demo/`、`scripts/` 无任何 import（renderer 有意改 manual ANSI）；同时 `src/main.ts` 注释称「本项目零运行时依赖」、根 `README.md` TUI 行称「运行时唯一依赖 `chalk`」——三处口径需统一（建议删依赖 + 同步注释/文档；若确有用途则改注释口径）。落点：`TUI/package.json`、`TUI/src/main.ts`（注释）、`README.md`（TUI 行）。来源：2026-09-27 文档过时检查（旧 #24）途中发现。状态：完成（2026-09-27 真机确认通过，重启无模块缺失，追踪文档已归档）。优先级 P2。
