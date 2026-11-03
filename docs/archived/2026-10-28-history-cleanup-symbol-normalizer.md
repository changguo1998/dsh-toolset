# symbol-normalizer 整理 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 symbol-normalizer 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `symbol-normalizer` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 无代码改动, 不建分支.

## 现状

- 单元层: `tests/` 下 4 个 `.test.ts` (`guide.test.ts` / `main.test.ts` / `review.test.ts` / `symbols.test.ts`); 阶段 1 末 `pnpm -C symbol-normalizer run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 96.9% (628/648); 分支 81.9% (113/138).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C symbol-normalizer run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-symbol-normalizer && mkdir -p ../tmp/cov-symbol-normalizer && NODE_V8_COVERAGE=../tmp/cov-symbol-normalizer node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-symbol-normalizer tmp/cov-symbol-normalizer/report.json
```

- 专项: -.
- 验收: `pnpm -C symbol-normalizer run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 symbol-normalizer 测试锚定`.

### 代码

阶段 3 无代码改动, 不建分支. 本包的整理在阶段 4 (包文档) 完成.

### 包文档

- 分支 `history-cleanup/04-package-docs-symbol-normalizer`, worktree `.worktree/04-package-docs/symbol-normalizer`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/DESIGN.md` / `docs/BACKLOG.md`.
- `README.md`: 现有 6 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- `docs/DESIGN.md`: 归并为四节 `## 背景` / `## 结构` / `## 机制` / `## 取舍`; 只改节名与合并重复, 机制与取舍内容不动.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- `docs/BACKLOG.md`: 同文件的命令与术语同步改; 条目内容、状态与顺序不动.
- 验收: 六节齐 (无配置可省)、四节齐、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(symbol-normalizer): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

- 基线: `pnpm -C symbol-normalizer run test` 43 条通过 (0 失败 / 0 跳过 / 0 todo); `check` 通过. 覆盖率行 96.9% (628/648)、分支 81.9% (113/138), 与「现状」一致.
- 单元锚点: `tests/review.test.ts` 追加 3 条 —— 别名映射到空串时的「请删除」文案与同 emoji 去重、只有警示时 notice 的格式 (`未推荐符号: ...` 无前导 `；`)、emoji 冷却期内跳过且过期恢复. 现有断言语义未改.
- 集成层: 新增 `tests/assemble.ts` (假消费者注册面 + 假事件派发面 + 假展示面, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (10 条). 装配方式为 `apply` → 注册消费者 → 按 `sources` 派发 `turn-end` / `session-start` / `compaction` / `step-end` → 审查 → 按 `delivery` 投影 `[RULE]` 消息; 展示面经 `provide("symbolNormalizer")` 取服务并订阅 `onReview`.
- 集成覆盖点: 两个消费者注册参数、服务面 `normalize` / `status` 与配置透传、回合审查注入正文与 `source.summary`、代码围栏与内联代码豁免、`warnModel=false` 只推 notice、按符号冷却、开局指南触发面与 `injectGuide=false`、`effect` 注销与 `onReview` 退订、rule-engine 缺席、注册面 / `provide` 抛错降级、监听器抛错不影响注入.
- 脚本: `package.json` 增加 `test:integration` 与 `test:coverage`; 覆盖率命令照包文档, 目录 `tmp/cov-symbol-normalizer`.
- `src` 未改; 无新增 / 删除夹具与 `skip`.

## 偏差

无.

## 测试与证据

四条命令全绿 (本机, 2026-11-01):

```text
pnpm -C symbol-normalizer run check             -> 通过 (tsc --noEmit, 无输出)
pnpm -C symbol-normalizer run test              -> 46 通过 / 0 失败 / 0 跳过 / 0 todo
pnpm -C symbol-normalizer run test:integration  -> 10 通过 / 0 失败 / 0 跳过 / 0 todo
pnpm -C symbol-normalizer run test:coverage     -> 56 通过 / 0 失败
```

覆盖率 (只统 `src`; 未覆盖行按报告口径, 为 0 基行号):

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 | 改后未覆盖行 |
| --- | --- | --- | --- | --- | --- |
| `src/guide.ts` | 100.0% (20/20) | 100.0% (20/20) | n/a (0/0) | n/a (0/0) | - |
| `src/index.ts` | 91.3% (137/150) | 97.3% (146/150) | 58.8% (10/17) | 89.5% (17/19) | 49, 182-184 |
| `src/review.ts` | 96.2% (127/132) | 97.0% (128/132) | 88.0% (44/50) | 92.2% (47/51) | 24, 60-61, 67 |
| `src/symbols.ts` | 99.4% (344/346) | 99.4% (344/346) | 83.1% (59/71) | 83.1% (59/71) | 301-302 |
| 合计 | 96.9% (628/648) | 98.5% (638/648) | 81.9% (113/138) | 87.2% (123/141) | - |

- 分层贡献: 两轮跑取差 —— 单元层单跑行 97.1% (629/648) / 分支 83.5% (116/139); 单元加集成后行 98.5% (638/648) / 分支 87.2% (123/141), 集成层贡献 9 行、7 个分支.
- 剩余未覆盖行经实跑核对为 V8 range 映射伪差: 对应的 `emojiInstrs.push` (review 61-62)、`let variantCount` (review 68)、`provide` 的 catch (index 183-185)、`resolveSymbolRules` 的别名合并与返回 (symbols 302-303) 均由新增用例执行; 类型声明行 (index 50、review 25) 为 transform 期残留. 无不可达防御分支需要豁免.
- `skipped` 0 / `todo` 0; 未删用例与夹具.

## 四份测试产物

| 产物 | 位置 |
| --- | --- |
| 覆盖率表 (改前 / 改后) | 见「测试与证据」的覆盖率表 |
| 新增 / 删除用例清单 | 见「实现记录」的「单元锚点 / 集成层」段 |
| `skip` 计数与豁免台账 | 见「测试与证据」的 `skip` / 豁免段 |
| 四个入口实跑 | 见「测试与证据」的入口段 |
