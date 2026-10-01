# executor 冒烟转常驻（接取条目：`task-engine/docs/BACKLOG.md`「executor 冒烟转常驻」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把 executor 主机适配层的临时冒烟（`tmp/task-executor-smoke.mjs`，14 步，已在「task-engine 执行扩展」收尾时按流程删除）转为包内**常驻**脚本，给出可重复执行、无宿主依赖的回归入口。

覆盖范围：**单测覆盖不到的 `src/main.ts` 适配层路径**——workflow 默认 meta 合并、`start` 同步抛错（声明错误）不打回、`cancelled` 反馈、证据截断、宿主服务惰性解析、subagent 的 `agentOptions` 映射与用量口径、command 真跑 `/bin/sh -c`、`execute → stop → join`。

## 调研

- 单测 62 例覆盖**引擎侧**（门禁 / `execute` 语义 / `retryable` / `structured` / 工具解析），不经过 `apply()` 的宿主接线。
- `demo/main.ts` 只演示 `subagent` 一个后端（`kind: "workflow"` 出现 0 次），且用自建 runner，踩不到 `main.ts` 的适配层。
- 该层的回归此前由 dist 级临时脚本承担（`apply()` + 假宿主面），收尾按「清理临时物」删除 → 目前无永久覆盖。真机验证过（三轮）但不可重复执行。

## 决策

| # | 决策点 | 选定 | 理由 |
|---|--------|------|------|
| D1 | 常驻脚本的形态（实现裁定） | **dist 级 + 假宿主面**：`import { apply } from "../dist/index.js"`，`ctx.get` 返回假服务；npm 入口 `smoke:executor`（前置 `npm run build`） | 适配层依赖宿主面结构，假服务可无宿主重复跑；仓库已有同类入口（TUI `demo -- --smoke`、`smoke:pty`） |
| D2 | 覆盖取舍（实现裁定） | 只覆盖**适配层路径**，不重复 gate / 工具解析用例 | 避免与单测重复，脚本保持小而可读 |

## 规划

### 计划改动文件清单

| 文件 | 改动 |
|------|------|
| `task-engine/scripts/executor-smoke.mjs` | 新增：dist 级冒烟（工具族含 `task_execute` / subagent 模型 + 预算 → `agentOptions` 与 pressure 口径用量 / 未声明模型不传 `agentOptions` / command 真跑 `/bin/sh` / workflow 默认 meta 合并 + 对象证据 / 同步抛错不打回不计重试 / `cancelled` 反馈 / 惰性服务解析 / 截断边界 / `execute → stop → join` 整树 done） |
| `task-engine/package.json` | 新增脚本 `smoke:executor` |
| `task-engine/README.md` | 「测试」段补 `npm run smoke:executor` 与覆盖说明 |
| `task-engine/docs/BACKLOG.md`、`task-engine/docs/implementation/2026-10-02-executor-smoke.md` | 本包首次建立模块文档树（条目 + 追踪文档） |
| `docs/archived/2026-10-02-injection-timing-naming-warn-executor.md` | 一行指针：临时冒烟已转常驻脚本，证据可复现 |

## 实现记录

1. **调研 + 决策（2026-10-02）**：确认缺口（单测 62 例在引擎侧、demo 0 处 `kind: "workflow"`、临时脚本已删）→ D1 / D2 定稿。
1. **实施（2026-10-02）**：新增 `scripts/executor-smoke.mjs`（22 项断言，8 组：工具族 + subagent / command / workflow 正常路径 / workflow 同步抛错 / `cancelled` / 惰性服务解析 / 截断边界 / `execute → stop → join`）；`package.json` 加 `smoke:executor`；README「测试」段补入口与覆盖说明（顺带修正 demo 的「演示 8-12」→「8-13」，演示 13 为执行后端）。
1. **本包文档树补齐（2026-10-02）**：task-engine 此前**无 `docs/` 目录**（「task-engine 执行扩展」的任务文档因此落在项目级、文档落点为包根 README）；本次按流程建立 `docs/{BACKLOG.md,implementation/,archived/}`，后续包内条目走本层。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `cd task-engine && npm run smoke:executor` | `SMOKE_PASS`（22 项断言全过，`exit 0`） |
| `cd task-engine && npm run check` / `npm run build` | 0 error（脚本为 JS，不进 tsc 图；构建产出供脚本加载） |
| `cd task-engine && npm test` | `tests 62 / pass 62 / fail 0`（既有单测；脚本不重复其覆盖） |
| `cd task-engine && npm run demo` | `DEMO_OK`（未改动 demo 逻辑，仅 README 更正演示编号） |

## 交接

**状态**：条目「executor 冒烟转常驻」完成；脚本已成为包内常驻回归入口（`npm run smoke:executor`）。

## 收尾

- 「executor 冒烟转常驻」：标「完成」并从 `task-engine/docs/BACKLOG.md` 清理；本文件移入 `task-engine/docs/archived/`。
- **回写**：`task-engine/README.md`（测试段入口 + 标记 demo 演示区间 8-13）；`docs/archived/2026-10-02-injection-timing-naming-warn-executor.md`（一行指针：临时冒烟已转常驻脚本，证据可复现）。
- **临时物**：无新增（脚本从 `tmp/` 转为包内 `scripts/`，不再随收尾删除）。
