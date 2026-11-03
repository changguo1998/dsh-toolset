# ponytail 整理 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 ponytail 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `ponytail` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 无代码改动, 不建分支.

## 现状

- 单元层: `tests/` 下 1 个 `.test.ts` (`main.test.ts`); 阶段 1 末 `pnpm -C ponytail run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 91.3% (95/104); 分支 65.2% (15/23).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C ponytail run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-ponytail && mkdir -p ../tmp/cov-ponytail && NODE_V8_COVERAGE=../tmp/cov-ponytail node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-ponytail tmp/cov-ponytail/report.json
```

- 专项: -.
- 验收: `pnpm -C ponytail run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 ponytail 测试锚定`.

### 代码

阶段 3 无代码改动, 不建分支. 本包的整理在阶段 4 (包文档) 完成.

### 包文档

- 分支 `history-cleanup/04-package-docs-ponytail`, worktree `.worktree/04-package-docs/ponytail`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/DESIGN.md`.
- `README.md`: 现有 6 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- `docs/DESIGN.md`: 归并为四节 `## 背景` / `## 结构` / `## 机制` / `## 取舍`; 只改节名与合并重复, 机制与取舍内容不动.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- 验收: 六节齐 (无配置可省)、四节齐、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(ponytail): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

- 单元锚点: `tests/main.test.ts` 追加 4 条 `resolveConfig` 判定用例 —— sources 过滤非法项与全非法回退 / delivery 白名单 (inject / followup / 非法值) / dedupeInRecord 接受 0 与非数字回退 / 自定义 text 覆盖与空串回退; 现有 5 条断言未改语义.
- 集成层: 新增 `tests/assemble.ts` (装配器, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (14 条).
  - 假面按 4.2 三条: 假服务面 (`ctx.get("ruleEngine")` / `ctx.ruleEngine` / 半装配无 `registerConsumer` / 完全缺席), 假事件面 (`ctx.on` / `emit`, 守住本包不订阅宿主生命周期), 假工具面 (`ctx.tools.registerTool`, 守住本包不注册工具); 另加假会话事件派发 `fire(source)`, 按 `sources` 命中 `session-start` / `step-end` 调 `decide`.
  - 断言: 消费者注册项 (id / sources / delivery / dedupeInRecord / directWrite), 两个节点注入的阶梯正文与摘要, 未挂节点不注入, `enabled: false` 仍注册但不注入, 配置透传到注册项与正文, 服务缺席 / 半装配 / 注册被拒三条降级路径只告警, 注册面无注销函数时 `apply` 透传 `undefined`, `ctx` 为 `null` / `undefined` 时按缺席处理.
- 脚本: `ponytail/package.json` 加 `test:integration` 与 `test:coverage` (`report.mjs` 参数 `tmp/cov-ponytail`), 与其它包同构.
- 清理: 本包 0 处 `skip`, 0 处 `todo`, 无夹具, 按 4.4 无处置项.

## 偏差

- 未改 `src` (为可测性无需改动).
- 本包不落盘: 4.2 的「落盘写临时目录」无对象, 集成层改为断言工具面为零注册、事件面无监听.
- 工具面记一行 (交阶段 2 汇总): `dev/coverage/report.mjs` 的「未覆盖行」列在 `--experimental-transform-types` 下会与真实源码行号错位 —— 本次实测实际未覆盖的是 `src/index.ts` 的 `ctx ?? {}`, 报告标成 `53`; 行 / 分支的计数与 Node 内置 `--experimental-test-coverage` 完全一致, 故判定以计数为准, 行号列仅作参考.

## 测试与证据

覆盖率 (只统 `src`, 装配器不计):

| 轮次 | 行 | 分支 | 未覆盖行 |
| --- | --- | --- | --- |
| 改前 (阶段 1 末, 单元层) | 91.3% (95/104) | 65.2% (15/23) | 29,36,39,40,41,53,55,78,79 |
| 改后 (单元层) | 96.2% (100/104) | 90.0% (27/30) | 53,55,78,79 |
| 改后 (单元 + 集成) | 100.0% (104/104) | 100.0% (31/31) | - |

集成层贡献: 行 +3.8 个百分点 (4 行), 分支 +10.0 个百分点 (3 条). 未下降.

四入口实跑:

| 命令 | 结果 |
| --- | --- |
| `pnpm -C ponytail run check` | ✓ 通过 (tsc 无输出) |
| `pnpm -C ponytail run test` | ✓ 9 通过 / 0 失败 / 0 跳过, 73 ms |
| `pnpm -C ponytail run test:integration` | ✓ 14 通过 / 0 失败 / 0 跳过, 74 ms |
| `pnpm -C ponytail run test:coverage` | ✓ 行 100.0% / 分支 100.0%, 表同上 |

- 交叉核对: `node --experimental-transform-types --experimental-test-coverage` 对 `src/index.ts` 报 100.00% 行 / 100.00% 分支 / 100.00% 函数, 与 `report.mjs` 一致.
- 导出覆盖: `name` / `inject` / `resolveConfig` / `apply` 与两个文本常量全部被用例调用或断言.
- 错误码覆盖: 本包无 `code` 常量, 不适用.
- 用例增减: 新增 18 条 (单元 4 + 集成 14), 删除 0 条; 本机 `skipped` 0.

## 四份测试产物

| 产物 | 位置 |
| --- | --- |
| 覆盖率表 (改前 / 改后) | 见「测试与证据」的覆盖率表 |
| 新增 / 删除用例清单 | 见「实现记录」的「单元锚点 / 集成层」段 |
| `skip` 计数与豁免台账 | 见「测试与证据」的 `skip` / 豁免段 |
| 四个入口实跑 | 见「测试与证据」的入口段 |
