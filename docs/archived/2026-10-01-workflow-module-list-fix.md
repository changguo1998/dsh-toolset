# 流程文档陈旧行修正（接取条目：`docs/BACKLOG.md`「流程文档陈旧行修正」）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`docs/WORKFLOW-STANDARD.md` §1「模块」定义写「TUI 与 12 个插件包」（罗列至 context-report），与现状（TUI + 17 个插件包）及 `AGENTS.md` 的「TUI 与 17 个包」不一致。目标：§1 **列全 17 个包名**并注明**以 `AGENTS.md`「结构与约定」为单一来源**（就地可读 + 不再陈旧）。

## 调研

- 现状（既有文档）：§1 第 11 行「「模块」= `TUI` 与 12 个插件包（herdr-integration / task-engine / knowledge-base / goal-contract / metric-loop / output-compress / fs-digest / hash-edit / ast-tools / security-guard / code-map / context-report）；跨模块的改动归**项目级**。」——列的是建仓初期 12 个包，此后新增 rule-engine / symbol-normalizer / session-channel / session-title-cutoff / command-template 五个包未同步。
- 其它出处核对：`AGENTS.md` 已写「TUI 与 17 个包」并在「结构与约定」逐包列出 ✓；`TUI/docs/BACKLOG.md` / `docs/BACKLOG.md` 未重复该清单 ✓；无其它文档复述「12 个包」口径 ✓。

## 决策

1. **两者都做（用户裁定 2026-10-01）**：§1 **列全 17 个包名**，并注明「以 `AGENTS.md`「结构与约定」为单一来源」——就地可读 + 单点维护（新增包时清单以 `AGENTS.md` 为准，本节同步补名）。
1. 备选（未选）：只写引用式（不列名）——就地不可读，需再跳一层。

## 规划

任务顺序：文档（本文件 + BACKLOG 状态）→ 实现（改 §1 行）→ 自查 diff → 收尾（条目完成与清理、归档）。

计划改动文件清单（**只改这些**）：

1. `docs/WORKFLOW-STANDARD.md`：§1「模块」定义行（列全 17 个包名 + 注明单一来源）。
1. `docs/BACKLOG.md`：条目标「完成」并在收尾清理移除。
1. 本追踪文档（`docs/implementation/2026-10-01-workflow-module-list-fix.md`）。

明确不做：不改 `AGENTS.md`（其表述已正确）；不顺手改其它流程段落；不新增条目。

## 实现记录

1. 2026-10-01 改 `docs/WORKFLOW-STANDARD.md` §1 第 11 行：模块定义改为「`TUI` 与 17 个插件包（herdr-integration / task-engine / knowledge-base / goal-contract / metric-loop / output-compress / fs-digest / hash-edit / ast-tools / security-guard / code-map / context-report / rule-engine / symbol-normalizer / session-channel / session-title-cutoff / command-template；以 `AGENTS.md`「结构与约定」为单一来源）」——补全 5 个缺失包名并注明单一来源。

## 测试与证据

- 自查：`format` 后 diff 仅 §1 一行（+1/-1）；包名计数 17 ✓（含新增 rule-engine / symbol-normalizer / session-channel / session-title-cutoff / command-template）。
- 机械门禁：`npm run check` / `npm run build`（文档类变更，按流程门禁跑通）。
- 人工确认：文档类变更无需真机；点 3 由用户目视确认 §1 文本。

## 收尾

- 回写：本次无需额外回写 DESIGN / README / ROADMAP（§1 口径修正即目标本身；`AGENTS.md` 本就正确、未动）。
- BACKLOG 清理：项目级条目「流程文档陈旧行修正」已标「完成」（2026-10-01）并从 §2 移除。
- 归档：本追踪文档移入 `docs/archived/`。
- 残留检查：`git status` 无计划外文件；`tmp/` 无任务临时文件。
- 遗留项：无。
