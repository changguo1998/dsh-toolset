# TUI 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 TUI 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `TUI` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 139 个 `.test.ts` (见 `tests/`); 阶段 1 末 `pnpm -C TUI run test` 通过.
- 集成层: 无 `tests/integration/`; 适配器 / 状态 / 渲染链路未装配验证.
- 覆盖率基线 (阶段 1 末): 行 87.4% (24156/27643); 分支 78.3% (6258/7989).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: `tests/app.test.ts:354` 的 `skip` 按 4.4 处理; `tests/fixtures/` 的 2 个夹具复核; 新增 `test:e2e`, 跑 `demo -- --smoke` 与 `smoke:pty`; 端到端只在 TUI 做

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C TUI run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/main.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/app.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配状态层 / 渲染层与假适配器: 命令分派、视图投影与帧文本; 复用现有 `demo` 夹具, 不连真 pty.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-TUI && mkdir -p ../tmp/cov-TUI && NODE_V8_COVERAGE=../tmp/cov-TUI node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-TUI tmp/cov-TUI/report.json
```

- 专项: `tests/app.test.ts:354` 的 `skip` 按 4.4 处理; `tests/fixtures/` 的 2 个夹具复核; 新增 `test:e2e`, 跑 `demo -- --smoke` 与 `smoke:pty`; 端到端只在 TUI 做.
- 端到端: `test:e2e` 串 `pnpm run demo:build -- --smoke` 与 `pnpm run smoke:pty`; 两项都通过才记绿.
- 验收: `pnpm -C TUI run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 TUI 测试锚定`.

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
