# auto-approve 待办（模块级）

> 职责：auto-approve 包内的缺陷与待办（包内变更优先写在本包文档）；不负责：跨包待办（见 `docs/BACKLOG.md`）、判定口径与边界（见 `auto-approve/README.md`）。本文件只列未完成项，已完成项见 git 历史与 `auto-approve/tests/`。
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；每次整理时按当前顺序从 1 起重新编号。条目结构：现象 / 现状 → 期望 → 落点 → 验收 → 估时 → 来源·状态·优先级。

## 待办

**1. 单会话内: 用户面板人工放行的调用进会话指纹（同会话后续等价调用免问）**（2026-10-20 登记, 来源: 用户需求「正常触发审批, 但会自动放行我放行过的命令; 单会话内有效就行」）：**现象 / 现状** —— 指纹表只记 auto-approve 自己 `allowed-once` 的调用; 用户在面板人工放行（`approval/decided` outcome=`allowed-once` 且非本插件裁定）的调用**不进指纹** → 同会话内再次出现等价调用仍弹面板（实测: 同会话两次 `git push` 各弹一次沙箱升级审批）。**期望** —— auto-approve 观察 `approval/decided`, 对本插件未裁定的 `allowed-once`（人工放行）按 callId 配对到 pre-execute 记录的参数, 把该工具的命令写入**会话指纹**（沿用现有单会话指纹表 / 容量 / LRU 上限, 跨会话不持久, 拒绝不入表）; 等价判定加**形态层**: 命令按 shell 词法**拆段**（`;` `|` `&` 换行, 切分口径沿用 security-guard）, 每段做形态归一（折叠空白, **抹易变参**: 引号串消息体 / 长 hex / 数字 → 占位）; 匹配按**段覆盖**: 一次调用 = 每段形态各自已在该会话放行集内即 `allowed-once`（顺序无关; 复合命令逐段独立判定）; 与现有精确参数 hash 指纹**并存**（精确命中或段覆盖命中任一即放行; 如 `git commit -m"a"` 与 `-m"b"` 归为同一段形态 `git commit -m <msg>` 而等价）。**优先级** —— P2。**状态注记** —— 进行中: 2026-10-21（追踪文档 `auto-approve/docs/implementation/2026-10-21-manual-approval-fingerprint.md`; 调研已完成, 待决策）。

> 2026-10-18 关闭：「项目层审计行的 `source.kind` 与 memory-base `SourceKind` 闭集对齐」已改为 `manual` + `label: "auto-approve"`（提交 `e8faf41`）；「巡检工具：从会话日志还原哪些调用被自动放行」已实现为只读脚本 `scripts/inspect-session.mjs`（提交 `7afb5e5`）。过程记录见 `docs/archived/2026-10-18-five-backlog-items.md`。

## 已裁定不做（备查）

跨会话 / 跨进程持久授权、包装官方 `experimental-auto-review`、新增 `ApprovalPolicy` 取值与会话事件词汇、改 TUI 审批面板、命令 / 路径类拒绝规则（归 `security-guard`）、按会话配置（归宿主 `/policy` 与 `/permission`）、首期的巡检工具（已转 #2）——逐条理由见 `README.md`「边界与已知限制」与「与既有件的关系」（决策 2-b / R2 / R3 / R4）。
