# coagent 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 coagent 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `coagent` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 4 个 `.test.ts` (`close.test.ts` / `guard.test.ts` / `spawn.test.ts` / `store.test.ts`); 阶段 1 末 `pnpm -C coagent run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 79.9% (1573/1969); 分支 62.4% (227/364).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C coagent run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-coagent && mkdir -p ../tmp/cov-coagent && NODE_V8_COVERAGE=../tmp/cov-coagent node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs ../tmp/cov-coagent ../tmp/cov-coagent/report.json
```

- 专项: -.
- 验收: `pnpm -C coagent run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 coagent 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

(待填)

## 偏差

无

## 测试与证据

(待填)
