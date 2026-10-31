# background-daemon 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 background-daemon 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `background-daemon` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 15 个 `.test.ts` (见 `tests/`); 阶段 1 末 `pnpm -C background-daemon run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 85.4% (2810/3291); 分支 72.8% (554/761).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C background-daemon run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-background-daemon && mkdir -p ../tmp/cov-background-daemon && NODE_V8_COVERAGE=../tmp/cov-background-daemon node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-background-daemon tmp/cov-background-daemon/report.json
```

- 专项: -.
- 验收: `pnpm -C background-daemon run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 background-daemon 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

- 单元锚点: 新增 `tests/guard.test.ts` 6 条, 覆盖引擎侧命令复查的缺失 / 形状不符 / 非空回执 / 空白回执 / 抛错 / 无效 ctx 六条路径（此前 `guard.ts` 分支覆盖 0%）。在既有文件追加 18 条:
  - `tests/apply.test.ts` 5 条: `clock` 形状不符与 `scope` 抛错的回落、`ctx.inject` 读取抛错、`provide` / 工具注册 / dispose 事件面抛错的降级、memory 底座注册抛错、agents / sessions 缺失告警。
  - `tests/commands.test.ts` 4 条: start / stop 幂等文案、任务表损坏时 `start` 失败并回滚开关、`run` 缺 id、`log` 条数非法回落 20。
  - `tests/scheduler.test.ts` 4 条: 渠道未注册记 `failed(error)`、`runNow` 目标无活跃 agent、`runNow` 未知任务与渠道抛错、`durable:false` 的 volatile 告警。
  - `tests/store.test.ts` 3 条: `validateDaemonTask` 逐字段拒绝表、顶层非对象 / 缺 `tasks` 数组、不可用时写类操作抛错。
  - `tests/tools.test.ts` 2 条: 未暂停时 `resume` 报 `not_paused`、`log` 缺省取全局流水与 limit 回落。
- 集成层: 新增 `tests/assemble.ts`（工具 / 事件 / 服务三个假面, 附假 clock 与临时目录; 不以 `.test.ts` 结尾）与 `tests/integration/plugin.test.ts` 10 条。装配 `apply` 后断言: `daemon_task` 注册名 / 参数面 / 描述、`execute` 的 canonical 值（create / list / show / pause / resume / cancel / log 与 `task_not_found` / `unknown_action` / `frequency_too_high`）、`output.render` 的单条 text JSON 投影、`/daemon` 命令注册与 handler 输出、文本与命令两条投递内容（注入前缀 / source / 目标会话 / 规范化 slash 行 / guardSkipped）、`dispose` 事件撤销调度器且幂等、服务面 `provide` 与 `get` 同一实例及状态视图字段、memory 底座经 `inject` 晚挂后状态与写透同步。
- 脚本: `package.json` 增 `test:integration` 与 `test:coverage`; 覆盖率目录用 `../tmp/cov-background-daemon`（从包目录写入仓库根 `tmp/`）, `report.mjs` 的两个参数按仓库根解析写 `tmp/cov-background-daemon`。
- `src` 未改（无偏差记录）。

## 偏差

无（本阶段未改 `src`; 规划文档示例覆盖率命令把 `report.mjs` 的两个参数也写成 `../tmp/...`, 按任务口径与仓库既有包改为 `tmp/cov-background-daemon`）。

## 测试与证据

命令实跑（分支 `history-cleanup/02-tests-background-daemon`）:

| 入口 | 结果 |
| --- | --- |
| `pnpm -C background-daemon run check` | ✓ 通过（`tsc --noEmit`, 无输出） |
| `pnpm -C background-daemon run test` | ✓ 190 pass / 0 fail / 0 skipped / 0 todo, 268.5 ms |
| `pnpm -C background-daemon run test:integration` | ✓ 10 pass / 0 fail, 107.4 ms |
| `pnpm -C background-daemon run test:coverage` | ✓ 200 pass / 0 fail, 行 89.8% (3093/3445), 分支 78.3% (624/797) |

用例增减:

- 新增 34 条: 单元 24 条（`guard.test.ts` 6, `apply.test.ts` 5, `commands.test.ts` 4, `scheduler.test.ts` 4, `store.test.ts` 3, `tools.test.ts` 2）; 集成 10 条。
- 删除 0 条; 改写 0 条（既有断言未动）。
- `skip` / `todo`: 改前 0 / 0, 改后 0 / 0; 无豁免台账（本机无环境探测类 `skip`）。
- 夹具: 本包无夹具目录, 未新增。

覆盖率（改前 = 阶段 1 末仅单元层; 改后 = 单元 + 集成）:

| 文件 | 改前行 | 改前分支 | 改后行 | 改后分支 |
| --- | --- | --- | --- | --- |
| src/commands.ts | 76.0% (212/279) | 68.8% (53/77) | 76.3% (213/279) | 70.0% (56/80) |
| src/control.ts | 84.9% (101/119) | 74.4% (29/39) | 84.9% (101/119) | 74.4% (29/39) |
| src/deliver.ts | 88.1% (223/253) | 78.7% (48/61) | 88.1% (223/253) | 78.7% (48/61) |
| src/due.ts | 100.0% (51/51) | 95.5% (21/22) | 100.0% (51/51) | 95.2% (20/21) |
| src/guard.ts | 56.3% (27/48) | 0.0% (0/3) | 97.9% (47/48) | 87.5% (7/8) |
| src/index.ts | 未计入（无用例 import） | - | 100.0% (153/153) | n/a |
| src/journal.ts | 81.0% (115/142) | 69.8% (37/53) | 81.0% (115/142) | 69.8% (37/53) |
| src/main.ts | 87.9% (357/406) | 73.0% (54/74) | 89.9% (365/406) | 79.7% (63/79) |
| src/records.ts | 90.1% (329/365) | 67.6% (48/71) | 90.1% (329/365) | 67.6% (48/71) |
| src/scheduler.ts | 84.9% (409/482) | 75.2% (76/101) | 91.5% (441/482) | 81.9% (86/105) |
| src/selectors.ts | 87.9% (276/314) | 79.5% (70/88) | 88.5% (278/314) | 82.0% (73/89) |
| src/service.ts | 100.0% (47/47) | 60.0% (3/5) | 100.0% (47/47) | 60.0% (3/5) |
| src/services.ts | 92.9% (26/28) | 86.7% (13/15) | 92.9% (26/28) | 86.7% (13/15) |
| src/store.ts | 75.0% (210/280) | 68.7% (46/67) | 94.6% (265/280) | 92.5% (74/80) |
| src/switch.ts | 100.0% (15/15) | n/a | 100.0% (15/15) | n/a |
| src/target.ts | 96.3% (26/27) | 85.7% (6/7) | 96.3% (26/27) | 85.7% (6/7) |
| src/tools.ts | 89.8% (247/275) | 64.2% (34/53) | 93.8% (258/275) | 76.3% (45/59) |
| src/types.ts | 100.0% (4/4) | n/a | 100.0% (4/4) | n/a |
| src/tz.ts | 86.6% (136/157) | 64.0% (16/25) | 86.6% (136/157) | 64.0% (16/25) |
| 合计 | 85.4% (2811/3292) | 72.8% (554/761) | 89.8% (3093/3445) | 78.3% (624/797) |

口径说明: 行覆盖只升不降; `due.ts` 分支计数由 21/22 变为 20/21 是 `report.mjs` 跨进程合并 range 的口径波动（同一 range 取最大命中, 分母随进程组合变化）, 该文件 51/51 行仍全覆盖, 本阶段未改用例语义。`index.ts` 此前没有被任何用例 import, 故未进统计; 集成层经包入口 import 后按 100% 计入, 合计分母的增量主要来自它。

改后剩余未覆盖行（完整清单见 `tmp/cov-background-daemon/report.json`）:

| 文件 | 未覆盖行（0 基行号, 同 report 输出） |
| --- | --- |
| src/commands.ts | 42,43,83,84,96,97,149,150,161-164,189-194,200-216,235-246,248,260,269-272,281,290-301 |
| src/control.ts | 27,28,31,32,36,55-57,68-71,117,121,145,146,153,154 |
| src/deliver.ts | 32,79-97（多行模板与注释行）,152,153,197-200,237-243,257,263 |
| src/journal.ts | 57-61,105,108,124-129,138-146,151,152,158,162-164,167,170 |
| src/main.ts | 125,127,132,155,156,203-219,252-256,263,264,294,300,301,305,306,342,357,367-369,421-425 |
| src/records.ts | 92,95,113,114,157-163,173,174,192,208,213-217,230,232,255-261,279,340,355-358,371,378-382 |
| src/scheduler.ts | 35,36,39-41,80-86,144,145,246,248,253,254,280-282,285-292,304,305,334,372,428,462,496,497,507,508,535-539 |
| src/selectors.ts | 64,74,75,160-163,180,206-213,247-256,281-283,308,309,368-372 |
| src/services.ts | 13,30 |
| src/store.ts | 216,217,243,244,289-296,308-310 |
| src/target.ts | 42 |
| src/tools.ts | 17,134,135,165,181,191,206,217-219,262,265,266,288-291 |
| src/tz.ts | 67,68,74,75,78,91,92,105-108,154-156,182-185,188-190 |
| src/guard.ts | 20 |
| src/due.ts / src/index.ts / src/service.ts / src/switch.ts / src/types.ts | 行全覆盖 |

未覆盖部分的三类来源: 多行模板字符串 / 接口声明的续行被 `report.mjs` 按原始字节区间记为「未命中」（`commands.ts`、`deliver.ts`、`scheduler.ts` 的大部分条目）; 异步镜像与 journal 轮转的少数写盘失败分支（`journal.ts`、`records.ts`, 需人为造磁盘错误）; `tz.ts` 的 DST 稀有分支。均未用空跑用例凑数。

