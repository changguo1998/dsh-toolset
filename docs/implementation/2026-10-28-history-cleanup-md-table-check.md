# md-table-check 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 md-table-check 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `md-table-check` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 8 个 `.test.ts` (`checker.test.ts` / `displaySurface.test.ts` / `formMatrixSnapshot.test.ts` / `integration.test.ts` / `main.test.ts` / `reasoningSeparation.test.ts` / `surfaceDifferential.test.ts` / `tuiParity.test.ts`); 阶段 1 末 `pnpm -C md-table-check run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 100.0% (273/273); 分支 99.0% (99/100).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C md-table-check run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-md-table-check && mkdir -p ../tmp/cov-md-table-check && NODE_V8_COVERAGE=../tmp/cov-md-table-check node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-md-table-check tmp/cov-md-table-check/report.json
```

- 专项: -.
- 验收: `pnpm -C md-table-check run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 md-table-check 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

2026-10-28 在分支 `history-cleanup/02-tests-md-table-check` 完成, 未改 `src`.

- 基线: `pnpm -C md-table-check run test` 73 条通过 (223 ms), `check` 通过; 覆盖率行 100.0% (273/273)、分支 99.0% (99/100), 与阶段 1 末记录一致.
- 单元锚点: `tests/checker.test.ts` 末尾追加 1 条 (32 行)「边界: 空单元格行(单个竖线)不成表, 非有限上限回退缺省」: `splitCells("|")` / `splitCells(" | ")` 返回空数组; 空表头、空分隔行、缺分隔行都不成表; `maxRowsPerTable: Infinity` 回退缺省 3 行. 现有断言未改.
- 集成层: 新增 `tests/assemble.ts` (假 rule-engine 注册面 + 假 `assistant-text` 派发面 + 注入投影, 末缀不是 `.test.ts`) 与 `tests/integration/plugin.test.ts` 13 条: 注册与注销、`ctx.get` 回退、缺席告警、列数判定两态、围栏、提示正文各字段、`maxTables` / `maxRowsPerTable` 裁剪、超长表头摘录、消息投影形状与 summary、`delivery` 三路、`enabled: false`、`sources` 不在 `assistant-text`.
- 脚本: `package.json` 加 `test:integration` (`tests/integration/*.test.ts`) 与 `test:coverage` (覆盖命令按本文件「测试」节的写法, 参数 `tmp/cov-md-table-check`).

## 偏差

- 「`output.render` 投影」在本包没有对应面: 本包不注册工具、不产出 `output.render`. 集成层按 rule-engine 真实注入器 (`rule-engine/src/inject.ts` 的 `buildInjectionMessage`) 的消息构造做投影断言 —— `[RULE] ` 前缀正文、`source.kind` 非空、`source.summary` 可识别、`delivery` 决定送达路径 —— 与会话事件的注入内容断言一致, 未简化成只断返回值.
- 唯一未覆盖分支 (分支 66/67) 是覆盖率聚合的假阴性, 不是真实缺口: V8 对未执行函数只报合并后的零命中块, 执行过的进程则把同一区间拆成两个子块 (均命中), `dev/coverage/report.mjs` 按偏移精确匹配, 合并块这一键始终停在 0. 单进程直接取 `maxTables` / `maxRowsPerTable` / `headerExcerptLimit` 的 undefined / -1 / NaN / Infinity / 0 / 3 / 1.7 全部形态, 该函数 6/6 块全命中; 三个上限的非法值与 0 也都有单元断言. 按 4.3 「不可达的防御分支」口径记在这里, 不为此补用例.

## 测试与证据

四条命令 (分支 `history-cleanup/02-tests-md-table-check`, 提交 `test: 补 md-table-check 测试锚定` 前的实跑):

| 命令 | 结果 |
| --- | --- |
| `pnpm -C md-table-check run check` | ✓ 通过 (`tsc -p tsconfig.json --noEmit` + `tsc -p tests/tsconfig.json`, 无输出) |
| `pnpm -C md-table-check run test` | ✓ 74 条通过, 失败 0, skipped 0, todo 0 (219 ms) |
| `pnpm -C md-table-check run test:integration` | ✓ 13 条通过, 失败 0, skipped 0, todo 0 (78 ms) |
| `pnpm -C md-table-check run test:coverage` | ✓ 两轮跑全通过, 产出 `tmp/cov-md-table-check/report.json` 与每包表 |

覆盖率 (只统 `src`, 改前 = 单元层, 改后 = 单元层加集成层):

| 文件 | 行 (改前) | 分支 (改前) | 行 (改后) | 分支 (改后) | 未覆盖行 |
| --- | --- | --- | --- | --- | --- |
| `md-table-check/src/checker.ts` | 100.0% (176/176) | 98.5% (66/67) | 100.0% (176/176) | 98.5% (66/67) | - |
| `md-table-check/src/index.ts` | 100.0% (97/97) | 100.0% (33/33) | 100.0% (97/97) | 100.0% (33/33) | - |
| 合计 | 100.0% (273/273) | 99.0% (99/100) | 100.0% (273/273) | 99.0% (99/100) | - |

- 分层贡献 (4.3 两轮取差): 单元层 273/273 行、99/100 分支; 单元层加集成层仍 273/273、99/100, 差值 0 行 0 分支 —— 集成层验的是接线与投影, 不新增 `src` 覆盖, 与「单元层已 100% 行」的现状一致.
- 行与分支均未下降; 无删除代码.
- 4.4 复核: 本包 `skip` 0 处、`todo` 0 处、无 `tests/fixtures/`, 无处置项; 新用例标题均为中文短句、不含宿主版本号.
