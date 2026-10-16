# 上限参数的 0 语义统一为「不设上限」（接取条目：md-table-check/docs/BACKLOG.md「`maxTables: 0` 等上限参数的 0 语义统一为「不设上限」」）

状态：关闭　　开启：2026-10-16　　关闭：2026-10-16
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把 `maxTables` / `maxRowsPerTable` / `headerExcerptLimit` 三个上限参数的 `0` 统一解释为**不设上限**；未设与非法值仍回退缺省 `5` / `3` / `60`。消除「判定计数说有、提示说无」的语义分裂。

## 调研

来源：上一轮任务（`docs/archived/2026-10-16-test-coverage-and-tsconfig.md` 偏差 5）与代码复核。

1. 现状取值：`src/checker.ts:140`（`maxTables`）、`:143`（`maxRowsPerTable`）、`:219`（`headerExcerptLimit`）都走 `nonNegativeInt(options?.x, DEFAULT_X)`，即 `0` 被当作合法上限 0。
2. 现状后果：`maxTables: 0` → `:187` 的 `tables.length < 0` 永不成立 → 列表恒空 → `renderFeedback` 在 `:218` 返回 `null` → `decide`（`src/main.ts:127`）不注入，而 `tableTotal` / `lineTotal` 仍全量计数；`maxRowsPerTable: 0` → `slice(0, 0)` 使每张表列 0 行；`headerExcerptLimit: 0` → 摘录只剩 `…`。三处口径互不一致。
3. 缺省常量：`DEFAULT_MAX_TABLES = 5`、`DEFAULT_MAX_ROWS_PER_TABLE = 3`、`DEFAULT_HEADER_EXCERPT_LIMIT = 60`（`src/checker.ts:67-71`）。
4. 既有回归：`tests/checker.test.ts` 的「上限为 0」用例当时钉住旧行为（判定计数与提示为 `null` 的分裂），需按新口径改写；`README.md` 的配置表与「上限为 0 的口径」段需同步。

## 决策

1. `0` 的含义
   - a. 用缺省（`0` → `5` / `3` / `60`）
   - b. 关闭检查（判定也归零）
   - c. **不设上限**（列出全部）
   - **选定 c**（用户 2026-10-16 裁定，原话「两个都不, 统一为: 0 代表不设上限」）。理由：`0` 作为「不限」是上限类参数的常见口径，且一次消除三处语义分裂。
2. 适用范围
   - a. **三个上限参数统一**（`maxTables` / `maxRowsPerTable` / `headerExcerptLimit`）
   - b. 仅 `maxTables`
   - **选定 a**：用户指令用了「统一」；三者同为上限参数，只改一个会留下同类分裂。
3. 实现方式
   - a. 在使用处各自判断 `=== 0`
   - b. **新增一个 helper**（`limitOrInfinity(value, fallback)`：有限非负数按值、`0` 取 `Infinity`、否则回退缺省），三处共用
   - **选定 b**：单一来源，便于测试与后续新增上限参数。

## 规划

计划改动文件清单：

| 文件 | 改动 |
| --- | --- |
| `md-table-check/src/checker.ts` | `nonNegativeInt` → `limitOrInfinity`，三处上限取值改用它 |
| `md-table-check/tests/checker.test.ts` | 「上限为 0」用例按新口径改写（含缺省 / 负数 / `NaN` 回归） |
| `md-table-check/README.md` | 配置表补「0 = 不设上限」；「上限为 0 的口径」段改写 |
| `md-table-check/docs/BACKLOG.md` | 条目状态（进行中 → 关闭时清理） |
| `md-table-check/docs/implementation/2026-10-16-limit-zero-unbounded.md` | 本追踪文档 → 关闭后移入 `archived/` |

明确不做：`0` 回退缺省 / 关闭检查两种口径；新增配置项；`decide` 侧改动；TUI 侧任何改动。

## 实现记录

- 2026-10-16：建档并标〔进行中〕；三项决策落定（裁定 c + 范围 a + 实现 b）。
- 2026-10-16：`src/checker.ts` 的 `nonNegativeInt` 替换为 `limitOrInfinity`（`0` → `Number.POSITIVE_INFINITY`，未设 / 负数 / `NaN` / 非数 → 缺省），三处调用点同步。既有下游天然成立：`tables.length < Infinity` 恒真、`mismatches.slice(0, Infinity)` 取全量、`excerpt()` 的 `chars.length <= Infinity` 返回原文。
- 2026-10-16：`tests/checker.test.ts` 的「上限为 0」用例改写为「上限为 0 = 不设上限（三个上限参数统一; 缺省与非法值仍回退）」：`maxTables: 0` 列出全部 7 张（未设 → 缺省 5、显式 2 → 2）、`renderFeedback` 非 `null`；`maxRowsPerTable: 0` 列出全部 4 行（未设 → 3）；`headerExcerptLimit: 0` 摘录为表头原文；负数 / `NaN` 回退缺省。
- 2026-10-16：`README.md` 配置表两行补「`0` = 不设上限」、`headerExcerptLimit` 说明补「`0` = 不截断」、「上限为 0 的口径」段重写为新口径 + 沿革。

## 偏差

1. **适用范围按「统一」解读为三个上限参数**（用户指令原文含「统一」，且三者同为上限参数）；若用户只想改 `maxTables`，回退成本 = 把 `maxRowsPerTable` / `headerExcerptLimit` 两处调用点改回 `nonNegativeInt` 语义即可。
2. 无其它偏差：未动 `decide` / `src/main.ts`、未新增配置项、未动 TUI 侧。

## 测试与证据

- 包 `npm --prefix md-table-check run check`：退出码 **0**。
- 包 `npm test`：`ℹ tests 73 / pass 73 / fail 0`（用例数不变，1 例改写）。
- 覆盖率（`--test-coverage-include='src/**'`）：`src/checker.ts` 行 / 分支 / 函数 **100.00**；`src/main.ts` **100.00 / 100.00 / 100.00**。
- 反向验证：把 `limitOrInfinity` 的 `0 → Infinity` 一行撤成 `return Math.floor(value)` → `✖ 上限为 0 = 不设上限（三个上限参数统一; 缺省与非法值仍回退）`、`pass 29 / fail 1`；恢复 → `pass 30 / fail 0`（`tests/checker.test.ts` 单文件跑）。
- `format` 已对改动文件执行（`checker.ts` 无变化、`checker.test.ts` 有格式规范化、README / BACKLOG 由 mdformat 处理）。

## 收尾

- 回写：`md-table-check/README.md`（配置表 + 上限 0 口径段 + 沿革）；`docs/BACKLOG.md`（条目移除 + 关闭记录）。
- 归档：本文件移入 `md-table-check/docs/archived/2026-10-16-limit-zero-unbounded.md`。
- 遗留：无（上一轮任务的遗留项「上限 0 语义不一致」由此关闭）。
