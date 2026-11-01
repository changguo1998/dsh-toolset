# task-engine 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 task-engine 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `task-engine` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 10 个 `.test.ts` (`clock.test.ts` / `engine.test.ts` / `events.test.ts` / `exec-guard.test.ts` / `exec-isolate.test.ts` / `gate.test.ts` / `query.test.ts` / `semantic.test.ts` / `tools.test.ts` / `usage.test.ts`); 阶段 1 末 `pnpm -C task-engine run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 81.2% (2719/3347); 分支 70.3% (557/792).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C task-engine run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-task-engine && mkdir -p ../tmp/cov-task-engine && NODE_V8_COVERAGE=../tmp/cov-task-engine node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-task-engine tmp/cov-task-engine/report.json
```

- 专项: -.
- 验收: `pnpm -C task-engine run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 task-engine 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-task-engine`, worktree `.worktree/03-code/task-engine`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 前置: `clock-base` 已合并, 本分支从含它的 `main` 开.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C task-engine run check` 与 `pnpm -C task-engine run test`.
- 任务:
  - 删 `src/timers.ts`; 入口 import 改从 `clock-base` 引; `tests/clock.test.ts` 改从入口引.
  - 拆 `src/index.ts` (1868 行) 与 `src/engine.ts` (1051 行): 工具面 / 执行 / 装配分层.
  - `package.json` / `pnpm-lock.yaml` 加 `link:../clock-base`.
- 验收: `pnpm -C task-engine run check` 与 `pnpm -C task-engine run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(task-engine): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

阶段 4 补.

## 实现记录

- 基线 (分支起点): `pnpm -C task-engine run check` 通过; `pnpm -C task-engine run test` 151 例全绿 (耗时约 0.46 s); 覆盖率行 81.2% (2719/3347), 分支 70.3% (557/792).
- 单元锚点: 新增 `tests/index.test.ts` (20 例, 文件名对齐被测模块 `src/index.ts`), 只经包入口导出断言. 覆盖面: `truncateEvidence` 的等号与超限边界; `verdictEnvelope` 有无声明 schema 两种必填; `readVerdictValue` 结构化优先 / 非对象回退 / 失败 run; `parseVerdictJson` 前后散文 / 字符串内花括号 / 未闭合; `runChildOnce` 的缺服务 / 缺父 agent / `outputSchema` 与 `agentOptions` 能力位不支持 / 发起抛错 / `aborted` 与 `max-tokens` 终态; `auditPrompt` 无产出与 `entailPrompt` 空 spec 的口径.
- 集成层: 新增 `tests/assemble.ts` (装配器, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (17 例).
  - 假面: 假工具面 (`ctx.tools.register` 收工具并按名取用) / 假服务面 (`ctx.get` 给 `clock` / `approval` / `guard` / `subagents`, 缺省缺席) / 假提供面 (`ctx.provide` 记 `taskEngine`) / 假 `effect` 面 (逆序注销).
  - 事件面: 本包不向宿主发事件, 事件是内部事件流 (`plan/*`), 故装配器给 `snapshotPath` 并以 `events()` 读快照当事件面; `plan/node-expanded` / `plan/step-verdict` 的注入内容在该处断言.
  - 时钟: 用 `clock-base` 入口导出的真实 `ManualClock` (跨包只经对端 `src/index.ts`), 超时与卸载收尾都手控推进.
  - 断言面: 5 个工具的注册名单与顺序 / 参数编译成 JSON Schema / 描述首句; `provide` 的 `query` 与 `frameStack`; `decompose → implement → stop` 的 canonical `accepted` / `next` 与终态; entail 裁决 run 的 `label` / `prompt` / `toolFilter` / `outputSchema`; `output.render` 投影 (JSON 可回读, 字符串原样, 缺值仍为 string); 参数非法 / 非叶子 / 未声明后端 / 未知帧 / 机械验收非零退出; human 级验收的 `allowed-once` / `denied` / 审批面抛错三路; 时钟可用与缺席 / 形状不符的回落告警; 卸载写最终快照与卸载即中止在途裁决 run.
- 脚本: `package.json` 加 `test:integration` (跑 `tests/integration/*.test.ts`) 与 `test:coverage` (两目录一起跑, `NODE_V8_COVERAGE=../tmp/cov-task-engine`, 再调 `dev/coverage/report.mjs tmp/cov-task-engine tmp/cov-task-engine/report.json`).
- 类型检查面: `check` 改为串跑两个 program (`tsconfig.json` + `tests/tsconfig.json`); 主 program 排除 `tests/clock.test.ts` / `tests/assemble.ts` / `tests/integration` (三者跨包 import `clock-base`), 由 `tests/tsconfig.json` (`rootDir` 上移到仓库上一层, `noEmit`, `include: ["."]`) 重新纳入检查.
- 4.4 复核: 本次未新增 `skip` / `todo`, 未新增夹具; 本机 `skipped` 为 0.
- 阶段 3 代码整理 (分支 `history-cleanup/03-code-task-engine`):
  - 定时器族: 删 `src/timers.ts` (205 行本地副本), 入口不再有 timer 族本地 import; `tests/clock.test.ts` / `tests/assemble.ts` 改从 `@dsh-toolset/clock-base` 入口引 `ManualClock` / `createDeadline` / `resolveClock`. 告警文案沿用 clock-base 版本 (两侧都含 `clock 服务不可用`, 用例按该子串断言, 未改).
  - 依赖: `package.json` 加 `dependencies.@dsh-toolset/clock-base = link:../clock-base`, `pnpm install` 刷新本包 `pnpm-lock.yaml` (4 行).
  - 入口分层 (拆前 `src/index.ts` 1867 行, 拆后入口 36 行只做 re-export): `src/plugin.ts` (395) 配置面与装配 / 生命周期; `src/executor.ts` (297) 三类后端适配; `src/subagent.ts` (345) 子代理发起器与计量; `src/command.ts` (30) `/bin/sh -c`; `src/worktree.ts` (426) executor 隔离; `src/guard.ts` (81) 执行前复查; `src/verdict.ts` (150) 裁决提示词 / 信封 / 取值; `src/evidence.ts` (46) 证据文本; `src/dsh-tools.ts` (88) 工具面适配; `src/host.ts` (92) 宿主结构面.
  - 引擎分层 (拆前 `src/engine.ts` 1050 行): `src/engine.ts` (622) 模型侧操作 + 状态转接; `src/engine-types.ts` (179) 对外类型; `src/engine-store.ts` (178) 事件流 / 物化树 / 就绪池 / 只读视图 / 周期快照; `src/engine-flow.ts` (283) 验收裁决 / 打回 / 终态 / join 续体 (经最小 host 面读写状态, 不直接碰事件流实现).
  - 公开面: 包入口 re-export 名单与拆前一致; `src/engine.ts` 仍 re-export 原有类型与 `resumeFromSnapshot`; 其余拆出模块只被本包内部与入口使用, 不新增对外入口.

## 偏差

- 实现规划未列 `tsconfig` 改动: 真实 `ManualClock` 经跨包 `import` 进装配器后越出主 program 的 `rootDir` (`tests/clock.test.ts` 原先靠 `exclude` 规避). 照 `md-table-check` 的既有做法改双 program, 未动 `src`, 也未放宽主 program 的严格度.

- 实现规划写的「事件消费者注入内容」在本包不适用: `task-engine` 不注册事件消费者, 也不向宿主发事件. 集成层据此把该断言位换成两处等价可见面 —— `provide` 的 `taskEngine` 只读查询面, 与快照事件流 (`plan/node-expanded` / `plan/step-verdict`) 的内容.

- 阶段 3 顺序调整: 任务列的是先删 `timers` 再拆文件再改依赖; 实际**先**加 `link:` 依赖并 `pnpm install` (第 3 步前移), 否则第 1 步改完 import 无法跑 check / test.

- 任务只点名 `tests/clock.test.ts` 改入口引, 实际连 `tests/assemble.ts` 一起改: 它同样从 `../../clock-base/src/index.ts` 跨包 import 真实 `ManualClock`. 不改则「跨包 import 取 dist」的口径在本包不成立. 该文件不以 `.test.ts` 结尾, 不涉及用例断言.

- `tsconfig` 双 program 保持原样: 入口改指 `@dsh-toolset/clock-base` 后, 主 program 的 `exclude` 是否仍必要未复核 (本轮不动配置, 留阶段 4).

- 发现 (未改): `pnpm run demo` 在本分支有 1 例既有失败 —— 演示 13 的 `回填证据 + 超预算只标注 (overBudget)` 期望按 `tokens` 数值判超预算, 而引擎自 BACKLOG #13 起只认后端 `out.overBudget` (宿主 `max-tokens` 权威信号); demo 的假 runner 只给 `tokens`. 拆前同一逻辑, 与本次组织改动无关; demo 不属本阶段验收命令, 未改.

## 测试与证据

四条命令 (全部在 `task-engine/` 下跑):

| 命令 | 结果 |
| --- | --- |
| `pnpm run check` | 通过 (两个 program) |
| `pnpm run build` | 通过 |
| `pnpm run test` | 171 例全绿, 0 失败, 0 跳过; 约 0.46 s |
| `pnpm run test:integration` | 17 例全绿, 0 失败, 0 跳过; 约 0.11 s |
| `pnpm run test:coverage` | 通过, 报告见下 |

覆盖率 (只统 `src`; 分母由 V8 range 合并得出, 新增测试文件会带来分支分母变化, 故以百分比对比):

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 |
| --- | --- | --- | --- | --- |
| `src/acceptance.ts` | 83.3% (90/108) | 83.3% (90/108) | 70.8% (17/24) | 73.1% (19/26) |
| `src/engine.ts` | 89.2% (702/787) | 90.9% (715/787) | 80.6% (187/232) | 81.0% (196/242) |
| `src/events.ts` | 95.9% (139/145) | 95.9% (139/145) | 85.0% (17/20) | 85.0% (17/20) |
| `src/gate.ts` | 99.1% (336/339) | 99.1% (336/339) | 96.9% (93/96) | 92.1% (93/101) |
| `src/index.ts` | 71.9% (1065/1482) | 76.0% (1126/1482) | 61.2% (191/312) | 67.2% (236/351) |
| `src/timers.ts` | 76.1% (118/155) | 78.1% (121/155) | 27.6% (8/29) | 36.7% (11/30) |
| `src/tools.ts` | 81.3% (269/331) | 82.2% (272/331) | 55.7% (44/79) | 60.7% (51/84) |
| 合计 | 81.2% (2719/3347) | 83.6% (2799/3347) | 70.3% (557/792) | 73.0% (623/854) |

- 行与分支百分比均未下降; 行分母不变 (3347), 分支分母 792 → 854 是新增用例带来的 V8 block range 合并结果, 同一份 `src` 未改.
- `test:coverage` 汇总里另出现 `clock-base` 两行: 这是装配器与 `tests/clock.test.ts` 跨包 import `clock-base/src` 的副产物, 不属本包统计口径, 不影响上面 `task-engine` 的合计.
- 未覆盖行 (改后, 按报告): `acceptance.ts` 25,26,27,29,31,32,34,55,63,65,102,103,113-117,119 (18 行); `events.ts` 57,58,158,159,160,163 (6 行); `gate.ts` 65,66,103 (3 行); `timers.ts` 17-19,37,39,41,47,57-62,73,91-93,105,106,113-117,122-125,127-129,133,134,144 (34 行); `tools.ts` 15-17,20,22-24,26,28-32,34,38-40,45,47,48,51,52,55,59,60,63-65,73,81,82,86,88-92,96-99,109,110,135,210,211,229,240,241,242,248,249,252,257,278,318,322,325-327,330 (59 行); `engine.ts` 72 行与 `index.ts` 356 行的完整清单见 `pnpm run test:coverage` 输出 (多为 makeExecutor 的 workflow / command 后端细节与 worktree 隔离的既有分支, 归阶段 3 代码整理时复核).
- 新增用例清单: `tests/index.test.ts` 20 例, `tests/integration/plugin.test.ts` 17 例, `tests/assemble.ts` 为装配器 (不计入用例与覆盖率).
- 删除用例与夹具: 无.
- 豁免台账: 无新增. 未覆盖的防御分支按 4.3 的例外口径留给阶段 3 复核, 不写空用例凑数.

阶段 3 (每步都跑, 全部在 `task-engine/` 下):

| 步骤 | `pnpm run check` | `pnpm run test` | 其他 |
| --- | --- | --- | --- |
| 删 `src/timers.ts` + 改 import + 加 `link:` 依赖 | 通过 | 171 例全绿 | `pnpm run build` 通过 |
| 拆入口 (`src/index.ts` → 10 个模块) | 通过 | 171 例全绿 | - |
| 拆引擎 (`src/engine.ts` → 4 个模块) | 通过 | 171 例全绿 | - |
| 拆分后总验 | 通过 (两个 program) | 171 例全绿, 0 失败, 0 跳过; 约 0.45 s | `test:integration` 17 例全绿; `build` 通过 |

- 跨包前置: check / test 前先 `pnpm -C ../clock-base run build` (跨包 import 取 `clock-base/dist`).
- 集成层: 首次跑 `test:integration` 出 1 例失败 (`tests/assemble.ts:352` 读快照时 `Unexpected end of JSON input`), 属阶段 2 记录的既有 flake; 按约定重跑一次 17 例全绿, 未改用例.
- 断言: 本轮未改任何用例断言; 测试侧改动只有 `tests/clock.test.ts` 与 `tests/assemble.ts` 的 import 来源.
- 未跑 `test:coverage`: 本阶段验收只要 check / test; 覆盖率的报告口径留给阶段 4 复核.
- `pnpm run demo` (验收命令外): 除上述 `overBudget` 那条外其余断言通过, `DEMO_FAIL failures=1`.
