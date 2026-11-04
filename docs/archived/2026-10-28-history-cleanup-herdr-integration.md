# herdr-integration 整理 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 herdr-integration 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `herdr-integration` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 4 个 `.test.ts` (`clock.test.ts` / `herdr.test.ts` / `main.test.ts` / `state.test.ts`); 阶段 1 末 `pnpm -C herdr-integration run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 86.7% (574/662); 分支 67.2% (82/122).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C herdr-integration run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-herdr-integration && mkdir -p ../tmp/cov-herdr-integration && NODE_V8_COVERAGE=../tmp/cov-herdr-integration node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-herdr-integration tmp/cov-herdr-integration/report.json
```

- 专项: -.
- 验收: `pnpm -C herdr-integration run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 herdr-integration 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-herdr-integration`, worktree `.worktree/03-code/herdr-integration`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 前置: `clock-base` 已合并, 本分支从含它的 `main` 开.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C herdr-integration run check` 与 `pnpm -C herdr-integration run test`.
- 任务:
  - 删 `src/timers.ts`; 入口 import 改从 `clock-base` 引; `tests/clock.test.ts` 改从入口引.
  - `package.json` / `pnpm-lock.yaml` 加 `link:../clock-base`.
- 验收: `pnpm -C herdr-integration run check` 与 `pnpm -C herdr-integration run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(herdr-integration): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

- 分支 `history-cleanup/04-package-docs-herdr-integration`, worktree `.worktree/04-package-docs/herdr-integration`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/BACKLOG.md`.
- `README.md`: 现有 6 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- `docs/BACKLOG.md`: 同文件的命令与术语同步改; 条目内容、状态与顺序不动.
- 验收: 六节齐 (无配置可省)、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(herdr-integration): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

> 单元锚点、集成层与脚本见「四份测试产物」; 本节保留范围说明与阶段 3 实现记录.

- 未改 `src`; `tsconfig.json` 的 `exclude` 与空 `LICENSE` 等归阶段 3 / 4; 2026-11-01 补丁 `25fce711` 已删除 `exclude`。

阶段 3 (分支 `history-cleanup/03-code-herdr-integration`):

- 删 `src/timers.ts`(本地副本, 205 行);`src/index.ts` 与 `src/herdr.ts` 的定时器族 import 改从 `@dsh-toolset/clock-base` 入口引(`createDeadline` / `resolveClock` 与类型 `Deadline`), 按仓内既有姿态把包 import 单独成组置于相对 import 之前。
- `tests/clock.test.ts` 的 `createDeadline` / `resolveClock` / `ManualClock` 一并从包入口引, 不再跨包引 `../../clock-base/src/timers.ts`;断言未改。
- `package.json` 的 `dependencies` 加 `"@dsh-toolset/clock-base": "link:../clock-base"`, 在本包目录 `pnpm install` 刷新 `pnpm-lock.yaml`(importer 下新增一条 link 依赖)。
- 跨包 import 解析到 `clock-base/dist`, 故 `check` / `test` 前先在 `../clock-base` 跑 `pnpm run build`。

## 偏差

阶段 2: 无。`src` 未改;测试侧只给 `tests/herdr.test.ts` 的 socket 服务端补了 `error` 忽略, 不改任何既有断言。

阶段 3:

- 「实现规划 / ### 代码」的「顺序」里 `拆长文件` / `收拢判断` 两步没有对应的任务条目(`任务` 只有删副本与加依赖两条), 本次未做, 留给后续条目。阶段 3b 复核裁定不再单立条目: 本包 `src` 最大文件 `src/index.ts` 375 行 (`herdr.ts` 292, `state.ts` 77), 不在总追踪 5.5 的长文件清单内, 没有可拆对象; 5.6 的六组散落判断也不含本包 (沙箱枚举收 `herdr-use`、时钟探测收 `clock-base`、上下文守卫收各入口, 本包入口守卫已按该组处理)。两步属通用步骤模板, 对本包无对象, 故关闭。
- 计划外一行注释:`src/index.ts:1` 的头注释原写「零运行时依赖」, 加 link 依赖后不再成立, 改为「运行时依赖只有 clock-base 的定时器族」。
- 本文件「覆盖率」表里 `src/timers.ts` 那一行随副本删除失效;该实现的覆盖率归 `clock-base` 自己的用例, 本包不再统计。

## 测试与证据

> 四入口、覆盖率、用例增减、豁免与分层贡献见「四份测试产物」; 本节保留阶段 3 实跑.

### 阶段 3 命令结果(分支 `history-cleanup/03-code-herdr-integration`, Node v24.16.0, pnpm 11.7.0)

前置: `pnpm -C ../clock-base run build`(跨包 import 取 `clock-base/dist`), 本包 `pnpm install`。

| 命令 | 结果 |
| --- | --- |
| `pnpm -C herdr-integration run check` | ✓ 通过(无输出) |
| `pnpm -C herdr-integration run test` | ✓ 60 pass / 0 fail, 5 suites, 约 0.55s |
| `pnpm -C herdr-integration run test:integration` | ✓ 11 pass / 0 fail, 3 suites, 约 2.9s |

用例断言一条未改(仅改 import 来源);删 `src/timers.ts` 205 行, 全量 diff 为 6 文件 +18 / -212。

## 四份测试产物

> 四类数据从「实现记录」「测试与证据」搬入本节; 原节保留指针; 数字照录, 未重新计算.

### 覆盖率

覆盖率(只统 `src`, 装配器与夹具不计;分母为 V8 实际观测到的 range):

改前 = 基线(只跑单元层);改后 = 单元 + 集成。

| 文件 | 行(改前) | 行(改后) | 分支(改前) | 分支(改后) |
| --- | --- | --- | --- | --- |
| `src/herdr.ts` | 86.3% (183/212) | 93.9% (199/212) | 56.5% (13/23) | 67.9% (19/28) |
| `src/index.ts` | 89.0% (219/246) | 95.5% (235/246) | 80.4% (45/56) | 86.2% (56/65) |
| `src/state.ts` | 100.0% (49/49) | 100.0% (49/49) | 100.0% (15/15) | 100.0% (15/15) |
| `src/timers.ts` | 79.4% (123/155) | 80.0% (124/155) | 32.1% (9/28) | 36.7% (11/30) |
| 包合计 | 86.7% (574/662) | 91.7% (607/662) | 67.2% (82/122) | 73.2% (101/138) |

行 +5.0 个百分点, 分支 +6.0 个百分点, 无下降项。分支分母变化来自新用例走到的 range 变多(V8 只报已执行函数的 block)。

剩余未覆盖分两类: 多行对象字面量与函数声明处的 range 归属偏差(报告把 `const sender = new HerdrClient({...})` 一类标成未覆盖, 实际已被集成用例执行); 以及 `src/herdr.ts:126-129` 的 win32 命名管道分支 —— 本机 Linux 不可达, 按 4.3 记为豁免分支。

集成层贡献(两轮跑取差): 只跑单元层即改前一行(行 574/662);加集成层后为 607/662, 差值为行 +33、分支 +19, 集中在 `src/index.ts` 的生产发送器与生产 `readRoots` 装配, 以及 `src/herdr.ts` 的构造与超时接线。

### 用例清单

- 单元锚点: `tests/herdr.test.ts` 新增 3 条 —— `reportSession` 无启动来源时省略 `session_start_source`、仅 `path` 的引用走 `agent_session_path`;`releaseSync` 经同步子进程把 `pane.release_agent` 送达 socket;`releaseSync` 在 socket 不存在时静默返回。同文件的 socket 测试服务端补一个 `error` 忽略(客户端收到响应即 destroy, 回写竞态不该让用例红), 断言语义未改。
- 集成层: 新增 `tests/assemble.ts`(装配器, 不以 `.test.ts` 结尾)与 `tests/integration/plugin.test.ts`。装配器给三个假面: 事件面(`on` / `fire`)、服务面(`get` + services 表)、生命周期面(`effect` / `unload`), 另给手控排期表与按 `clock` 形状包装的假时钟、临时目录里的真 unix socket 上游、握手环境变量的设置与还原。上游逐行解析 JSON 报文并回一行 `ok`, 用例只等收包(带超时守卫)与失败沉降。
- 集成用例 11 条分三组: 入口与宿主接线(握手不全空转、`name` / `inject` 契约、四个事件监听各一次、启动期同步与卸载 release)、事件投影(`agent/status` 的 working / idle、提问与审批的 blocked 桥与解除、`session/event` 的 turn 阻塞 / 压缩在途)、服务面缺失与失败路径(`agents` 缺席、`roots` 非数组、socket 不可达、`clock` 服务可用时排期走服务面并在卸载撤销)。
- 脚本: `package.json` 加 `test:integration`(`tests/integration/*.test.ts`)与 `test:coverage`(两轮 glob 一起跑, `NODE_V8_COVERAGE` 落 `../tmp/cov-herdr-integration`, 再调 `dev/coverage/report.mjs tmp/cov-herdr-integration tmp/cov-herdr-integration/report.json`)。
- 新增 14 条(单元 3、集成 11);删除 0 条.

### skip 计数与豁免台账

- `skip` / `todo` 均为 0;集成层的实时等待只有 socket 收包与失败沉降, 全部带超时守卫。
- 豁免台账:

| 缺什么 | 为什么补不了 | 触发条件 | 交给谁 |
| --- | --- | --- | --- |
| win32 命名管道分支(`src/herdr.ts:126-129`) | 本机 Linux, `process.platform === "win32"` 不可达 | 在 Windows 上跑本包测试 | 阶段 3 复核时按平台条件补 |

### 四入口实跑

命令结果(分支 `history-cleanup/02-tests-herdr-integration`, Node v24.16.0):

| 入口 | 结果 |
| --- | --- |
| `pnpm -C herdr-integration run check` | ✓ 通过(无输出) |
| `pnpm -C herdr-integration run test` | ✓ 60 pass / 0 fail(基线 57), 5 suites, 约 0.54s |
| `pnpm -C herdr-integration run test:integration` | ✓ 11 pass / 0 fail, 3 suites, 约 2.9s;连跑 3 次全绿 |
| `pnpm -C herdr-integration run test:coverage` | ✓ 71 pass / 0 fail(单元 60 + 集成 11), 覆盖率见下表 |
