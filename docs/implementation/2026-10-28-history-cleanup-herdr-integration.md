# herdr-integration 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 herdr-integration 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `herdr-integration` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 4 个 `.test.ts` (`clock.test.ts` / `herdr.test.ts` / `main.test.ts` / `state.test.ts`); 阶段 1 末 `pnpm -C herdr-integration run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 86.7% (574/662); 分支 67.2% (82/122).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.

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

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

- 单元锚点: `tests/herdr.test.ts` 新增 3 条 —— `reportSession` 无启动来源时省略 `session_start_source`、仅 `path` 的引用走 `agent_session_path`;`releaseSync` 经同步子进程把 `pane.release_agent` 送达 socket;`releaseSync` 在 socket 不存在时静默返回。同文件的 socket 测试服务端补一个 `error` 忽略(客户端收到响应即 destroy, 回写竞态不该让用例红), 断言语义未改。
- 集成层: 新增 `tests/assemble.ts`(装配器, 不以 `.test.ts` 结尾)与 `tests/integration/plugin.test.ts`。装配器给三个假面: 事件面(`on` / `fire`)、服务面(`get` + services 表)、生命周期面(`effect` / `unload`), 另给手控排期表与按 `clock` 形状包装的假时钟、临时目录里的真 unix socket 上游、握手环境变量的设置与还原。上游逐行解析 JSON 报文并回一行 `ok`, 用例只等收包(带超时守卫)与失败沉降。
- 集成用例 11 条分三组: 入口与宿主接线(握手不全空转、`name` / `inject` 契约、四个事件监听各一次、启动期同步与卸载 release)、事件投影(`agent/status` 的 working / idle、提问与审批的 blocked 桥与解除、`session/event` 的 turn 阻塞 / 压缩在途)、服务面缺失与失败路径(`agents` 缺席、`roots` 非数组、socket 不可达、`clock` 服务可用时排期走服务面并在卸载撤销)。
- 脚本: `package.json` 加 `test:integration`(`tests/integration/*.test.ts`)与 `test:coverage`(两轮 glob 一起跑, `NODE_V8_COVERAGE` 落 `../tmp/cov-herdr-integration`, 再调 `dev/coverage/report.mjs tmp/cov-herdr-integration tmp/cov-herdr-integration/report.json`)。
- 未改 `src`; `tsconfig.json` 的 `exclude` 与空 `LICENSE` 等归阶段 3 / 4。

## 偏差

无。`src` 未改;测试侧只给 `tests/herdr.test.ts` 的 socket 服务端补了 `error` 忽略, 不改任何既有断言。

## 测试与证据

### 命令结果(分支 `history-cleanup/02-tests-herdr-integration`, Node v24.16.0)

| 命令 | 结果 |
| --- | --- |
| `pnpm -C herdr-integration run check` | ✓ 通过(无输出) |
| `pnpm -C herdr-integration run test` | ✓ 60 pass / 0 fail(基线 57), 5 suites, 约 0.54s |
| `pnpm -C herdr-integration run test:integration` | ✓ 11 pass / 0 fail, 3 suites, 约 2.9s;连跑 3 次全绿 |
| `pnpm -C herdr-integration run test:coverage` | ✓ 71 pass / 0 fail(单元 60 + 集成 11), 覆盖率见下表 |

`skip` / `todo` 均为 0;集成层的实时等待只有 socket 收包与失败沉降, 全部带超时守卫。

### 覆盖率(只统 `src`, 装配器与夹具不计;分母为 V8 实际观测到的 range)

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

### 新增 / 删除用例

新增 14 条(单元 3、集成 11), 见「实现记录」;删除 0 条。

### 豁免台账

| 缺什么 | 为什么补不了 | 触发条件 | 交给谁 |
| --- | --- | --- | --- |
| win32 命名管道分支(`src/herdr.ts:126-129`) | 本机 Linux, `process.platform === "win32"` 不可达 | 在 Windows 上跑本包测试 | 阶段 3 复核时按平台条件补 |

### 集成层贡献(两轮跑取差)

只跑单元层即改前一行(行 574/662);加集成层后为 607/662, 差值为行 +33、分支 +19, 集中在 `src/index.ts` 的生产发送器与生产 `readRoots` 装配, 以及 `src/herdr.ts` 的构造与超时接线。
