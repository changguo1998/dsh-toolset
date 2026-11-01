# rule-engine 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 rule-engine 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `rule-engine` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 14 个 `.test.ts` (见 `tests/`); 阶段 1 末 `pnpm -C rule-engine run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 94.7% (2335/2465); 分支 88.8% (640/721).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: `tests/main.test.ts` / `tests/consumerGuard.test.ts` 的 `herdr_use` 旧名改 `herdr_run`

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C rule-engine run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-rule-engine && mkdir -p ../tmp/cov-rule-engine && NODE_V8_COVERAGE=../tmp/cov-rule-engine node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-rule-engine tmp/cov-rule-engine/report.json
```

- 专项: `tests/main.test.ts` / `tests/consumerGuard.test.ts` 的 `herdr_use` 旧名改 `herdr_run`.
- 验收: `pnpm -C rule-engine run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 rule-engine 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

- 脚本: `rule-engine/package.json` 加 `test:integration` 与 `test:coverage`, 命令与 `metric-loop` / `memory-base` 同构; 覆盖率临时目录 `tmp/cov-rule-engine`, 报告 `tmp/cov-rule-engine/report.json`.
- 装配器: `rule-engine/tests/assemble.ts` (不以 `.test.ts` 结尾, 不参与覆盖率统计)。三个假面按 `src/index.ts` 的结构面声明拼装: 工具面记注册定义并给 `call` / `render` 两个入口; 事件面给 `session/event` / `session/created` / `tools/pre-execute` 三个派发口, 其中 pre-execute 按宿主 waterfall 语义串监听器; 服务面记 `provide` 并让 `ctx.get` 返回 tools / sessionProjections / clock。选项覆盖工具面缺席与注册抛错、服务面缺席与 provide 抛错、`ctx.get` 整体抛错 (cordis 严格模式)、clock 缺席。状态目录用系统临时目录, `dispose()` 删除并撤销未触发排期; 告警从 stderr 抓取。
- 集成层: `rule-engine/tests/integration/plugin.test.ts` 13 条, 覆盖工具注册名与参数面、`execute` 的 canonical 返回值与落盘、`output.render` 投影、事件派发到注入消息形状 (含 `turn/end` 与 `session/created`)、消费者 `decide` / `guard` 的唤醒与注销、`tools/pre-execute` 的 deny 短路与放行、服务面 `onNotice` 订阅退订、`dedupeInRecord` 读 inbox 去重、以及工具面 / 服务面 / 严格读面三条降级路径。
- 单元锚点: `tests/main.test.ts` 补 `guardContextOf` 一条, 断导出面的 canonical 上下文 (name / arguments / callId / sessionId) 与结构性缺省 (空 callId、非字符串 name、agent 畸形一律省略 sessionId)。其余存量的 174 条用例语义未改。
- 专项: `tests/main.test.ts` 两处与 `tests/consumerGuard.test.ts` 两处 `herdr_use` 改 `herdr_run` (用例自造的拒绝理由, 与 `behavior-correction` 实际文案一致)。
- `skip` / `todo` / 夹具: 本包测试代码里 0 处 `skip`、0 处 `todo`, 无 `tests/fixtures` 目录, 无删除项。

## 偏差

无。`src` 未改 (覆盖缺口都是既有代码路径, 阶段 3 才动)。

## 测试与证据

四条命令 (分支 `history-cleanup/02-tests-rule-engine`, 提交前实跑):

| 入口 | 结果 |
| --- | --- |
| `pnpm -C rule-engine run check` | 通过, 无输出 (exit 0) |
| `pnpm -C rule-engine run test` | 175 条全过, 175 pass / 0 fail / 0 skipped / 0 todo, 297ms |
| `pnpm -C rule-engine run test:integration` | 13 条全过, 13 pass / 0 fail / 0 skipped / 0 todo, 132ms |
| `pnpm -C rule-engine run test:coverage` | 通过, 报告 `tmp/cov-rule-engine/report.json` |

覆盖率 (只统 `src`; 改前 = 只跑单元层, 改后 = 单元加集成):

| 阶段 | 行 | 分支 |
| --- | --- | --- |
| 改前 (单元层) | 94.7% (2335/2465) | 88.7% (638/719) |
| 改后 (单元 + 集成) | 94.8% (2337/2465) | 88.8% (647/729) |

集成层贡献 +2 行 / +9 分支; 分支分母由 719 变 729 是两轮 V8 range 合并后多出的 range, 占比口径以百分比为准。分层两轮跑: 单元层 `tmp/cov-re-unit2`, 合并层 `tmp/cov-rule-engine`。

改后每文件表:

| 文件 | 行 | 分支 | 未覆盖行 |
| --- | --- | --- | --- |
| `src/engine.ts` | 96.4% (975/1011) | 87.8% (317/361) | 158, 224, 323, 347-348, 363, 409, 441, 449, 464-466, 469-470, 553, 588, 762, 862-863, 877, 906, 981, 997, 1002-1008, 1017-1018, 1053, 1080, 1145, 1188 |
| `src/index.ts` | 96.9% (315/325) | 93.8% (75/80) | 196, 210-213, 329-330, 332-334 |
| `src/inject.ts` | 98.6% (139/141) | 91.2% (31/34) | 81, 93 |
| `src/match.ts` | 100.0% (106/106) | 93.2% (41/44) | - |
| `src/persist.ts` | 100.0% (104/104) | 96.0% (24/25) | - |
| `src/rules.ts` | 96.0% (313/326) | 89.8% (115/128) | 99, 106-107, 111-113, 179, 274-278, 336 |
| `src/timers.ts` | 60.6% (94/155) | 62.5% (10/16) | 17-19, 33-34, 37, 39, 41, 47, 57-60, 91-93, 102-107, 113-117, 120-134, 137-148, 150-159 |
| `src/tools.ts` | 98.0% (291/297) | 82.9% (34/41) | 116-117, 207, 256, 292, 323 |

缺口说明: `timers.ts` 的裸定时器回落 (`systemTimers`) 与 `detached` 面、`engine.ts` 的若干防御分支是既有代码, 本阶段只补锚点不改写法; 阶段 3 代码整理时一并处理, 不在此处补空跑用例。报告里的行号取自 `--experimental-transform-types` 的 V8 range, 与源码行存在一两行偏移, 只作定位参考。

新增 / 删除用例: 新增 `tests/integration/plugin.test.ts` 13 条、`tests/main.test.ts` 补 1 条 (`guardContextOf`); 未删除用例; 未删除夹具。`skip` 计数: 0。
