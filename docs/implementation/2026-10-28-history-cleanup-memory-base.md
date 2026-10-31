# memory-base 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 memory-base 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `memory-base` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 11 个 `.test.ts` (见 `tests/`); 阶段 1 末 `pnpm -C memory-base run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 90.9% (1860/2047); 分支 79.3% (364/459).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C memory-base run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-memory-base && mkdir -p ../tmp/cov-memory-base && NODE_V8_COVERAGE=../tmp/cov-memory-base node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-memory-base tmp/cov-memory-base/report.json
```

- 专项: -.
- 验收: `pnpm -C memory-base run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 memory-base 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

- 集成层: 新增 `tests/assemble.ts`（装配器, 不以 `.test.ts` 结尾）与 `tests/integration/plugin.test.ts`（6 用例）。装配器按 4.2 拼三个假面: 工具面收集 `register`、事件面记录 `on`（本包不订阅, 断言为空）、服务面 `get("sessionPaths")` / `provide("memory")`; 临时库自建自删（`mkdtempSync` + `cleanup()` 关库并删目录）, 落点全部在 `os.tmpdir()` 下, 不写仓库目录。装配器可注入四种失败形态: 工具面缺失 / `register` 抛错 / `provide` 抛错或缺失 / `get` 抛错, 另可关掉 `logger`。
- 集成用例覆盖: 服务面与工具面接线、`PutResult` 与管理面（`remember` / `update` / `forget`）的 canonical 值、`memory_query.execute` 的 canonical 值与 `output.render` 投影（含空 query 错误与截断标注）、S 层落盘与缺 `sessionPaths` / 解析失败的明示例外、六种失败 / 降级形态的日志兜底。
- 单元锚点: 新增 7 个用例, 均只补未走到的分支, 现有断言未改语义 —— `tests/tiers.test.ts` 2 个（`pathFor` 的 P / S 边界与只读打开不落盘; P 层缺 `projectRoot` 抛错、`openExisting` 对未建层返回 `undefined`）、`tests/knowledge.test.ts` 2 个（`KnowledgeService` 缺省构造的 tier / 空注册表 / 隐私闸; `updateRow` 的未注册 kind 与未建表）、`tests/bundle-tiers.test.ts` 2 个（句柄非法层名; 全局面 `list` 的 `listLimit` 与 clamp / 负 offset）、`tests/migrate.test.ts` 1 个（全局面 `migrate` 的 `legacyDbPath` 与缺省落点）; 另在 `tests/hybrid-search.test.ts` 既有 `proximitySpan` 用例上补两条断言（重复出现取最小窗口、空词项跳过）。
- 脚本: `memory-base/package.json` 增 `test:integration` 与 `test:coverage`, 命令与 4.2 / 4.3 一致, 覆盖率目录 `tmp/cov-memory-base`。
- 专项（4.4）: 本包测试代码 `skip` 0 处、`todo` 0 处, 无夹具文件引用, 无需处置项。
- 未改 `src`, 未动其它包与总追踪。

## 偏差

无（未改 `src`; 两条新脚本写在 `package.json`, 属本次交付范围）。

## 测试与证据

改前（单元层, 本分支开工前）:

| 包 | 行 | 分支 |
| --- | --- | --- |
| memory-base | 90.9% (1860/2047) | 79.3% (364/459) |

改后（单元 + 集成, `pnpm -C memory-base run test:coverage`）:

| 包 | 行 | 分支 |
| --- | --- | --- |
| memory-base | 93.0% (1903/2047) | 82.7% (412/498) |

逐文件（改前 → 改后）:

| 文件 | 行 | 分支 |
| --- | --- | --- |
| src/hybrid.ts | 95.1% (98/103) → 96.1% (99/103) | 82.1% (23/28) → 86.7% (26/30) |
| src/index.ts | 86.4% (344/398) → 93.0% (370/398) | 71.1% (54/76) → 79.3% (69/87) |
| src/knowledge.ts | 90.3% (547/606) → 89.9% (545/606) | 83.6% (107/128) → 82.0% (109/133) |
| src/migrate.ts | 100% (42/42) → 100% (42/42) | 100% (6/6) → 100% (8/8) |
| src/router.ts | 92.9% (92/99) → 92.9% (92/99) | 82.8% (24/29) → 82.8% (24/29) |
| src/rules.ts | 100% (59/59) → 100% (59/59) | 94.1% (16/17) → 94.1% (16/17) |
| src/schema.ts | 96.8% (153/158) → 96.8% (153/158) | 87.5% (14/16) → 87.5% (14/16) |
| src/scope.ts | 80.2% (85/106) → 93.4% (99/106) | 63.6% (14/22) → 85.7% (24/28) |
| src/tiers.ts | 88.5% (224/253) → 90.5% (229/253) | 75.6% (62/82) → 81.4% (70/86) |
| src/tools.ts | 96.9% (216/223) → 96.4% (215/223) | 80.0% (44/55) → 81.3% (52/64) |

- 整包只升不降: 行 +2.1 个百分点, 分支 +3.4 个百分点。
- `knowledge.ts` 与 `tools.ts` 的逐文件行覆盖各差 1 至 2 行（分支分母反而变大, 新增分支被走到）; 属 V8 range 在 `--experimental-transform-types` 下按转译偏移聚合的抖动, 与新增用例无反向关系, 整包数据为准。
- 分层贡献（两次跑取差）: 只跑单元层 91.8% (1880/2047) / 80.8% (387/479), 加集成层 93.0% (1903/2047) / 82.7% (412/498), 集成层贡献 +1.2 行、+1.9 分支（多发现的 19 个分支 range 全部由集成用例走到）。

四条命令:

| 命令 | 结果 |
| --- | --- |
| `pnpm -C memory-base run check` | ✓ 通过（tsc --noEmit, 含 tests） |
| `pnpm -C memory-base run test` | ✓ 90 通过 / 0 失败 / 0 跳过 |
| `pnpm -C memory-base run test:integration` | ✓ 6 通过 / 0 失败 / 0 跳过 |
| `pnpm -C memory-base run test:coverage` | ✓ 通过, 报告 `tmp/cov-memory-base/report.json` |

补充: `pnpm -C memory-base run build` 通过（产物在 `dist/`, 已忽略）。

新增用例清单（13 条: 单元 7 + 集成 6, 均未改既有断言）:

- `tests/tiers.test.ts`: 落点解析边界; 只读打开不落盘与 P 层缺 `projectRoot`。
- `tests/knowledge.test.ts`: 缺省构造; `updateRow` 的 kind 与表缺失。
- `tests/bundle-tiers.test.ts`: 句柄非法层名; 全局面 `list` 的 `listLimit` / clamp / 负 offset。
- `tests/migrate.test.ts`: 全局面 `migrate` 落点解析。
- `tests/integration/plugin.test.ts`: 装配接线; 服务面 canonical 值; 管理面 canonical 值; `memory_query` canonical 值与 render 投影; 六种失败 / 降级形态; S 层三种落盘形态。
- `tests/hybrid-search.test.ts`: `proximitySpan` 既有用例补两条断言（重复出现最小窗口、空词项跳过）。

`skip` 计数: 改前 0, 改后 0。豁免台账: 无（三条阶梯未用尽的情形未出现）。删除用例与夹具: 无。
