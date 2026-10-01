# 补 DESIGN.md + STATUS.md 回写（接取条目：`task-engine/docs/BACKLOG.md`「补 `docs/DESIGN.md`（架构与设计取舍）」、「`docs/STATUS.md` 状态表回写」）

状态：实现　　开启：2026-10-02　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. **补 `task-engine/docs/DESIGN.md`**：与其它 16 个包同构的模块设计文档（目标与边界 / 分层 / 关键设计取舍），把散落在 README 与源码注释里的架构决策沉淀下来（帧栈不变量、双重门禁、RET 路由、事件溯源、执行后端、宿主访问口径）。
1. **回写 `docs/STATUS.md` 的 task-engine 行**：该表由用户择时更新，本次经用户裁定「两个收尾」授权代为回写——补齐叶子执行后端能力与实测单测数（42 → 62）。

## 调研

- 现状：`task-engine/` 无 `docs/DESIGN.md`（17 个包中唯一；`rule-engine` / `session-channel` / `symbol-normalizer` / TUI 均有）。架构信息当前分布在：README「能力」「边界与限制」、`src/engine.ts` 注释（帧状态机 / join / bounded retry）、`docs/archived/2026-10-02-injection-timing-naming-warn-executor.md`（执行后端 ① ② 的裁定与真机教训）。
- 参照体例：`rule-engine/docs/DESIGN.md`（110 行）：`目标与边界` / `分层`（含 text 目录树）/ `关键设计取舍`（逐条编号 + 理由）。
- `docs/STATUS.md`：43 行，`总览` + `状态表`（插件 / 阶段 / 状态 / 备注，备注含单测数）；task-engine 行 = 「Frame 状态机、decompose/implement/stop/status 工具族、机械+语义门禁、RET 三级路由、fan-out 就绪池，42 单测」。

## 决策

| # | 决策点 | 选定 | 理由 |
|---|--------|------|------|
| D1 | DESIGN.md 的详略（实现裁定） | 与同类包同构、**约 120 行**：只写「为什么这么设计」与不变量，能力清单 / 用法仍归 README | 避免与 README 重复；README 是契约面，DESIGN 是取舍与约束面 |
| D2 | STATUS.md 的回写范围（实现裁定） | **只改 task-engine 行**（能力 + 单测数）；其它行与总览的疑似过期项**不改**，在报告中列给用户裁定 | 本次授权语境是 task-engine 收尾；跨包状态需逐包核对，不宜顺手改 |

## 规划

### 计划改动文件清单

| 文件 | 改动 |
|------|------|
| `task-engine/docs/DESIGN.md` | 新增：目标与边界 / 分层（text 树）/ 关键设计取舍（帧栈不变量与事件溯源、双重门禁、RET 三级路由与 fail-closed、bounded retry 与 abort 回收、叶子执行后端与 `executor` 契约、宿主访问与惰性服务解析、只读查询面与工具族、Config 松口径、边界外包） |
| `docs/STATUS.md` | task-engine 行：备注补叶子执行后端（`executor` + `task_execute`，2026-10-02）与单测数 42 → 62 |
| `task-engine/README.md` | 「目录结构」补 `scripts/executor-smoke.mjs`（上一提交新增未登记） |
| `task-engine/docs/BACKLOG.md`、`task-engine/docs/implementation/2026-10-02-design-and-status.md` | 条目与过程记录 |

## 实现记录

1. **调研（2026-10-02）**：核对文档分布——17 个包中只有 task-engine 无 `docs/DESIGN.md`（`rule-engine` / `session-channel` / `symbol-normalizer` / TUI 均有）；参照 `rule-engine/docs/DESIGN.md`（110 行，`目标与边界` / `分层` / `关键设计取舍`）定 D1；核对 `docs/STATUS.md` 的 task-engine 行与实测值（62 单测）定 D2。
1. **实施（2026-10-02）**：新增 `task-engine/docs/DESIGN.md`（11 条取舍：事件溯源物化 / 双重门禁 / RET 三级路由 / join 合取复核 / 就绪池只有 claim 语义 / `executor` 契约 / 失败分流 / 计量口径 / 宿主服务惰性解析（含真机教训）/ 查询面与工具面分离 / Config 松口径）；README「目录结构」补 `scripts/` 与 `docs/` 两行、补文档索引指向；`docs/STATUS.md` task-engine 行补执行后端能力与 62 单测。
1. **途中发现并记条目（2026-10-02）**：撰写 DESIGN 时核实 `main.ts` 只接 `runCommand` / `snapshotPath` / `maxConcurrent` → semantic 验收（`audit`）缺 hook 时一律 fail-closed、语义蕴含门（`entail`）跳过，即「双重门禁」的语义半边在真机不生效；此前仅有 README 的边界说明、**无接线条目** → 新增模块条目「语义面接线（`audit` / `entail`）」。

## 测试与证据

| 命令 / 检查 | 结果 |
| --- | --- |
| `cd task-engine && npm run smoke:executor` | `SMOKE_PASS`（22 项断言；本次仅文档改动，作回归确认） |
| `cd task-engine && npm test` | `tests 62 / pass 62 / fail 0` |
| `cd task-engine && npm run check` | 0 error（本次无代码改动） |
| 文档与源码逐条核对 | 事件 11 种（`plan/*` 去重后）、`GateRule` 7 种、`DEFAULT_GATE` 3 值（7 / 3 / 4）、工具 5 个、`Config` 4 字段、`provide('taskEngine')` 2 个只读方法、`MAX_EVIDENCE_CHARS = 8000` —— 均与 `src/` 实测一致 |

## 交接

**状态**：两条条目完成（`docs/DESIGN.md` 补齐、`docs/STATUS.md` 行回写）；途中发现并新记条目「语义面接线（`audit` / `entail`）」留给后续。**未改动**：`STATUS.md` 其它行与「总览」段的疑似过期项（本次授权语境仅 task-engine 行）。

## 收尾

- 「补 `docs/DESIGN.md`（架构与设计取舍）」「`docs/STATUS.md` 状态表回写（task-engine 行）」：标「完成」并从 `task-engine/docs/BACKLOG.md` 清理（该文件保留未完成的「语义面接线」条目）；本文件移入 `task-engine/docs/archived/`。
- **回写**：`task-engine/README.md`（目录结构 + 文档索引）；`docs/STATUS.md`（task-engine 行，经用户裁定授权）。
- **临时物**：无新增。
