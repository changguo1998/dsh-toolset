# preference-analysis 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 条目详情（待办）

（无。项目级条目「偏好分析」已于 2026-10-17 关闭，过程记录与实现证据见
`docs/archived/2026-10-16-preference-analysis-design.md`。）

## 已裁定不做（备查，首期）

- **TUI 面板 / `/prefer` 命令**：首期零 TUI 改动，审阅靠 `preference_list`、撤销靠 `preference_remove`
  （详见 `docs/implementation/2026-10-16-preference-analysis-design.md` D17）。
- **写 `AGENTS.md`**：改仓内文件需用户批准、留 diff 噪声；首期只做注入，追加路径二期另议。
- **LLM 归纳与冲突自动检测**：宿主无公开 `ctx.llm`，接 LLM 等于新建契约；统计判定先落地，
  文案润色留注入口（D4）。
- **快捷键 / 命令使用采集**：TUI 的 `$` 本地 shell 与快捷键不进 `session/event`，采集需 TUI
  新增事件（属跨包改动）。
- **提交信息风格**：项目级约定已写死在 `AGENTS.md`（Conventional Commits + 中文），重复收录只会
  产生两套规则。
- **用偏好影响模型工具选择**：首期只注入文本约束，不改工具面。
- **跨机共享偏好**：账簿是本机文件，不做同步。
