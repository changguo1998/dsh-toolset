# behavior-correction 整理 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 behavior-correction 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `behavior-correction` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 无代码改动, 不建分支.

## 现状

- 单元层: `tests/` 下 2 个 `.test.ts` (`contract.test.ts` / `main.test.ts`); 阶段 1 末 `pnpm -C behavior-correction run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 90.8% (326/359); 分支 85.3% (87/102).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 删 `tests/contract.test.ts` 对 `@dsh-toolset/rule-engine` 的契约探针; `tests/main.test.ts` 的 `herdr_use` 旧名改 `herdr_run`
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C behavior-correction run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-behavior-correction && mkdir -p ../tmp/cov-behavior-correction && NODE_V8_COVERAGE=../tmp/cov-behavior-correction node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-behavior-correction tmp/cov-behavior-correction/report.json
```

- 专项: 删 `tests/contract.test.ts` 对 `@dsh-toolset/rule-engine` 的契约探针; `tests/main.test.ts` 的 `herdr_use` 旧名改 `herdr_run`.
- 验收: `pnpm -C behavior-correction run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 behavior-correction 测试锚定`.

### 代码

阶段 3 无代码改动, 不建分支. 本包的整理在阶段 4 (包文档) 完成.

### 包文档

- 分支 `history-cleanup/04-package-docs-behavior-correction`, worktree `.worktree/04-package-docs/behavior-correction`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md`.
- `README.md`: 现有 6 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- 验收: 六节齐 (无配置可省)、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(behavior-correction): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

> 测试基线、单元锚点、集成层、专项与覆盖率见「四份测试产物」; 本节保留脚本与偏差.

- 脚本：`behavior-correction/package.json` 增加 `test:integration` 与 `test:coverage`（后者按包文档的命令写，报告目录用 `tmp/cov-behavior-correction`，与 `auto-approve` 同形）。

## 偏差

- 任务清单第 3 步要求把 `tests/main.test.ts:141` 的 `herdr_use` 旧名改成 `herdr_run`；总规范 4.4 第 4 条则明确「负断言保留，『旧名不得回流』本身是护栏（`behavior-correction` 与 `security-guard` 各一处）」。两者冲突，按总规范执行：该行 `assert.doesNotMatch(reason, /herdr_use|pane_|tab_/)` 保留原样（改成 `herdr_run` 会让这条 `doesNotMatch` 必然失败）。作为补偿，集成用例里另加了一条同口径的负断言，并以 `DEFAULT_RULES[0].reason` 做正向断言，避免文案重复写字面量。
- 覆盖率报告里的未覆盖行 `373-377`（`matchRule` 的 exclude 分支与两个 return）是 V8 子表达式 range 的统计残余：这些行已被多条用例实际执行，聚合器按「最小 span 的 count」取数时被记成 0；按 4.3「不可达分支不计」处理，不另写用例凑数。

## 测试与证据

> 四入口、覆盖率、用例清单与 `skip` 见「四份测试产物」.

## 四份测试产物

> 四类数据从「实现记录」「测试与证据」搬入本节; 原节保留指针; 数字照录, 未重新计算.

### 覆盖率

- 基线: 覆盖率 行 90.8%（326/359）、分支 85.3%（87/102）。
- 结果: 行 90.8% → 98.6%，分支 85.3% → 98.4%（单元 + 集成，分母 359 行 / 122 分支）；只跑单元层为 98.6% / 99.2%（120/121 分支），集成层不增加 `src` 行覆盖，作用是锚定 `apply` 的接线值。

覆盖率（`dev/coverage/report.mjs`）：

| 文件 | 改前 行 | 改前 分支 | 改后 行 | 改后 分支 | 未覆盖行 |
| --- | --- | --- | --- | --- | --- |
| `behavior-correction/src/index.ts` | 90.8% (326/359) | 85.3% (87/102) | 98.6% (354/359) | 98.4% (120/122) | 373-377（统计残余，见「偏差」） |
| 合计 | 90.8% | 85.3% | 98.6% | 98.4% | - |

### 用例清单

- 基线: `pnpm -C behavior-correction run test` 33 条（32 通过、1 skip = `contract.test.ts` 的 `@dsh-toolset/rule-engine` 契约探针）；`run check` 通过。
- 单元锚点：新增 `behavior-correction/tests/index.test.ts`（13 条），补 `src/index.ts` 未被现有用例走到的分支与错误路径 —— `resolveConfig` 的 rules 缺席 / 非数组兜底；`compileRules` 的 `tool` 非法（数字、空数组、全非法项）、`match` 非对象、`match.keywords` / `match.regex` 非字符串数组、`exclude` 非对象、`exclude.keywords` / `exclude.regex` 非法、`exclude` 正则无效、混合列表只留合法项、`g` / `y` 从 flags 去掉、无 `id` 规则的序号标签；`matchRule` 的 tool 限定跳过与 exclude 弃权、空上下文；`apply` 的 `ctx` 为 null / undefined、严格模式直读 `ctx.ruleEngine` 抛错回退 `ctx.get`、直接属性非注册面、`registerConsumer` 不返回注销函数、宿主不给 `ctx.on`。
- 集成层：新增 `behavior-correction/tests/assemble.ts`（装配器，不以 `.test.ts` 结尾）与 `tests/integration/plugin.test.ts`（13 条）。装配器按总规范 4.2 拼三个假面 —— 假工具面是 `tools/pre-execute` 的 waterfall（按注册顺序派发，首个 `deny` 胜出、`undefined` 弃权交下一位）、假事件面是 `ctx.on` / `emit("dispose")`、假服务面是 `ctx.get("ruleEngine")` 的 `registerConsumer` 注册面；另支持直接属性暴露、严格模式直读抛错、注册被拒与无注销函数四种接线形态。断言覆盖：注册项 `id` / `sources`、拒绝回执 `kind: "deny"` 且 `reason` 等于 `DEFAULT_RULES[0].reason`、waterfall 弃权与命中、`dispose` 事件注销一次且返回值幂等、服务缺席 / 严格模式 / 注册被拒 / 非注册面四种降级、`enabled: false` 与自定义规则整体替换、非法正则告警后其余规则照常。本包无工具注册、无服务 provide、不落盘，故集成层不涉及临时目录。
- 专项：删除 `tests/contract.test.ts`（文件内容只有那个探针；本仓布局下 `@dsh-toolset/rule-engine` 不可解析、本机永远 skip，`CONSUMER_SOURCES` 已由 `rule-engine/tests/rules.test.ts` 锁定）。删后本包 `skip` 计数 0，夹具 0 个（无需复核）。`tests/main.test.ts` 未改，原因见「偏差」。

新增与删除用例清单：

| 文件 | 动作 | 条数 | 覆盖内容 |
| --- | --- | --- | --- |
| `tests/index.test.ts` | 新增 | 13 | 配置兜底、规则编译的六类非法分支、flags 归一、空上下文、`apply` 的五条降级 / 注销路径 |
| `tests/assemble.ts` | 新增 | - | 三假面装配器（工具 / 事件 / 服务）+ stderr 捕获，无断言 |
| `tests/integration/plugin.test.ts` | 新增 | 13 | 注册面值、拒绝文案、waterfall、dispose 事件、四种服务面降级、配置面 |
| `tests/contract.test.ts` | 删除 | 1 | 对 `@dsh-toolset/rule-engine` 的契约探针（本机不可解析，永远 skip），由 `rule-engine/tests/rules.test.ts` 接管 |

### skip 计数与豁免台账

- `skip` 0 条、`todo` 0 条、豁免 0 条.
- 豁免台账: 无 (原文未记).

### 四入口实跑

命令（均在 `behavior-correction/` 下执行，分支 `history-cleanup/02-tests-behavior-correction`）：

| 入口 | 结果 |
| --- | --- |
| `pnpm run check` | ✓ 通过（`tsc -p tsconfig.json --noEmit`，无输出） |
| `pnpm run test` | ✓ 46 条通过 / 0 失败 / 0 skip / 0 todo（改前 33 条、1 skip） |
| `pnpm run test:integration` | ✓ 13 条通过 / 0 失败 / 0 skip |
| `pnpm run test:coverage` | ✓ 单元 + 集成全跑通，报告 `tmp/cov-behavior-correction/report.json` |
