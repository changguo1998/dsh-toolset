# coagent 整理 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 coagent 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `coagent` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 4 个 `.test.ts` (`close.test.ts` / `guard.test.ts` / `spawn.test.ts` / `store.test.ts`); 阶段 1 末 `pnpm -C coagent run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 79.9% (1573/1969); 分支 62.4% (227/364).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C coagent run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-coagent && mkdir -p ../tmp/cov-coagent && NODE_V8_COVERAGE=../tmp/cov-coagent node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-coagent tmp/cov-coagent/report.json
```

- 专项: -.
- 验收: `pnpm -C coagent run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 coagent 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-coagent`, worktree `.worktree/03-code/coagent`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C coagent run check` 与 `pnpm -C coagent run test`.
- 任务:
  - 删失效导出 `src/herdr.ts:52` `notesOf`.
- 验收: `pnpm -C coagent run check` 与 `pnpm -C coagent run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(coagent): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

- 分支 `history-cleanup/04-package-docs-coagent`, worktree `.worktree/04-package-docs/coagent`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/DESIGN.md` / `docs/BACKLOG.md`.
- `README.md`: 现有 9 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- `docs/DESIGN.md`: 归并为四节 `## 背景` / `## 结构` / `## 机制` / `## 取舍`; 只改节名与合并重复, 机制与取舍内容不动.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- `docs/BACKLOG.md`: 同文件的命令与术语同步改; 条目内容、状态与顺序不动.
- 断链: `README.md` 里指向 `docs/implementation/` 的归档链接改为 `docs/archived/2026-10-22-coagent.md` (归档后的真实路径).
- 断链: `docs/DESIGN.md` 里指向 `docs/implementation/` 的归档链接改为 `docs/archived/2026-10-22-coagent.md` (归档后的真实路径).
- `README.md` 与 `docs/DESIGN.md` 的「herdr-use 的十个工具」改「终端工具」.
- 验收: 六节齐 (无配置可省)、四节齐、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(coagent): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

基线(分支上先跑): `pnpm -C coagent run test` 33 通过 / 0 失败 / 0 `skip` / 0 `todo`, 耗时约 135 ms; `pnpm -C coagent run check` 通过; 覆盖率行 79.9% (1574/1970)、分支 62.4% (227/364), 与「现状」一致。

新增与改动(全部在 `tests/` 与 `package.json`, `src` 未改):

| 文件 | 内容 |
| --- | --- |
| `coagent/tests/assemble.ts` | 集成层装配器(不以 `.test.ts` 结尾): 假工具面收集 `register`, 假事件面记录 `on`, 假服务面经 `ctx.get` 与 ctx 属性两路给出 `herdrUse` / `sessionChannel` / `sessionPaths`; 可切换 `herdrShape` / `tools` / `get` / `logger` / `with` 以覆盖缺席与降级路径 |
| `coagent/tests/integration/plugin.test.ts` | 18 条: 工具注册与参数面、`spawn` / `list` / `close` 的 canonical 回执、`output.render` 投影、`enabled=false`、服务缺失与形状残缺、`sessionPaths` 降级落盘、`ctx.get` 抛错退化、`logger` 退到 info / 抛错不阻断、索引损坏 → `record_write_failed`、探测抛错保留原状态、认领超时 → `claim_timeout` + `lost`、`sessionDirFor` 抛错 → `session_paths_unavailable`、无调用方会话 → `session_unavailable` |
| `coagent/tests/herdr.test.ts` | 7 条: `payloadOf` / `terminalIdOf` / `screenTextOf` / `runningOf` / `isTerminalGone` / `errorTextOf` / `notesOf` 的字段提取与缺省回退 |
| `coagent/tests/probe.test.ts` | 9 条: 探测判定表(缺 `terminal_id` / 已 `terminal_closed` / 未登记 / herdr 不可用 / 有前台进程 / 掉线 / `peers` 读失败 / 已 `closed`)与 `findPeer` 三态 |
| `coagent/tests/channel.test.ts` | 11 条: `matchPeer` 四个过滤条件(已知会话 / 5 s 容差 / profile / cwd 归一)、`screenFailureOf` 两条证据、`claimSession` 的 claimed / screen-failed / timeout 与日志 |
| `coagent/tests/launch.test.ts` | 9 条: `checkCwd` 四态、`buildLaunchCommand`、脱管痕迹词边界、`optionalString` / `positiveInt` / `booleanArg` / `rejectUnknownKeys` / `launchValueArg` / `parseSpawnArgs` |
| `coagent/tests/main.test.ts` | 3 条: `coagentRootOf` 两条推导路径(含 `DSH_HOME` 缺省)、`resolveConfig` 显式与缺省、`markParentExitSync` 坏索引不阻塞且跳过 `closed` / 墓碑 |
| `coagent/tests/spawn.test.ts` | 追加 1 条: 服务面调用抛错不裸抛(`create` → `terminal_create_failed`, `run` → `launch_failed` 且回滚 `close` 一次) |
| `coagent/tests/store.test.ts` | 追加 5 条: 索引形状逐字段拒绝、非 ENOENT 读失败与同步读坏 JSON、记录目录被文件占位时的 `StoreError` 与删除幂等、`saveSync` 根目录不可写、并发 `update` 串行不丢写 |
| `coagent/package.json` | 加 `test:integration` 与 `test:coverage`(覆盖率目录 `../tmp/cov-coagent`, 报告 `dev/coverage/report.mjs`) |

判定与取舍:

- 集成层走真实时钟, 但 `config` 把 `claimTimeoutSec` / `graceSec` / `pollIntervalMs` / `gracePollMs` 压到毫秒级, 单条最慢 1 s(认领超时那条), 全套集成约 1.1 s; 不新增对 `apply` 注入时钟的 `src` 改动。
- 未写 `todo`, 未新增 `skip`; 存量 0 处 `skip` 未动, 无夹具增删。
- 未碰 `src`; 装配器与用例只经 `src/index.ts` 与 `src/*.ts` 的公开导出。

### 阶段 3 代码整理

- 删失效导出 `notesOf` (`src/herdr.ts:51`): 全仓仅 `tests/herdr.test.ts` 引用, 删函数与对应 1 条用例, 同步删测试的 import.
- 其余规划项 (无) 不涉及; `src` 只有这一处改动, 行为不变.

## 偏差

1. 4.2 要求集成层「时间用 `ManualClock`」: 本包的 `apply` 内部固定用 `systemClock`, 无法注入, 故集成层用真实时钟 + 毫秒级等待上限(见上)。单元层仍全部用 `ManualClock`。
2. 分支覆盖率的分母随「被真正执行过的函数」增多而变大(V8 懒编译: 没跑到的函数只报外层 range, 不报内部块), 故分母从 364 增到 431(只跑单元层) / 468(单元 + 集成); 新增用例顺带加载了 `src/index.ts` 与 `src/types.ts` 的判定函数等此前未执行的部分。各文件的行与分支命中数只升, 唯一例外是 `tools.ts` 的分支比例(分母 12 → 17, 命中 10 → 14)。

## 测试与证据

### 阶段 3 实跑

| 命令 | 结果 |
| --- | --- |
| `pnpm -C coagent run check` | 通过 (tsc `--noEmit`, 无输出) |
| `pnpm -C coagent run test` | 77 通过 / 0 失败 / 0 `skip` (较阶段 2 少 1 条, 随 `notesOf` 一起删除) |

### 阶段 2 实跑

四条入口(分支上实跑):

| 命令 | 结果 |
| --- | --- |
| `pnpm -C coagent run check` | 通过(tsc `--noEmit`, 无输出) |
| `pnpm -C coagent run test` | 78 通过 / 0 失败 / 0 `skip` / 0 `todo`, 约 176 ms |
| `pnpm -C coagent run test:integration` | 18 通过 / 0 失败 / 0 `skip` / 0 `todo`, 约 1.1 s |
| `pnpm -C coagent run test:coverage` | 96 通过 / 0 失败, 报告落 `tmp/cov-coagent/report.json` |

覆盖率(改前 = 基线单元层; 改后 = 单元 + 集成):

| 包 | 改前行 | 改后行 | 改前分支 | 改后分支 |
| --- | --- | --- | --- | --- |
| coagent 合计 | 79.9% (1574/1970) | 88.1% (1744/1980) | 62.4% (227/364) | 78.6% (368/468) |

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 |
| --- | --- | --- | --- | --- |
| `src/actions.ts` | 75.1% (626/834) | 79.9% (666/834) | 66.7% (98/147) | 68.7% (112/163) |
| `src/channel.ts` | 90.6% (145/160) | 93.8% (150/160) | 54.1% (20/37) | 83.7% (41/49) |
| `src/herdr.ts` | 61.3% (19/31) | 100.0% (31/31) | 10.0% (1/10) | 100.0% (20/20) |
| `src/index.ts` | 未加载 | 100.0% (10/10) | 未加载 | n/a (0/0) |
| `src/launch.ts` | 80.6% (141/175) | 92.6% (162/175) | 67.2% (39/58) | 85.5% (59/69) |
| `src/main.ts` | 89.3% (184/206) | 95.6% (197/206) | 65.9% (27/41) | 85.7% (48/56) |
| `src/probe.ts` | 37.5% (21/56) | 94.6% (53/56) | 0.0% (0/3) | 78.3% (18/23) |
| `src/store.ts` | 82.7% (225/272) | 89.0% (242/272) | 48.8% (21/43) | 72.7% (40/55) |
| `src/tools.ts` | 91.7% (132/144) | 97.9% (141/144) | 83.3% (10/12) | 82.4% (14/17) |
| `src/types.ts` | 88.0% (81/92) | 100.0% (92/92) | 84.6% (11/13) | 100.0% (16/16) |

分层贡献(同一份用例两轮跑): 只跑单元层 84.9% (1672/1970) / 分支 76.8% (331/431); 单元 + 集成 88.1% (1744/1980) / 分支 78.6% (368/468), 集成层贡献行 +3.2 个百分点、分支 +1.8 个百分点。

`tools.ts` 分支比例微降(83.3% → 82.4%)来自分母增大(12 → 17 块, 新增被加载函数的未命中块), 绝对值 10 → 14, 非退化。

用例与夹具: 新增单元用例 45 条(33 → 78)、集成用例 18 条; 未删除用例、未增删夹具; `skip` 0 处、`todo` 0 处; 本机无环境探测类 `skip` 触发。

未覆盖的防御分支(按 4.3 豁免, 不补用例): `actions.ts` 的 `#archive` 记录落盘失败后二次失败提示(需在 `create` 成功后精确注入写盘失败, 现有用例只能覆盖到读盘阶段的 `record_write_failed`)、`claimSession` 的 `attempts >= 10_000` 兜底(时钟不推进才可达)、`main.ts` 的 `markParentExitSync` 内层写盘失败吞异常(退出路径尽力而为)。

## 四份测试产物

| 产物 | 位置 |
| --- | --- |
| 覆盖率表 (改前 / 改后) | 见「测试与证据」的覆盖率表 |
| 新增 / 删除用例清单 | 见「实现记录」的「单元锚点 / 集成层」段 |
| `skip` 计数与豁免台账 | 见「测试与证据」的 `skip` / 豁免段 |
| 四个入口实跑 | 见「测试与证据」的入口段 |
