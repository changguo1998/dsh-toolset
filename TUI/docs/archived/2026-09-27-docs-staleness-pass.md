# 文档过时检查与回写（BACKLOG: TUI#24）

状态：规划　　开启：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

用户 2026-09-27 指令：检查文档是否过时并更新。范围 = 活文档与当前实现的一致性（对照 2026-09-27 批次 + #19 / #21 / #22 / #23 的落地结果）；两份 `STATUS.md` 由用户择时更新，只报告不修改。

## 调研

逐份核对结果（对照当前代码与已归档追踪文档）：

| 文档 | 结论 |
| --- | --- |
| `TUI/docs/IMPLEMENTATION.md` | **过时 1 处**：§Slash 命令路由的本地命令计数仍写「36 项 = 32 命令 + 4 别名」（实际 39 项 = 34 命令 + 5 别名）。其余（面板保鲜、编辑时间、启动参数、读点约束）已随批次回写 ✓ |
| `TUI/README.md` | **缺 1 项**：已知限制段未登记 TUI#20（CLI `--resume` / `-c` 启动恢复只回填 agent 侧，历史行需再切一次 `/session` 才渲染）。命令表 / 启动参数 / 面板口径均已回写 ✓ |
| `TUI/docs/DESIGN.md` | **缺 1 项**：会话生命周期行只写到 TUI#1/#2，未含 #22（行首时间 = 编辑时间）与 #23（`/continue`「最新会话」语义 + `hasPrompt` 探针） |
| `TUI/docs/COMMANDS.md` / `COMMANDS-SPEC.md` | ✓（计数 39、§4 事件驱动、§5 冒烟 43 项均已同步） |
| `TUI/docs/SPEC.md` / `design/NOTICE-LEVELS.md` / `design/AUDIT-colors.md` / `design/REFACTOR.md` | ✓（无与本批改动冲突的表述） |
| 根 `README.md` / `AGENTS.md` | **过时 1 处**：`AGENTS.md` 的「TUI/docs/IMPLEMENTATION.md 待按 BACKLOG #40 拆分」引用失效（TUI BACKLOG 已扁平重编号，无该条目）；根 `README.md` 与 `TUI/package.json` 的依赖口径问题另立 **#25**（途中发现） |
| `docs/BACKLOG.md`（项目级） | ✓（#43/#46/#47 与本批同步） |
| `docs/WORKFLOW.md` / `docs/ROADMAP` 引用 | ✓（#41「建立 ROADMAP.md」仍是待办，引用有效） |
| `TUI/docs/STATUS.md` | **滞后（报告，不改）**：命令面未含 `/continue`、CLI 启动参数、notice 渲染、`/stats` 双口径；且文中引用「`BACKLOG.md` §3」已随编号扁平化失效 |
| `docs/STATUS.md` | 指向 TUI STATUS，本身无冲突表述 |

## 决策

| # | 维度 | 选项 → 选定 | 理由 |
|---|------|------------|------|
| D1 | 修改范围 | **只改活文档**（`IMPLEMENTATION.md` / `README.md` / `DESIGN.md` / `AGENTS.md`）；`STATUS.md` 不改 | 仓库规范：STATUS 由用户择时更新 |
| D2 | #20 的登记位置 | README「已知限制」段（用户可见症状） | 与既有「模型/开关随会话恢复」限制同段、口径一致 |
| D3 | chalk 口径冲突 | 文档任务内**只立条目不改配置**（#25 交其他 agent） | 删依赖属产物性变更，需独立任务与人工确认 |
| D4 | `AGENTS.md` 的失效引用 | 直接删掉括注（不新增任务） | IMPLEMENTATION.md 拆分已无在办条目，属历史遗留 |

## 规划

计划改动文件清单（= 落点；计划外文件不改）：

- `TUI/docs/IMPLEMENTATION.md`（本地命令计数）
- `TUI/README.md`（已知限制补 #20）
- `TUI/docs/DESIGN.md`（会话生命周期补 #22/#23）
- `AGENTS.md`（删失效引用）
- `TUI/docs/BACKLOG.md`（#24 状态；#25 新条目）
- 本追踪文档（关闭时移入 `TUI/docs/archived/`）

明确不做：不改代码 / `package.json`（chalk 见 #25）、不改两份 `STATUS.md`、不做顺手优化。

## 实现记录

1. `TUI/docs/IMPLEMENTATION.md`：本地命令计数改「39 项 = 34 命令 + 5 别名」。
1. `TUI/README.md`：已知限制段新增「CLI 启动恢复不重放历史行（BACKLOG #20）」。
1. `TUI/docs/DESIGN.md`：会话生命周期追加 **TUI#22/#23** 口径（行首时间 = 编辑时间；`/continue`「最新会话」语义 + `hasPrompt` 探针；CLI `-c` 不受影响）。
1. `AGENTS.md`：删除「TUI/docs/IMPLEMENTATION.md 待按 BACKLOG #40 拆分」的失效括注。
1. `TUI/docs/BACKLOG.md`：#24 状态；途中发现登记 **#25**（未使用的 `chalk` 依赖，交其他 agent）。

## 测试与证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 过时点复核 | `grep -rn "36 项 = 32 命令\|待按 BACKLOG #40 拆分"` | 0 命中 |
| 新内容复核 | 三处 `grep -c`（计数行 / 已知限制 / DESIGN 口径） | 均 1 命中 |
| 自动化 | 仅文档改动，未跑代码测试；`format` 已对改动文件执行 | — |
| 未改（报告） | 两份 `STATUS.md` | `TUI/docs/STATUS.md` 滞后：缺 `/continue`、CLI 启动参数、notice 渲染、`/stats` 双口径；「BACKLOG §3」引用随扁平编号失效（用户择时更新） |

## 收尾

- `TUI/docs/BACKLOG.md` #24 标「完成」；本追踪文档移入 `TUI/docs/archived/`。
- 新条目 #25 留待其他 agent 接取（删/留 `chalk` 依赖需独立任务与人工确认）。
- 提交：按流程询问用户（本次为文档改动）。
