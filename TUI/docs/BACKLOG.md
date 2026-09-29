# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，本文件内唯一，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**不复用已退役号段（≤ 47）**，`TUI/src`、`TUI/tests` 注释中的 `TUI#n`（n ≤ 26）均为旧编号的历史引用；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。

## 待办

- **待办** **#48 会话别名的 TUI 显示桥**：session-channel 的「会话别名」功能（`session-channel/docs/BACKLOG.md` F1）需 TUI 侧只读桥把别名显示到界面上——标题栏或状态列的会话块显示别名（未设别名时维持现状）。数据经 `ctx.get("sessionChannel")` 的只读面（F1 落地后提供别名查询/列表）。落点：`TUI/src/app/adapter/dsh.ts`（读取别名面）+ `TUI/src/app/state.ts` 与渲染层（标题栏 / 状态列）。依赖：F1 实现后才有别名数据与查询面；本条目只动 TUI 侧，不改 session-channel。验收：设别名后 TUI 对应会话显示别名；未设别名时行为不变；session-channel 未挂载时静默降级（不报错、不空占位）。来源：2026-09-29 #30 交付后用户提出。状态：待接取。优先级 P2。

- **待办** **#49 问答面板「自定义回复」输入时光标压在末字符上（应在末字符之后）**：问答面板（`ask_user_question`）自定义项输入时，光标显示在**最后一个字符所在列**，而非其后一列，违背常见输入习惯。定位提示：① `TUI/src/app/question-transition.ts` 的 caret 记账（`customCaretOf` / `customInsert`，末位插入后 `caret = at + 1`）；② `TUI/src/app/components/QuestionPrompt.ts` 的 `caretInWrapped`（caretIndex → 行内显示列映射）——怀疑 `caretIndex === 串长`（行尾）时取的是**末字符的列**而非右邻一列。落点：`TUI/src/app/components/QuestionPrompt.ts`（列映射）+ `TUI/src/app/question-transition.ts`（如确有记账问题）。验收：输入 `abc` 时光标落在 `c` 之后；空串落在起始列；左移/右移/退格行为与输入区（`/` 命令）及审批框一致；补一条覆盖「末位插入后 caret 列」的用例。来源：2026-09-29 用户实测提出。状态：待接取。优先级 P2。

- **待办** **#50 退出确认增加「重启」选项（仅探讨可行性）**：退出确认面板（`TUI/src/app/index.ts` 的 `EXIT_CONFIRM_PANEL_ID`，现选项 = 取消 / 退出 dsh）考虑增加「重启 dsh」（保留同一会话继续）。探讨要点：① 宿主是否有重启/重载面——`docs/host/DSH-CTX-API.md` 记录了会话 resume 链路（格式 v4 + 迁移器），需查 CLI 是否支持 `--resume` 或等价参数、TUI 能否用 `process.execPath` + `process.argv` 重新 exec；② 语义与回退——重启 = 退出当前进程后以同 profile / 同会话 resume 启动，是否需等 flush 完成、重启失败时是回退到界面还是直接退出；③ 交互——面板新增第三项（默认仍是「取消」）、是否需二次确认、tmux / 多实例下的重启方式差异。结论口径：本条目**只产出可行性结论与建议方案**，不排期；可行则另拆实现条目（含真机验证「重启后会话连续」）。来源：2026-09-29 用户提出（仅探讨）。状态：待接取。优先级 P3。
