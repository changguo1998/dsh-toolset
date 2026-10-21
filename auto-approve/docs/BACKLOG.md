# auto-approve 待办（模块级）

> 职责：auto-approve 包内的缺陷与待办（包内变更优先写在本包文档）；不负责：跨包待办（见 `docs/BACKLOG.md`）、判定口径与边界（见 `auto-approve/README.md`）。本文件只列未完成项，已完成项见 git 历史与 `auto-approve/tests/`。
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；每次整理时按当前顺序从 1 起重新编号。条目结构：现象 / 现状 → 期望 → 落点 → 验收 → 估时 → 来源·状态·优先级。

## 待办

（当前无未完成项）

> 2026-10-21 关闭：「单会话内: 用户面板人工放行的调用进会话指纹」已完成并合入 main `7bee2bf` —— 学习层含形态表（每会话 / 段覆盖 / 容量 LRU）、最小泛化（同段第二次成功观测、段首与子命令不通配、单段变位 ≤2）、LLM 准入审阅（2 s 窗口合并、失败不学）、重启回填（≤20 条、只计成功执行、一次性）与 `learn off|on|list|undo|clear` 命令面；`npm run test` 149 例全绿（既有 115 + 新增 34）。真机验证（2026-10-21，主会话代按面板）：`echo "probe-alpha"` + danger-full-access 面板放行后，sleep 6 s 的 `echo "probe-beta"`（同形态）**未再弹面板**（04:55:59 放行 / 04:56:11 自动放行），审计行 `source=fingerprint` / `ruleId=fingerprint:form` / `fingerprintHash=0737c58b3b9a1a65`，会话日志 `approval/asked` 无新增（共 5 条：两次试验各 2 + probe-alpha 1）；反例 `echo learn-probe-one` / `learn-probe-two` 的差异在未加引号 token → 第二次仍弹面板，属预期（形态不同）。未验证：重启回填（`sessionQuery` 回读）未真机跑、`pwsh` 跨 shell 未验、免问收益未度量。过程记录见 `auto-approve/docs/archived/2026-10-21-manual-approval-fingerprint.md`。

> 2026-10-18 关闭：「项目层审计行的 `source.kind` 与 memory-base `SourceKind` 闭集对齐」已改为 `manual` + `label: "auto-approve"`（提交 `e8faf41`）；「巡检工具：从会话日志还原哪些调用被自动放行」已实现为只读脚本 `scripts/inspect-session.mjs`（提交 `7afb5e5`）。过程记录见 `docs/archived/2026-10-18-five-backlog-items.md`。

## 已裁定不做（备查）

跨会话 / 跨进程持久授权、包装官方 `experimental-auto-review`、新增 `ApprovalPolicy` 取值与会话事件词汇、改 TUI 审批面板、命令 / 路径类拒绝规则（归 `security-guard`）、按会话配置（归宿主 `/policy` 与 `/permission`）、首期的巡检工具（已转 #2）——逐条理由见 `README.md`「边界与已知限制」与「与既有件的关系」（决策 2-b / R2 / R3 / R4）。
