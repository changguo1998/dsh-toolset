# session-paths 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 session-paths 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `session-paths` 补单元锚点 (不设集成层), 落地 `test:integration` (打印缺层原因) 与 `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 2 个 `.test.ts` (`encode.test.ts` / `service.test.ts`); 阶段 1 末 `pnpm -C session-paths run test` 通过.
- 集成层: 无, 且按 4.2 不设 (纯函数包).
- 覆盖率基线 (阶段 1 末): 行 93.8% (180/192); 分支 85.5% (53/62).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 不新增集成层; `test:integration` 打印缺层原因并退出 0; 单元层补锚点

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C session-paths run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 不新增; `test:integration` 打印「纯函数包, 由单元层覆盖」并退出 0.
- 脚本: `package.json` 加 `test:integration` = `node -e 'console.log("session-paths 无集成层: 纯函数包, 由单元层覆盖")'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-session-paths && mkdir -p ../tmp/cov-session-paths && NODE_V8_COVERAGE=../tmp/cov-session-paths node --experimental-transform-types --test 'tests/*.test.ts' && node ../dev/coverage/report.mjs ../tmp/cov-session-paths ../tmp/cov-session-paths/report.json
```

- 专项: 不新增集成层; `test:integration` 打印缺层原因并退出 0; 单元层补锚点.
- 验收: `pnpm -C session-paths run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 session-paths 测试锚定`.

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
