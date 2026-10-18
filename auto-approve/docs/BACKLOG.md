# auto-approve 待办（模块级）

> 职责：auto-approve 包内的缺陷与待办（包内变更优先写在本包文档）；不负责：跨包待办（见 `docs/BACKLOG.md`）、判定口径与边界（见 `auto-approve/README.md`）。本文件只列未完成项，已完成项见 git 历史与 `auto-approve/tests/`。
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；每次整理时按当前顺序从 1 起重新编号。条目结构：现象 / 现状 → 期望 → 落点 → 验收 → 估时 → 来源·状态·优先级。

## 待办

**#1 项目层审计行的 `source.kind` 与 memory-base `SourceKind` 闭集对齐**（2026-10-18 登记，来源：关闭收尾时核对 memory-base 作用域句柄接口）：**现象 / 现状** —— `src/audit.ts` 写项目那份时传 `source: {kind: "approval", ref: callId}`，而 memory-base 现行 `SourceKind = "session" | "file" | "url" | "tool_result" | "manual"`（`memory-base/src/knowledge.ts:29`）不含 `approval`；运行时按字符串入库、不影响裁定（本包用自己的结构化类型声明，编译不受影响），但项目层的来源标签落在闭集外，`search` 按来源过滤时对不上。**期望** —— 二选一：① 本包改用闭集内的值（建议 `manual` + `label: "auto-approve"`，保留 `ref: callId`）；② 与 memory-base 协商把 `approval` 增入 `SourceKind`（跨包改动，需对方接取）。**落点** —— `auto-approve/src/audit.ts` 的 `handle.put(...)`（或 `memory-base/src/knowledge.ts` 的 `SourceKind`）。**验收** —— 项目层审计行的来源标签在闭集内，且能按该来源检索到行；裁定行为与既有测试不变。**估时** —— 15 分钟（含一例断言）。**优先级** —— P3。**状态** —— 〔待办: 2026-10-18 登记〕

**#2 巡检工具：从会话日志还原「哪些调用被自动放行」**（2026-10-18 登记，可选增量）：**现象 / 现状** —— 自动裁定有会话 JSONL 与 memory-base `approval_audit` 两处留痕，但没有从会话日志（`approval/asked` + `approval/decided` 对 + 本包审计行）还原「某次会话里哪些调用被自动放行、命中了哪条规则」的巡检入口，排查误放行时只能手工比对文件。**期望** —— 只读巡检：按会话 id / 时间窗汇总自动裁定（工具、结果、来源、规则 id），并与宿主审批审计逐条对照；不写会话、不改裁定。**落点** —— 本包新增命令或独立脚本（形态待接取时裁定；若做成模型侧工具需按 `security-guard` 的登记口径补登记）。**验收** —— 一次真实会话能列出全部自动放行并逐条对上宿主的 `approval/asked` + `approval/decided`；无关会话与人工裁定不混入。**估时** —— 0.5 天。**优先级** —— P3。**状态** —— 〔待办: 2026-10-18 登记〕

## 已裁定不做（备查）

跨会话 / 跨进程持久授权、包装官方 `experimental-auto-review`、新增 `ApprovalPolicy` 取值与会话事件词汇、改 TUI 审批面板、命令 / 路径类拒绝规则（归 `security-guard`）、按会话配置（归宿主 `/policy` 与 `/permission`）、首期的巡检工具（已转 #2）——逐条理由见 `README.md`「边界与已知限制」与「与既有件的关系」（决策 2-b / R2 / R3 / R4）。
