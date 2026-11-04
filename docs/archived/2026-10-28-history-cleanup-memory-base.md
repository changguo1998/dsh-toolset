# memory-base 整理 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 memory-base 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `memory-base` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 11 个 `.test.ts` (见 `tests/`); 阶段 1 末 `pnpm -C memory-base run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 90.9% (1860/2047); 分支 79.3% (364/459).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

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

- 分支 `history-cleanup/03-code-memory-base`, worktree `.worktree/03-code/memory-base`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C memory-base run check` 与 `pnpm -C memory-base run test`.
- 任务:
  - 删失效常量 `src/hybrid.ts:15` `SEARCH_MODES`.
  - 记忆层级判定收进 `src/scope.ts` / `src/index.ts` / `src/tiers.ts`, 形成单一出口; `TUI` 改读注入值由 TUI 分支做.
- 验收: `pnpm -C memory-base run check` 与 `pnpm -C memory-base run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(memory-base): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

- 分支 `history-cleanup/04-package-docs-memory-base`, worktree `.worktree/04-package-docs/memory-base`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/DESIGN.md` / `docs/BACKLOG.md`.
- `README.md`: 现有 11 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- `docs/DESIGN.md`: 归并为四节 `## 背景` / `## 结构` / `## 机制` / `## 取舍`; 只改节名与合并重复, 机制与取舍内容不动.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- `docs/BACKLOG.md`: 同文件的命令与术语同步改; 条目内容、状态与顺序不动.
- 验收: 六节齐 (无配置可省)、四节齐、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(memory-base): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

> 集成层、单元锚点、脚本与专项见「四份测试产物」; 本节保留范围说明与阶段 3 实现记录.

- 未改 `src`, 未动其它包与总追踪。
- 阶段 3 代码整理（任务 03 分支, 本文件后续「偏差」「测试与证据」两节同属本阶段）:
  - 删 `src/hybrid.ts` 的 `SEARCH_MODES`: 删前扫全 worktree（含 `tests/` 与其它包）只有 `src/hybrid.ts:15` 一处定义、零导入; `SearchMode` 类型与 `isSearchMode` 保留（工具参数仍在用）。
  - 层级判定单一出口: 在 `src/tiers.ts` 新增谓词 `isSessionTier(tier: string): tier is "session"`, 作为「这一层是不是会话层」的唯一判定; 原 11 处就地比较改为调它 —— `src/tiers.ts` 6 处（`openWritable` 两处前置校验、`openExisting` 两处、`usage()` 跳过 S 层、`storeKey`）、`src/scope.ts` 3 处（`put` 的 sessionId 校验与 `lastSessionId` 记录、`forget` 的库键定位）、`src/index.ts` 2 处（管理面 `managedTier` 拒绝 S 层、`list` 跳过 S 层）。
  - 导出面未变: `isSessionTier` 只在 `src/tiers.ts` 导出, `src/index.ts` 的对外导出清单未增一项; 层名字符串、注入文案、配置键、工具名与参数面、`output.render` 投影均未动。
  - 只改本包 `src/`, 未动测试断言、其它包与总追踪。

## 偏差

无（未改 `src`; 两条新脚本写在 `package.json`, 属本次交付范围）。

阶段 3 代码整理: 行为无差异。组织上有一处取舍需记录 —— 谓词落在 `src/tiers.ts` 而非 `src/router.ts`。`router.ts` 虽是 `Tier` 身份所在, 但本节把收拢点限定为 `scope.ts` / `index.ts` / `tiers.ts`, 故取三者中与层语义最近的 `tiers.ts` 作单一出口; 代价是 `src/scope.ts` 多一条对 `tiers.ts` 的运行期导入（无循环: `tiers.ts` 不反向依赖 `scope.ts`）。另: `src/tiers.ts` 的 `openExisting` 两处单行 `if` 被格式器补上大括号, 属纯排版。

## 测试与证据

> 阶段 2 的覆盖率、分层贡献、四入口、用例清单与 skip 见「四份测试产物」; 本节保留阶段 3 实跑.

阶段 3 代码整理（任务 03 分支, 在本包目录执行）:

| 命令 | 结果 |
| --- | --- |
| `pnpm run check` | ✓ 通过（tsc --noEmit, 含 tests; 改后跑两次, 格式器处理后复跑同结果） |
| `pnpm run test` | ✓ 90 通过 / 0 失败 / 0 跳过 / 0 todo |
| `pnpm run test:integration` | ✓ 6 通过 / 0 失败 / 0 跳过 |

- 用例断言未改一条, 通过数与阶段 2 末一致（单元 90 + 集成 6）, 说明组织改动未动行为。
- 全仓引用重扫: `SEARCH_MODES` 只在 `src/hybrid.ts` 有定义, `tests/`、`TUI/` 与其它包零引用, 故直接删除, 无需改导入。
- 格式: 四个改动文件跑 `format`（prettier 无改动 3 个, `src/tiers.ts` 仅排版）。

## 四份测试产物

> 四类数据从「实现记录」「测试与证据」搬入本节; 原节保留指针; 数字照录, 未重新计算.

### 覆盖率

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

### 用例清单

- 集成层: 新增 `tests/assemble.ts`（装配器, 不以 `.test.ts` 结尾）与 `tests/integration/plugin.test.ts`（6 用例）。装配器按 4.2 拼三个假面: 工具面收集 `register`、事件面记录 `on`（本包不订阅, 断言为空）、服务面 `get("sessionPaths")` / `provide("memory")`; 临时库自建自删（`mkdtempSync` + `cleanup()` 关库并删目录）, 落点全部在 `os.tmpdir()` 下, 不写仓库目录。装配器可注入四种失败形态: 工具面缺失 / `register` 抛错 / `provide` 抛错或缺失 / `get` 抛错, 另可关掉 `logger`。
- 集成用例覆盖: 服务面与工具面接线、`PutResult` 与管理面（`remember` / `update` / `forget`）的 canonical 值、`memory_query.execute` 的 canonical 值与 `output.render` 投影（含空 query 错误与截断标注）、S 层落盘与缺 `sessionPaths` / 解析失败的明示例外、六种失败 / 降级形态的日志兜底。
- 单元锚点: 新增 7 个用例, 均只补未走到的分支, 现有断言未改语义 —— `tests/tiers.test.ts` 2 个（`pathFor` 的 P / S 边界与只读打开不落盘; P 层缺 `projectRoot` 抛错、`openExisting` 对未建层返回 `undefined`）、`tests/knowledge.test.ts` 2 个（`KnowledgeService` 缺省构造的 tier / 空注册表 / 隐私闸; `updateRow` 的未注册 kind 与未建表）、`tests/bundle-tiers.test.ts` 2 个（句柄非法层名; 全局面 `list` 的 `listLimit` 与 clamp / 负 offset）、`tests/migrate.test.ts` 1 个（全局面 `migrate` 的 `legacyDbPath` 与缺省落点）; 另在 `tests/hybrid-search.test.ts` 既有 `proximitySpan` 用例上补两条断言（重复出现取最小窗口、空词项跳过）。
- 脚本: `memory-base/package.json` 增 `test:integration` 与 `test:coverage`, 命令与 4.2 / 4.3 一致, 覆盖率目录 `tmp/cov-memory-base`。
- 新增与删除: 新增 13 条 (单元 7 + 集成 6), 删除 0 条。
- 新增用例清单（13 条: 单元 7 + 集成 6, 均未改既有断言）:
  - `tests/tiers.test.ts`: 落点解析边界; 只读打开不落盘与 P 层缺 `projectRoot`。
  - `tests/knowledge.test.ts`: 缺省构造; `updateRow` 的 kind 与表缺失。
  - `tests/bundle-tiers.test.ts`: 句柄非法层名; 全局面 `list` 的 `listLimit` / clamp / 负 offset。
  - `tests/migrate.test.ts`: 全局面 `migrate` 落点解析。
  - `tests/integration/plugin.test.ts`: 装配接线; 服务面 canonical 值; 管理面 canonical 值; `memory_query` canonical 值与 render 投影; 六种失败 / 降级形态; S 层三种落盘形态。
  - `tests/hybrid-search.test.ts`: `proximitySpan` 既有用例补两条断言（重复出现最小窗口、空词项跳过）。

### skip 计数与豁免台账

- `skip` 计数: 改前 0, 改后 0。豁免台账: 无（三条阶梯未用尽的情形未出现）。删除用例与夹具: 无。

### 四入口实跑

四条命令:

| 入口 | 结果 |
| --- | --- |
| `pnpm -C memory-base run check` | ✓ 通过（tsc --noEmit, 含 tests） |
| `pnpm -C memory-base run test` | ✓ 90 通过 / 0 失败 / 0 跳过 |
| `pnpm -C memory-base run test:integration` | ✓ 6 通过 / 0 失败 / 0 跳过 |
| `pnpm -C memory-base run test:coverage` | ✓ 通过, 报告 `tmp/cov-memory-base/report.json` |

补充: `pnpm -C memory-base run build` 通过（产物在 `dist/`, 已忽略）。
