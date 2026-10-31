# script-interpreter 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 script-interpreter 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `script-interpreter` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 6 个 `.test.ts` (`clock.test.ts` / `index.test.ts` / `probe.test.ts` / `run.test.ts` / `sandbox.test.ts` / `tool.test.ts`); 阶段 1 末 `pnpm -C script-interpreter run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 91.1% (1485/1630); 分支 77.7% (317/408).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C script-interpreter run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-script-interpreter && mkdir -p ../tmp/cov-script-interpreter && NODE_V8_COVERAGE=../tmp/cov-script-interpreter node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-script-interpreter tmp/cov-script-interpreter/report.json
```

- 专项: -.
- 验收: `pnpm -C script-interpreter run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 script-interpreter 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

- 集成层: 新增 `tests/assemble.ts` (假工具面 / 假事件面 / 假服务面拼 `apply`, `ctx.get` 受保护读取 + `expose: "property"` 回落, 临时工作区与 `cleanup()`, `captureStderr`) 与 `tests/integration/plugin.test.ts` (14 条): 工具注册名 / 参数面 / 语言枚举, canonical 值 (成功 / 非零退出 / 超时), `output.render` 投影, 相对 workdir 与 `spillPrefix` 路径守卫, 参数校验 / 未启用语言 / 解释器缺失 / 围栏失败 / 审批拒绝的失败路径, 服务全缺与 `ctx.tools` 缺失的降级, 无事件消费者 (不订阅) 与日志回落.
- 单元锚点 (存量文件追加, 不改旧断言): `tests/index.test.ts` +4 (非数组 `languages`、小数钳位、`spillPrefix` 反斜杠与开头点横线净化、显式语言缺解释器的日志与探测痕迹、sh 不做版本探测); `tests/probe.test.ts` +4 (`resolveUvPython` 失败三态与空行跳过、`readVersion` 起不来 / stderr 版本、`.venv/bin/python3` 候选、uv 解析失败痕迹); `tests/run.test.ts` +4 (空 argv、调用前已取消的 signal、`maxOutputChars < 1`、落盘失败只丢路径); `tests/clock.test.ts` +5 (ctx 缺失 / 无 get / get 或 scope 抛错 / 形状不符的回落, `systemTimers` 延迟归一与 interval 撤销, deadline 取消幂等, effect 抛错 / 非函数, disposer 返回 Promise); `tests/sandbox.test.ts` +1 (空签名过滤与空行剔除); 新增 `tests/render.test.ts` 5 条 (两条流拼接、截断提示、标记顺序、失败值 / 畸形值全函数口径).
- 脚本: `package.json` 加 `test:integration` 与 `test:coverage` (后者按包文档命令, `report.mjs` 参数用 `tmp/cov-script-interpreter`).
- `src` 未改.

## 偏差

无.

## 测试与证据

### 入口实跑

| 命令 | 结果 |
| --- | --- |
| `pnpm -C script-interpreter run check` | `tsc -p tsconfig.json --noEmit` 通过 (exit 0) |
| `pnpm -C script-interpreter run test` | tests 117 / pass 117 / fail 0 / skipped 0 / todo 0 |
| `pnpm -C script-interpreter run test:integration` | tests 14 / pass 14 / fail 0 / skipped 0 / todo 0 |
| `pnpm -C script-interpreter run test:coverage` | tests 131 / pass 131 / fail 0 / skipped 0; 本包行 95.1% (1550/1630), 分支 86.9% (398/458) |

- 新增用例: 单元 23 条, 集成 14 条; 删除用例 0 条, 夹具 0 个.
- `skip`: 本机 0 条; 集成层按 4.4 对 sh 解释器做条件式 skip (`shInfo() === null` 时 skip 并注明缺 sh), 本机触发 0 条.

### 覆盖率 (改前 → 改后, 只统 `src`)

| 文件 | 改前行 | 改前分支 | 改后行 | 改后分支 | 改后未覆盖行 |
| --- | --- | --- | --- | --- | --- |
| `src/index.ts` | 95.1% (291/306) | 86.6% (58/67) | 99.0% (303/306) | 95.9% (71/74) | 46,47,225 |
| `src/probe.ts` | 89.2% (141/158) | 79.1% (53/67) | 96.2% (152/158) | 89.0% (65/73) | 44,101,104,114,203,204 |
| `src/render.ts` | 91.5% (75/82) | 86.2% (25/29) | 100.0% (82/82) | 100.0% (39/39) | - |
| `src/run.ts` | 86.5% (268/310) | 69.2% (36/52) | 90.0% (279/310) | 79.7% (47/59) | 77,90,91,98,99,114,132,145,169,170,225-234,256,260-263,266-273,284,285 |
| `src/sandbox.ts` | 97.6% (124/127) | 90.0% (36/40) | 97.6% (124/127) | 86.0% (37/43) | 39,80,81 |
| `src/timers.ts` | 77.4% (120/155) | 37.5% (12/32) | 92.9% (144/155) | 83.3% (40/48) | 47,59,115-117,123,124,127-129,144 |
| `src/tools.ts` | 94.0% (406/432) | 80.2% (97/121) | 94.0% (406/432) | 81.1% (99/122) | 56-58,79,80,140,141,157,158,173-175,179,230,231,294,324,325,335,344-346,370,420,426,441 |
| `src/langs/*.ts` | 100.0% | n/a | 100.0% | n/a | - |
| `src/types.ts` | 100.0% (6/6) | n/a | 100.0% (6/6) | n/a | - |
| 本包合计 | 91.1% (1485/1630) | 77.7% (317/408) | 95.1% (1550/1630) | 86.9% (398/458) | - |

- 口径说明: `src/sandbox.ts` 的分支比例从 90.0% 降到 86.0%, 原因是集成层经 `src/index.ts` 也加载同一文件, 合并后的 block 分母 40 → 43 而命中只 +1; 行覆盖不变, 本包整体行 / 分支均上升, 不构成退化.
- 未覆盖行集中在类型 / 接口声明与闭包归因行, 以及 4.3 允许豁免的防御分支 (如 `index.ts:46,47` 的 `BundleHost` 接口、`run.ts` 的 `StreamCapture` 私有字段声明).
