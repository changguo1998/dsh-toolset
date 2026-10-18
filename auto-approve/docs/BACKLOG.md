# auto-approve 待办（模块级）

> 职责：auto-approve 包内的缺陷与待办（包内变更优先写在本包文档）；不负责：跨包待办（见 `docs/BACKLOG.md`）、判定口径与边界（见 `auto-approve/README.md`）。本文件只列未完成项，已完成项见 git 历史与 `auto-approve/tests/`。
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；每次整理时按当前顺序从 1 起重新编号。条目结构：现象 / 现状 → 期望 → 落点 → 验收 → 估时 → 来源·状态·优先级。

## 待办

（暂无待办）

> 2026-10-18 关闭：「项目层审计行的 `source.kind` 与 memory-base `SourceKind` 闭集对齐」已改为 `manual` + `label: "auto-approve"`（提交 `e8faf41`）；「巡检工具：从会话日志还原哪些调用被自动放行」已实现为只读脚本 `scripts/inspect-session.mjs`（提交 `7afb5e5`）。过程记录见 `docs/archived/2026-10-18-five-backlog-items.md`。

## 已裁定不做（备查）

跨会话 / 跨进程持久授权、包装官方 `experimental-auto-review`、新增 `ApprovalPolicy` 取值与会话事件词汇、改 TUI 审批面板、命令 / 路径类拒绝规则（归 `security-guard`）、按会话配置（归宿主 `/policy` 与 `/permission`）、首期的巡检工具（已转 #2）——逐条理由见 `README.md`「边界与已知限制」与「与既有件的关系」（决策 2-b / R2 / R3 / R4）。
