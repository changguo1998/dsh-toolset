# session-channel 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 session-channel 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `session-channel` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 9 个 `.test.ts` (`agent-state.test.ts` / `alias.test.ts` / `apply.test.ts` / `broker.test.ts` / `client.test.ts` / `inject.test.ts` / `service.test.ts` / `task.test.ts` / `tools.test.ts`); 阶段 1 末 `pnpm -C session-channel run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 86.9% (3326/3827); 分支 61.9% (409/661).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C session-channel run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-session-channel && mkdir -p ../tmp/cov-session-channel && NODE_V8_COVERAGE=../tmp/cov-session-channel node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-session-channel tmp/cov-session-channel/report.json
```

- 专项: -.
- 验收: `pnpm -C session-channel run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 session-channel 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-session-channel`, worktree `.worktree/03-code/session-channel`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 前置: `clock-base` 已合并, 本分支从含它的 `main` 开.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C session-channel run check` 与 `pnpm -C session-channel run test`.
- 任务:
  - 删失效导出: `src/broker.ts:813` `countTasks`; `src/keys.ts` 的 `STATE_PATTERN`、`sessionIdFromStateKey`、`TASK_INDEX_PATTERN`、`sessionIdFromTaskIndexKey` 共 4 个.
  - `src/index.ts` 内联的 `systemTimers` 换成 `clock-base` 导出; 入口保留同名 re-export, 调用点不动.
  - 拆 `src/index.ts` (1929 行): 会话 / 任务 / 工具面分层.
  - `src/inject.ts` 的上下文对象守卫收进入口.
  - `package.json` / `pnpm-lock.yaml` 加 `link:../clock-base`.
- 验收: `pnpm -C session-channel run check` 与 `pnpm -C session-channel run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(session-channel): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

阶段 4 补.

## 实现记录

- 单元锚点: 新增 `tests/entry.test.ts` (3 条) —— `systemTimers` 的 schedule / interval 撤销语义, `resolveTimers` 四条回落路径 (缺服务 / 缺 `scope` / `scope` 返回形状不符 / `scope` 抛错) 与合法 clock 原样使用; `tests/client.test.ts` 追加 1 条假客户端用例, 锁 `healthCheck` 的 PING 异常 / 版本过低 / 版本解析失败 / 标记键缺失写入四条分支; `tests/task.test.ts` 补 `truncateUtf8` 的两个边界 (单字符放不下 → 空串, 截断点落字符中间 → 前退)。
- 集成层: 新增 `tests/assemble.ts` (装配器, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (9 条)。
  - 三个假面与 4.2 同形: 假工具面收集 `register`, 假事件面记录 / 手动 `emit`, 假服务面 `get` 提供 `agents` / `sessions` 替身、`provide` 记录服务。
  - 假 broker: `createFakeRedis()` 内存版 Redis, 实现本包用到的 `get` / `set` (EX / KEEPTTL) / `del` / `expire` / `scanIterator` / `eval` (共享 KV 的 CAS 脚本按契约等价实现) / `xAdd` / `xRevRange` / `xRead` / `lPush` / `lTrim` / `lRange`; `xRead` 无消息时让出事件循环 5 ms, 模拟 `BLOCK` 且不忙等。
  - 覆盖: 四个工具的注册名 / 参数面 / 出口 schema; 禁用态 13 组 canonical 回执与参数校验; 四个工具的 `output.render` 投影 (对象 / 字符串 / `undefined` / 循环引用兜底); 连接态四类事件订阅、会话发现、agent 状态牌三态 (转换写牌 / 同态不刷 `at` / 销毁删牌); send 注入正文与回执、inbox、别名 set / list / 按别名寻址 / clear; delegate → `user/message` 注入对位 → 显式回传 → 通知委托方 → 终态不可取消 / 非终态取消; 轮末自动回收与通知; 服务面经 `ctx.get("agents")` 注入并调 `flush`、共享 KV 版本自增 / CAS 冲突 / 删除; 无工具面只告警、无 provide 面不抛。
- 脚本: `package.json` 加 `test:integration` 与 `test:coverage` (覆盖率参数 `tmp/cov-session-channel`)。
- `src` 未改。

### 阶段 3 代码整理 (分支 `history-cleanup/03-code-session-channel`)

- 删失效导出: `src/broker.ts` 的 `countTasks` (18 行, 连带删 `TaskStatus` 类型 import) 与 `src/keys.ts` 的 `STATE_PATTERN` / `sessionIdFromStateKey` / `TASK_INDEX_PATTERN` / `sessionIdFromTaskIndexKey` (4 个, 22 行)。删前重扫全仓 (`src` / `tests` / `scripts` / `docs`): 除总追踪 / 本文件的待删清单与历史归档外零引用。

- 定时器族: `src/index.ts` 内联的 `systemTimers` (15 行) 删掉, 改从 `@dsh-toolset/clock-base` 入口引入并由 `src/index.ts` 同名 re-export; 调用点 (`resolveTimers` 的四处回落) 未动。

- 拆长文件 (1928 行入口 → 161 行): 新增 `src/service.ts` (1055 行, 会话层: 连接 / 会话跟踪 / 心跳 / 投递 / 别名 / 共享 KV / 服务面方法 / `resolveTimers`)、`src/task-layer.ts` (471 行, 任务层: `TaskLayer` 承接 `delegate` / `taskStatus` / `taskList` / `taskCancel` / `taskResult` 与 `user/message` 对位、`turn/end` 轮末回收、结果通知, 经 `TaskLayerHost` 取连接 / 时钟 / 日志 / 标签 / 正文上限)、`src/tools.ts` (404 行, 工具面: 四个工具定义、`toLosslessJson` 归一、`SERVICE_FACE_METHODS`)。`src/index.ts` 只留 bundle 接线 (`name` / `inject` / `provide` / `apply`)、`activeService` 与对外 re-export; 拆出的模块不新增包入口 (`package.json` 未加 `exports`), 测试 import 路径未改。

- 任务层边界: 服务实例保留五个任务方法的连接判定外壳 (错误文案与判定顺序不变), 任务表读写与回收搬进 `TaskLayer`; `#workerTasks` 队列随之下移, 服务类不再持有。

- 上下文对象守卫: 入口 `apply` 判一次 (`null` / 非对象按空上下文处理; 此前 `ctx` 为 `null` 时在 `ctx.logger` 处抛 `TypeError`), 下游 (`createSessionChannelService` 收到的 ctx、`apply` 里的 `tools` / `provide` 读取) 不再重复判; 宿主服务读取的唯一对象判断仍在 `src/inject.ts` 的 `readService`。

- 依赖: `package.json` 加 `@dsh-toolset/clock-base: link:../clock-base`, 本包目录 `pnpm install` 更新 `pnpm-lock.yaml` (importer 一项) 并建 `node_modules/@dsh-toolset/clock-base -> ../../../clock-base`。

- 对外面: `createSessionChannelService` / `SessionChannelService` / `resolveTimers` / `systemTimers` / 四个归一函数 / `SERVICE_FACE_METHODS` / `BundleHost` 等类型仍从包入口导出; `AgentState` 等六个类型与 `SessionChannelError` 不变。

- 提交: `ed3112a4` 删失效导出 → `e5c71570` 定时器族改 clock-base (含依赖与 lockfile) → `caf3793b` 入口按会话 / 任务 / 工具面拆分 → `c5b681e3` 上下文对象守卫收进入口。

- 阶段 3 补丁 (2026-11-01): 入口 `warn` 与服务 `#log` 改为显式分支, 消除 `info()` 返回 `void` 时重复落 stderr.

## 偏差

- 接线方式: `apply` 不接 `SessionChannelDeps` (签名只有 `ctx` / `config`), 无法把假 broker 注入 `apply` 自建的服务。为不改 `src`, 装配器分两步: 先用 `apply(ctx, { disabled: true })` 拿到注册面 (不发起连接、不订阅事件), 再用 `createSessionChannelService(..., { connect: 假连接 })` 起「假 broker 上的真服务」, 把 apply 服务实例的服务面方法逐条绑定过去 (`wireLive()`)。工具与 provide 面闭包都按属性名延迟取值 (`service.peers()`), 故接线后走的是同一份真实现。代价: `apply` 内「连接成功 → `#afterConnect`」这一跳只由连接态用例间接验证 (真 Redis 用例已覆盖); 若阶段 3 给 `apply` 补可选 `deps` 形参, 可去掉这层绑定。
- 假 broker 的 `eval`: 只按 `KV_PUT_SCRIPT` 的契约在 JS 里等价实现 (CAS + 版本自增 + TTL), 不执行 Lua 本身; Lua 语法与 `cjson` 行为仍由真 Redis 用例 (`tests/broker.test.ts` / `tests/service.test.ts`) 覆盖。
- 分支分母随执行路径增多: `broker.ts` 分支 76.4% → 76.1% (覆盖数 133 → 134, 分母 174 → 176), `index.ts` 分支分母 385 → 431; 整包行 / 分支均上升, 无回退。

阶段 3 的偏差:

- 计划顺序把「加 `link:` 依赖」列为第 5 步, 实际与第 2 步 (定时器族改 `clock-base`) 同时落地: 引包名 import 前必须先有依赖与 `node_modules` 链接, 否则 `check` / `test` 解析不到; 第 5 步无单独提交, 内容在 `e5c71570`。
- 拆分比计划多一个内部模块分工: 会话层的载荷解析 (`textOfUserMessage` / `textOfContent`) 随任务层落在 `src/task-layer.ts`, 避免 `service.ts` 与 `task-layer.ts` 循环依赖; 未新增对外导出。
- `clock-base` 的 `systemTimers` 对非有限延迟抛 `RangeError` (本包原实现直接把值交给 `setTimeout`), 属上游统一口径; 现有用例不触达该分支, 未加兼容层。
- 跨包 import 走包名 (解析到 `clock-base/dist/`), 故 `check` / `test` 前须先 `pnpm -C ../clock-base run build`; 与实现规划的前置一致, 代价是本包测试多一条构建前置。
- 本包没有 `tests/clock.test.ts` 之类的跨包内部 import 需要收口; `tests/` 未改 (import 路径与断言都未动)。

## 测试与证据

改前 (基线, 只跑单元层, 74 条): 行 86.9% (3327/3828), 分支 61.9% (409/661)。

改后 (单元 + 集成, 87 条): 行 88.2% (3377/3828), 分支 66.2% (473/714)。

分层贡献 (两轮跑取差): 单元层 78 条 → 行 87.3% (3342/3828), 分支 63.0% (421/668); 加集成层后 +35 行、+52 分支。

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 |
| --- | --- | --- | --- | --- |
| session-channel/src/alias-words.ts | 100.0% (1075/1075) | 100.0% (1075/1075) | 87.5% (7/8) | 87.5% (7/8) |
| session-channel/src/broker.ts | 91.2% (636/697) | 91.2% (636/697) | 76.4% (133/174) | 76.1% (134/176) |
| session-channel/src/client.ts | 84.4% (124/147) | 90.5% (133/147) | 73.0% (27/37) | 82.9% (34/41) |
| session-channel/src/constants.ts | 100.0% (11/11) | 100.0% (11/11) | n/a | n/a |
| session-channel/src/index.ts | 76.0% (1248/1642) | 78.3% (1285/1642) | 51.2% (197/385) | 58.2% (251/431) |
| session-channel/src/inject.ts | 94.1% (64/68) | 94.1% (64/68) | 81.8% (18/22) | 81.8% (18/22) |
| session-channel/src/keys.ts | 82.7% (62/75) | 82.7% (62/75) | 0.0% (0/3) | 0.0% (0/3) |
| session-channel/src/tasks.ts | 94.1% (96/102) | 98.0% (100/102) | 84.4% (27/32) | 87.9% (29/33) |
| session-channel/src/types.ts | 100.0% (11/11) | 100.0% (11/11) | n/a | n/a |
| 合计 | 86.9% (3327/3828) | 88.2% (3377/3828) | 61.9% (409/661) | 66.2% (473/714) |

新增 / 删除用例: 新增 13 条 (单元 4: `entry.test.ts` 3 + `client.test.ts` 1; 集成 9), 修改既有断言 1 处 (`tests/task.test.ts` 追加边界断言, 原断言语义不变); 未删除用例, 未改夹具。

`skip` / `todo`: 本机 `skipped` 0、`todo` 0; 未新增条件式 `skip`; 豁免台账为空 (`tests/helpers.ts` 的 `redisTest` 属既有「缺 `redis-server`」探测, 本机触发 0 条)。

四条入口实跑 (分支 `history-cleanup/02-tests-session-channel`, 本机 redis-server 7.0.15 在场):

- `pnpm -C session-channel run check`: 通过 (tsc --noEmit, 无输出)。
- `pnpm -C session-channel run test`: 78 条通过, 0 失败, 0 跳过, 10.1 s。
- `pnpm -C session-channel run test:integration`: 9 条通过, 0 失败, 0 跳过, 4.4 s。
- `pnpm -C session-channel run test:coverage`: 87 条通过, 0 失败, 0 跳过; 汇总见上表; 产物 `tmp/cov-session-channel/report.json`。
- 真机验收: 未做 (本阶段不出网、不连真 Redis 之外的宿主面); 留 `scripts/install.sh --sync` 之后人工确认。

阶段 3 (每步跑 `check` 与 `test`, 先 `pnpm -C clock-base run build`):

- `pnpm -C session-channel run check`: 通过 (tsc --noEmit, 无输出), 四步各一次。
- `pnpm -C session-channel run test`: 78 条通过, 0 失败, 0 跳过, 每步 10.1 s 左右。
- `pnpm -C session-channel run test:integration`: 9 条通过, 0 失败, 0 跳过, 4.4 s (拆分后与守卫后各跑一次)。
- `pnpm -C session-channel run build`: 通过 (先构建 `clock-base`)。
- 冒烟: `apply(null, { disabled: true })` 不再抛, 打印「tools 未挂载」告警后返回。
- 用例: 断言、标题、条数 (单元 78 / 集成 9) 与夹具均未改, 测试 import 路径未改。
- 入口行数: `src/index.ts` 1928 → 161; 新层 `service.ts` 1055、`task-layer.ts` 471、`tools.ts` 404 (合计 2091 ≈ 拆分前 1928 + 接线与二层边界代码)。
