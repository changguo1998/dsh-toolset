# ast-tools 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 ast-tools 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `ast-tools` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 7 个 `.test.ts` (`binary.test.ts` / `clock.test.ts` / `outline.test.ts` / `replace.test.ts` / `rules.test.ts` / `search.test.ts` / `tool.test.ts`); 阶段 1 末 `pnpm -C ast-tools run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 55.3% (1054/1905); 分支 57.4% (124/216).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C ast-tools run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-ast-tools && mkdir -p ../tmp/cov-ast-tools && NODE_V8_COVERAGE=../tmp/cov-ast-tools node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-ast-tools tmp/cov-ast-tools/report.json
```

- 专项: -.
- 验收: `pnpm -C ast-tools run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 ast-tools 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-ast-tools`, worktree `.worktree/03-code/ast-tools`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 前置: `clock-base` 已合并, 本分支从含它的 `main` 开.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C ast-tools run check` 与 `pnpm -C ast-tools run test`.
- 任务:
  - 删 `src/timers.ts` (本地副本).
  - `src/index.ts` / `src/types.ts` / `src/binary.ts` 的 import 改从 `clock-base` 入口引.
  - `tests/clock.test.ts` 改从 `clock-base` 入口引, 不再跨包引内部模块.
  - `package.json` / `pnpm-lock.yaml` 加 `link:../clock-base`.
  - `src/tools.ts:467` 的「两个工具」按实际去数字.
- 验收: `pnpm -C ast-tools run check` 与 `pnpm -C ast-tools run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(ast-tools): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

阶段 4 补.

## 实现记录

- 阶段 2 测试锚定（分支 `history-cleanup/02-tests-ast-tools`）:

  - 基线: 单元 47 例全通过, 0 skip; 覆盖率 行 84.2% (886/1052), 分支 62.6% (117/187).
  - 单元锚点: 新增 35 例, 覆盖二进制探测与回落、子进程启动失败 / 超时 / JSON 解析错误、定时器统一面形状兜底与卸载路径、工具 canonical 入参 / 渲染兜底与截断、bundle 工厂与 `apply` 极简宿主.
  - 集成层: 新增 `tests/assemble.ts` (假工具面 / 假事件面 / 假服务面 + 假 ast-grep CLI + 假时钟, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (9 例): 工具注册名、`execute` canonical 值、`output.render` 投影、服务面 `clock` 读取、事件面零订阅、降级装配.
  - 脚本: `package.json` 加 `test:integration` 与 `test:coverage`.
  - 结果: 单元 82 例 + 集成 9 例全通过; 覆盖率 行 96.3% (1013/1052), 分支 87.6% (218/249).

- 阶段 3 代码整理（分支 `history-cleanup/03-code-ast-tools`）:

  - 删 `src/timers.ts`（本地副本, 205 行）, 定时器族改用 `@dsh-toolset/clock-base` 入口导出: `src/index.ts` 引 `createDeadline` / `resolveClock` 与类型 `Deadline`; `src/types.ts` / `src/binary.ts` 只引类型 `Deadline`.
  - `tests/clock.test.ts` 改从 `@dsh-toolset/clock-base` 入口引 `createDeadline` / `ManualClock` / `resolveClock` / `systemTimers`, 不再引 `../../clock-base/src/timers.ts`; 用例断言未改.
  - `package.json` 加 `dependencies.@dsh-toolset/clock-base = link:../clock-base`, 本包目录 `pnpm install` 更新 `pnpm-lock.yaml`（importer 加 dependencies 一项）.
  - `src/tools.ts:467` 注释去掉数字, 由「两个工具定义」改为「工具定义」（实际仍是 `ast_query` / `ast_replace` 两个, 去数字免得后续增减不同步）.
  - 行为不变: 工具名、参数面、`output.render` 投影、配置键、注入文案、降级路径都未动.

## 偏差

- 无 `src` 改动.
- 覆盖率脚本: `report.mjs` 的两个路径参数按仓库根解析, 故 `test:coverage` 里传 `tmp/cov-ast-tools` / `tmp/cov-ast-tools/report.json`; `NODE_V8_COVERAGE` 由 node 按包目录解析, 仍用 `../tmp/cov-ast-tools`. 两者指向同一目录.
- 发现未修 (不属本阶段范围): `BundleHost.logger` 声明为可选, 但 `src/index.ts:191` 与 `:201` 无条件调用 `ctx.logger?.(name).info(...)`; 宿主缺 `logger` 时 `apply` 抛 TypeError. 装配器始终提供 logger, 未用用例锁死该行为, 留给阶段 3 代码整理.
- 阶段 3 偏差: 跨包 import 走包名（解析到 `clock-base` 的 `dist/`）, 故 `check` / `test` 前须先 `pnpm -C ../clock-base run build`; 与「实现规划」的前置要求一致, 代价是本包测试多一条构建前置.
- 阶段 3 偏差: `tsconfig.json` 的 `exclude: ["tests/clock.test.ts"]` 保持原样未动（改入口 import 后是否可纳入 include 未评估, 属实现规划未列任务）.

## 测试与证据

### 四个入口实跑

| 命令 | 结果 |
| --- | --- |
| `pnpm -C ast-tools run check` | 通过 (tsc --noEmit, 无输出) |
| `pnpm -C ast-tools run test` | 82 例, pass 82, fail 0, skipped 0 |
| `pnpm -C ast-tools run test:integration` | 9 例, pass 9, fail 0, skipped 0 |
| `pnpm -C ast-tools run test:coverage` | 91 例全通过, 报告见下 |

### 覆盖率 (改前 / 改后)

只统 `ast-tools/src`; 同次报告里的 `clock-base/src/timers.ts` 来自 `tests/clock.test.ts` 跨包 import `ManualClock`, 不属本包口径, 不计入合计.

| 文件 | 行 (改前) | 行 (改后) | 分支 (改前) | 分支 (改后) |
| --- | --- | --- | --- | --- |
| `src/binary.ts` | 71.3% (124/174) | 92.0% (160/174) | 46.2% (18/39) | 77.1% (37/48) |
| `src/index.ts` | 95.9% (141/147) | 96.6% (142/147) | 72.7% (8/11) | 69.2% (9/13) |
| `src/langs.ts` | 96.2% (25/26) | 96.2% (25/26) | 0.0% (0/1) | 0.0% (0/1) |
| `src/outline.ts` | 88.2% (15/17) | 88.2% (15/17) | 75.0% (3/4) | 75.0% (3/4) |
| `src/replace.ts` | 88.4% (61/69) | 88.4% (61/69) | 33.3% (2/6) | 33.3% (2/6) |
| `src/rules.ts` | 88.9% (16/18) | 100.0% (18/18) | 80.0% (4/5) | 100.0% (6/6) |
| `src/search.ts` | 90.0% (18/20) | 100.0% (20/20) | 0.0% (0/1) | 100.0% (1/1) |
| `src/timers.ts` | 67.1% (104/155) | 95.5% (148/155) | 33.3% (7/21) | 88.0% (44/50) |
| `src/tools.ts` | 89.7% (382/426) | 99.5% (424/426) | 75.8% (75/99) | 96.7% (116/120) |
| 合计 | 84.2% (886/1052) | 96.3% (1013/1052) | 62.6% (117/187) | 87.6% (218/249) |

分层贡献 (两轮跑): 只跑单元层 行 96.1% (1011/1052) / 分支 87.2% (212/243); 单元加集成 行 96.3% / 分支 87.6%, 集成层贡献 +2 行 / +6 分支 (search / outline / rules 的参数装配行).

### 用例增减

| 类别 | 改前 | 改后 | 增减 |
| --- | --- | --- | --- |
| 单元 (`tests/*.test.ts`) | 47 | 82 | +35 |
| 集成 (`tests/integration/*.test.ts`) | 0 | 9 | +9 |
| skip | 0 | 0 | 0 |
| todo | 0 | 0 | 0 |
| 删除用例 | - | 0 | 0 |

### 豁免台账

| 位置 | 缺什么 | 为什么补不了 | 触发条件 | 交给谁 |
| --- | --- | --- | --- | --- |
| `src/replace.ts:35` 重叠编辑跳过 | 公开入口 | `applyEdits` 未导出, 且 ast-grep 命中区间本不重叠, 属防御分支 | 无 | 阶段 3 代码整理评估 |
| `src/binary.ts:196` `Array.isArray` 兜底 | 公开入口 | 解析片段固定从 `[` 到 `]`, `JSON.parse` 结果必为数组 | 无 | 阶段 3 代码整理评估 |
| `src/index.ts:104-107` / `:125-127` | 非可执行行 | 接口 / 类型声明行, 非可执行代码, V8 仍按行计入 | 无 | 不处理 |

### 阶段 3 代码整理实跑

前置: `pnpm -C ../clock-base run build`（产出 `dist/`, 供包名 import 解析）; 本包目录 `pnpm install`（建 `node_modules/@dsh-toolset/clock-base -> ../clock-base` 并更新 `pnpm-lock.yaml`）.

| 命令 | 结果 |
| --- | --- |
| `pnpm -C ast-tools run check` | 通过 (tsc --noEmit, 无输出) |
| `pnpm -C ast-tools run test` | 82 例, pass 82, fail 0, skipped 0, todo 0 |
| `pnpm -C ast-tools run test:integration` | 9 例, pass 9, fail 0, skipped 0 |

改动量: 删 `src/timers.ts` 205 行; 改 6 个文件（`src/index.ts` / `src/types.ts` / `src/binary.ts` / `src/tools.ts` / `tests/clock.test.ts` / `package.json`）与 `pnpm-lock.yaml`, 合计 +21 / -9 行（不含删除的 205 行）.
