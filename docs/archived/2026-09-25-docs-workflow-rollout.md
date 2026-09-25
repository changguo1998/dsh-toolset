# 文档体系与变更规范落地（BACKLOG: 项目级 #39）

状态：关闭　　开启：2026-09-25　　关闭：2026-09-25
条目：`docs/BACKLOG.md` #39（开工时原名 `docs/BACKLOG.md`，本条目内改名）
本文件是本条目**唯一**的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. 确立文档分层与变更流程：`ROADMAP` → `DESIGN` → `BACKLOG 条目` → `docs/implementation/` 追踪文档 → 关闭归档。
1. 统一命名：BACKLOG / STATUS 采用短名；模块（TUI 与 12 个包）各自 `docs/` 管理自己的 DESIGN / BACKLOG。
1. 规范落两份：`AGENTS.md` 简版（每轮可读）+ `docs/WORKFLOW.md` 详版。

## 调研

- 现状痛点（本会话实测）：
  - 文档混放：宿主面（官方接口研读、升级文档）、项目面（现状、待办）、模块面（TUI 设计规格）曾同在 `docs/` 下，看不出哪些会过期（已于 2026-09-25 分三处：`docs/host/`、`docs/`、`TUI/docs/`）。
  - 重复维护：文档索引曾在 README 与 AGENTS 各一份；命令清单与判定理由散在三份文档（已合并单一来源）。
  - 过程无落点：变更的调研、决策、理由写在对话里，落盘时只剩结论，事后无法复盘。
  - `TUI/docs/IMPLEMENTATION.md`（实现要点，366 行）与流程用的 `implementation/` 目录同名易混，且其内容混了架构、规格、决策留痕三类。
- 约束：单人项目（开发 = 维护 = 使用）+ 多 agent 执行；agent 不会自动重读外部文档，规则必须写在每轮可读到的位置。

## 决策

> 2026-09-25 追加两条规则（用户补充，已并入 `docs/WORKFLOW.md` §3、§5 与 `AGENTS.md` 简版）：
>
> - **任务与条目非一一对应**：一个任务（追踪文档）可同时接取多个 BACKLOG 条目，接取时对每个条目标「进行中」、完成时对每个条目标「完成」；追踪文档只归档一次。
> - **提交询问点**：决策完成后 / 代码实现后 / 测试通过后 / 任务关闭后，四个点各主动询问一次是否提交，由用户决定提交与否与粒度。

| 议题 | 选项 | 选定 | 理由 |
|---|---|---|---|
| 分层 | 按文档类型（现状/待办/参考…） vs 按开发阶段 | **按开发阶段**：ROADMAP → DESIGN → BACKLOG → 追踪文档 → 归档 | 阶段即流程，每类文档有明确的生命周期与唯一落点 |
| ROADMAP 层级 | 项目级 + 模块级 vs 仅项目级 | **仅项目级** `docs/ROADMAP.md` | 方向是整体的；模块方向由项目 ROADMAP 与模块 DESIGN 表达 |
| 模块范围 | 仅 TUI vs TUI + 12 包 | **TUI + 12 包各自 `docs/`** | DESIGN / BACKLOG / 追踪文档按模块独立管理，避免跨模块互相污染 |
| BACKLOG 状态切换 | 多状态流转 vs 只写两次 | **只写两次**：开工标「进行中」、完成标「完成」 | 中途状态在追踪文档里演进，BACKLOG 保持稳定、便于对照 |
| 过程中可改的文档 | 允许顺手改其他文档 vs 禁止 | **禁止**：所有过程记录只写追踪文档，计划外文件不改 | 单人 + 多 agent 场景下，「顺手改」是文档漂移的主要来源 |
| 途中发现新问题 | 记在当前条目里一起做 vs 追加新条目 | **追加新 BACKLOG 条目**交其他 agent | 保持条目边界清晰、可并行 |
| STATUS 定位 | 流程必改 vs 参考文档 | **对照文档**：记录已实现内容，可由 BACKLOG + 追踪文档推导；更新时机与执行者由用户临时决定 | 避免流程自动改状态文档产生漂移 |
| 归档归属 | 统一根 archive vs 分层 | **分层**：模块 `docs/archived/` 与项目级 `docs/archived/` 各管自己；根 `archive/` 只归档根级已关闭文档 | 归属清晰，避免历史资料混堆 |
| 规范放哪 | 全塞 AGENTS vs 拆两份 | **`AGENTS.md` 简版 + `docs/WORKFLOW.md` 详版** | AGENTS 每轮可读但要短；细节需要可演进的详版 |

## 规划

### 计划改动文件清单（本条目只动这些 + 本追踪文档）

1. `docs/BACKLOG.md` → 改名 `docs/BACKLOG.md`，并加 #39（进行中）/#40（待办）
1. `docs/STATUS.md` → 改名 `docs/STATUS.md`
1. `docs/WORKFLOW.md`（新建，详版规范）
1. `AGENTS.md`（加简版规范一节；修订「结构与约定」中与文档分级、STATUS、命名的条目）
1. `README.md`（文档索引更新：新路径、新文件、分层说明）
1. `fs-digest/docs/BACKLOG.md` → `fs-digest/docs/BACKLOG.md`
1. `TUI/docs/DESIGN.md` → `TUI/docs/DESIGN.md`（`design/` 只留内部规范）
1. `knowledge-base/docs/DESIGN.md` → `knowledge-base/docs/DESIGN.md`
1. `output-compress/docs/DESIGN.md` → `output-compress/docs/DESIGN.md`
1. `code-map/docs/DESIGN.md` → `code-map/docs/DESIGN.md`
1. 引用重写：凡引用上述路径的既有文件（含 `docs/host/`、`TUI/docs/`、各包 README、`archive/`、源码注释、测试）
1. 目录：`docs/implementation/`（本文件所在）、`docs/archived/`、各模块 `docs/implementation/` 与 `docs/archived/`

### 不在本条目内（已另开或另行决定）

- `TUI/docs/IMPLEMENTATION.md` 的拆分与删除 → 新条目 #40，另派 agent
- 各模块空的 `implementation/`、`docs/archived/` 目录不预建（git 不跟踪空目录），按需创建
- `docs/STATUS.md`（原 `DEVELOPMENT-STATUS.md`）的**内容**重写：由维护者择时处理——本条目只改名，不改其内容

### 任务拆分

1. 开条目并标注「进行中」+ 建本追踪文档（已完成于本文件创建时）
1. 写 `docs/WORKFLOW.md`（详版）
1. 改 `AGENTS.md`（简版 + 相关条目修订）
1. 改名与目录调整（清单 1、2、6、7、8、9、10）
1. 引用重写与残留检查
1. 更新 `README.md` 索引
1. 自检：`format` + 残留路径检查 +（涉及源码注释）`npm run check`
1. 收尾：回写清单、关闭条目、追踪文档移入 `docs/archived/`

## 实现记录

- 2026-09-25：条目 #39 加入项目级 BACKLOG（标「进行中」）；本追踪文档创建，计划改动文件清单确定；#40 作为途中发现项另行登记。
- 2026-09-25（续）：`docs/WORKFLOW.md`（详版）与 `AGENTS.md`「内容变更规范（简版）」写就；`AGENTS.md` 相关条目同步修订（文档索引与分级、模块文档自管、缺陷与待办归属、archive 归属、设计与机制沉淀位置、文首分工说明）。
- 2026-09-25（续）：改名与目录调整完成——`docs/DEVELOPMENT-BACKLOG.md` → `docs/BACKLOG.md`、`docs/DEVELOPMENT-STATUS.md` → `docs/STATUS.md`、`fs-digest/BACKLOG.md` → `fs-digest/docs/BACKLOG.md`、`TUI/docs/design/DESIGN.md` → `TUI/docs/DESIGN.md`、`knowledge-base|output-compress|code-map/DESIGN.md` → `<包>/docs/DESIGN.md`；四个包的 `docs/` 随之建立。
- 2026-09-25（续）：引用重写 38 个文件（`DEVELOPMENT-BACKLOG.md` 15 处、`DEVELOPMENT-STATUS.md` 14 处、`fs-digest/BACKLOG.md` 4 处、`TUI/docs/design/DESIGN.md` 49 处、包级 `DESIGN.md` 9 处）；`README.md`「文档」一节按项目级 / 宿主面 / 模块级三层重写。
- 2026-09-25（续）：途中发现两处**不在本条目计划内**的事项，按规范追加条目而非顺手处理——#40（`TUI/docs/IMPLEMENTATION.md` 按新规范拆分后删除）、#41（建立 `docs/ROADMAP.md`，内容需维护者提供）。`docs/archived/` 与各模块 `implementation/`、`archived/` 目录按决策**不预建**（空目录 git 不跟踪），按需创建。

## 测试与证据

- 残留检查（2026-09-25，tracked 文件全量 grep）：`DEVELOPMENT-BACKLOG` 0 个文件、`DEVELOPMENT-STATUS` 0 个文件、`fs-digest/BACKLOG.md` 0 个文件、`TUI/docs/design/DESIGN.md` 0 个文件；`knowledge-base` / `output-compress` / `code-map` 的 `DESIGN.md` 已不在包根。
- 结构核对：`docs/` = `BACKLOG.md` / `STATUS.md` / `WORKFLOW.md` / `host/` / `implementation/`；`TUI/docs/` = `DESIGN.md` / `BACKLOG.md` / `STATUS.md` / `SPEC.md` / `COMMANDS.md` / `COMMANDS-SPEC.md` / `IMPLEMENTATION.md`（待 #40 拆分）/ `design/`（三份内部规范）。
- `npm run check`：通过（0 处 TS 错误；源码与测试注释中的文档路径已随重写更新）。
- `format`：25 个改动的 Markdown 文件已格式化（`AGENTS.md`、`docs/WORKFLOW.md`、`docs/BACKLOG.md`、`docs/STATUS.md`、`README.md`、`docs/host/*`、`TUI/docs/*`、各包 README / DESIGN 等）。
- 未能核对的部分：`docs/STATUS.md` 的**内容**未按其新定位（对照文档）重写，属遗留（由维护者择时处理）。

## 收尾

- **回写**：`README.md`（文档索引按项目级 / 宿主面 / 模块级重写）、`AGENTS.md`（新增「内容变更规范（简版）」并修订相关条目）、各模块文档首部路径随改名更新；`DESIGN.md` 无需回写（不涉及架构变化），`ROADMAP.md` 尚未建立（见 #41）。
- **遗留项**：#40（`TUI/docs/IMPLEMENTATION.md` 拆分后删除）、#41（建立 `docs/ROADMAP.md`）为独立条目，本任务不代做；`docs/STATUS.md` 的**内容**重写由维护者择时处理。
- **关闭**：条目 #39 标「完成」（2026-09-25）；本追踪文档移入 `docs/archived/`。
