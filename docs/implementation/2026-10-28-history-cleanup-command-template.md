# command-template 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 command-template 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `command-template` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 3 个 `.test.ts` (`clock.test.ts` / `subagent.test.ts` / `template.test.ts`); 阶段 1 末 `pnpm -C command-template run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 72.6% (1182/1628); 分支 58.9% (218/370).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C command-template run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-command-template && mkdir -p ../tmp/cov-command-template && NODE_V8_COVERAGE=../tmp/cov-command-template node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-command-template tmp/cov-command-template/report.json
```

- 专项: -.
- 验收: `pnpm -C command-template run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 command-template 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-command-template`, worktree `.worktree/03-code/command-template`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 前置: `clock-base` 已合并, 本分支从含它的 `main` 开.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C command-template run check` 与 `pnpm -C command-template run test`.
- 任务:
  - 删失效导出: `src/steps.ts:276` `declaredModels`、`src/subagent.ts:335` `availableProviders`.
  - 删 `src/timers.ts`; 入口 import 改从 `clock-base` 引; `src/host.ts` 的上下文对象守卫收进入口.
  - `package.json` / `pnpm-lock.yaml` 加 `link:../clock-base`.
- 验收: `pnpm -C command-template run check` 与 `pnpm -C command-template run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(command-template): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

- 分支 `history-cleanup/04-package-docs-command-template`, worktree `.worktree/04-package-docs/command-template`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/DESIGN.md` / `docs/BACKLOG.md` / `templates/adversarial-review.md` / `templates/code-review.md`.
- `README.md`: 现有 9 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- `docs/DESIGN.md`: 归并为四节 `## 背景` / `## 结构` / `## 机制` / `## 取舍`; 只改节名与合并重复, 机制与取舍内容不动.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- `docs/BACKLOG.md`: 同文件的命令与术语同步改; 条目内容、状态与顺序不动.
- `templates/adversarial-review.md` / `templates/code-review.md` 的「评审」改「审阅」.
- 验收: 六节齐 (无配置可省)、四节齐、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(command-template): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

- 单元锚点 (新增 15 条, 存量 33 条不动): 新增 `tests/frontmatter.test.ts` (6 条) 锁定 YAML 子集正向形态 (折叠块 / 字面块 / 引号标量 / 注释 / 嵌套映射 / 步骤 id 缺省 / 块标量空行) 与逐条错误路径 (front-matter 未闭 / 空 steps / id 非法或重复 / 缺 prompt / judge / model 错误 / 缩进与 Tab / 流式集合); 新增 `tests/index.test.ts` (9 条) 覆盖服务面判定分支 (重复注册先撤销 / 撤销抛错 / 命令面缺席或注册抛错降级 / list-get-errors / show 缺 name / reload / 多步摘要 / 注入失败与子代理缺席的错误码 / 未解析占位符告警 / 入口名当参数不递归).
- 集成层: 新增 `tests/assemble.ts` (装配器, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (12 条). 装配器用假命令面 (`ctx.commands` / 只经 `ctx.get` / 缺席)、假服务面 (`subagents` 的 spawn-fork 两种注册形态与缺席, `clock` 定时器统一面, `ctx.provide`, 记录型 `logger`) 拼 `apply`; 另在临时 `DSH_HOME` 下写一个导出 `settleRun` 的假 `@deepseek-ai/dsh-subagent` 包, 让 agent 步骤真走 `importHostModule` 解析, 不连真宿主; 模板目录与 `DSH_HOME` 均落临时目录, 用例结束删除并还原环境变量.
- 集成断言 (canonical 值): 契约符号与 `definitionId` / 命令名 / 描述 / `input.hint`; 服务面键清单与 `SERVICE_FACE_METHODS` 一致且 list-get-errors-reload 转发可用; `list` / `show` 的完整投影文本 (含坏模板清单与预算生效值); prompt 步骤注入消息的 `id`-`role`-`content`-`source` 形状与 `已完成` / `已完成 N 步（a → b）` 结果文本; agent 步骤经服务面 `start` 的 `label` / `prompt` / `signal` / `parent` / `agentOptions` (模板级模型继承与步骤级覆盖) 与 spawn 优先、fork 兜底; bestOf 的候选数与裁判提示词全文、候选与裁判各自的模型覆盖; reload 重新注册 (旧命令撤销计数); 命令面 / 服务面缺席与 `disabled` 降级; clock 缺席只告警一次且 logger 缺席时落 stderr; 子代理服务或宿主模块缺席时的 canonical 错误文案; `reservedNames` 收窄后同名模板不可调用但仍可 `show`.
- 脚本: `command-template/package.json` 加 `test:integration` (`node --experimental-transform-types --test 'tests/integration/*.test.ts'`) 与 `test:coverage` (`NODE_V8_COVERAGE=../tmp/cov-command-template` 跑单元加集成两层, 再 `dev/coverage/report.mjs tmp/cov-command-template tmp/cov-command-template/report.json`).
- 覆盖率: 行 72.6% (1182/1628) → 84.6% (1378/1628); 分支 218/370 (58.9%) → 350/476 (73.5%) (分母变大, 见「测试与证据」的分母说明); 逐文件表见下节.
- 未改动: `src` 未改 (无「为可测性改 src」的偏差); `tests/clock.test.ts` 直取 `clock-base/src/timers.ts` 的跨包内部 import 未收口, 归总追踪 4.2 / 5.3 统一处理; `tests/` 存量 33 条用例的断言与标题未改.
- 不可达分支 (4.3 豁免, 用例旁未写 skip): `frontmatter.ts` 的 `collectSequence` 中 `- ` 空项嵌套块 (第 341-369 行) 与嵌套序列 (第 350-364 行) 不可达——序列行先经 `stripComment` 去掉行尾空白, `"- "` 必然变成 `"-"`, 分支入口 `text.startsWith("- ")` 不成立, 故整段走不到; `types.ts` 等纯类型行也被工具计入未覆盖行, 同属不可达.
- 分层贡献 (4.3 的两轮跑取差): 单元层 48 条, 集成层 12 条; 只跑单元 vs 单元加集成的差值即集成层贡献 (行 72.6% → 84.6%). 集成层主要补 `host.ts` 的宿主模块解析 (`importHostModule` 让该文件从 24/48 升到 40/48)、`index.ts` 的 `apply` 与命令 handler 全链路 (231/339 → 318/339) 与 `subagent.ts` 的模块加载与结算 (212/278 → 223/278).
- 交付清单: 新增 `tests/frontmatter.test.ts` / `tests/index.test.ts` / `tests/assemble.ts` / `tests/integration/plugin.test.ts`; 删除 0 条用例与 0 个夹具.

### 阶段 3 代码整理（分支 `history-cleanup/03-code-command-template`）

- 删失效导出: `declaredModels` (`src/steps.ts:276`, 9 行) 与 `availableProviders` (`src/subagent.ts:335`, 10 行). 删前重扫全仓 (`src` / `tests` / `scripts` / `docs`), 除总追踪与本文件的待删清单外零引用; 连带删 `src/steps.ts` 的 `ModelRef` 类型 import.
- 删 `src/timers.ts` (本地副本 205 行): `src/index.ts` 的 `createDeadline` / `resolveClock` 与类型 `ClockTimers` / `Deadline`、`src/subagent.ts` 的类型 `Deadline`、`tests/clock.test.ts` 的 `createDeadline` / `ManualClock` / `resolveClock` 一并改从 `@dsh-toolset/clock-base` 入口引; 不再引 `../../clock-base/src/timers.ts`.
- 上下文对象守卫: 入口 `apply` 判一次 (非对象按空上下文 `{}` 处理, 之前 `ctx` 为 `null` 时会在读 `provide` 处抛); `src/host.ts` 的 `readService` 是宿主服务读取的唯一入口, 对象判断只此一处; 下游 (`CommandTemplateService.#ctx` / `runOneShotAgent` 收到的 ctx) 不再重复判.
- `package.json` 加 `dependencies.@dsh-toolset/clock-base = link:../clock-base`, 本包目录 `pnpm install` 更新 `pnpm-lock.yaml` (importer 加 dependencies 一项, 并建 `node_modules/@dsh-toolset/clock-base -> ../clock-base`).
- 告警文案: `clock` 缺席的告警由本包持有 (`src/index.ts` 的 `CLOCK_MISSING_WARNING`), `resolveClock` 只负责探测与回落; 文案与告警一次的口径不变.
- 行为不变: 工具名 / 命令名 / 参数面 / `output.render` 投影 / 配置键 / 注入文案 / 降级路径 / 告警文案都未动; 48 条单元与 12 条集成用例的断言与标题未改.
- 交付清单: 删 1 个文件 (`src/timers.ts`) 与 2 个导出; 新增 0 个文件.

## 偏差

无 (`src` 未改动, 未新增依赖). 以上为阶段 2 记录; 阶段 3 的偏差如下.

- `clock-base` 的 `resolveClock` 告警文案用半角标点 (「, 回落进程内定时器…; 本条…」), 与本包原口径 (「，…；」) 不同 (`clock-base` 收拢时按现行标点规范改写). 为守住「用例断言不改」与「文案不动」(`tests/integration/plugin.test.ts:463` 精确断言全文), 告警文案留在本包入口作常量, `clock-base` 只负责探测与回落; 未保留副本, 也未写兼容分支.
- 跨包 import 走包名 (解析到 `clock-base/dist/`), 故 `check` / `test` 前须先 `pnpm -C ../clock-base run build`; 与实现规划的前置要求一致, 代价是本包测试多一条构建前置.
- `tsconfig.json` 的 `exclude: ["tests/clock.test.ts"]` 保持原样未动 (改入口 import 后本已可纳入 `include`, 实测 `check` 也通过, 但不属实现规划列出的文件, 留阶段 4 或后续条目评估). 后续: 2026-11-01 补丁轮已删该 `exclude` (`tsconfig.json` 现只有 `include: ["src", "tests"]`, 提交 `25fce711`), `check` 通过, 此项关闭.
- `command-template/docs/DESIGN.md:46` 仍提到 `availableProviders(ctx)`; 包文档按实现规划留到阶段 4 补, 本次未动.

## 测试与证据

四条入口实跑 (分支 `history-cleanup/02-tests-command-template`, Node 24.16.0):

| 命令 | 结果 |
| --- | --- |
| `pnpm -C command-template run check` | 通过 (`tsc --noEmit`, 0 错) |
| `pnpm -C command-template run test` | 48 条全过 (存量 33 + 新增 15), `fail 0` / `skipped 0` / `todo 0` |
| `pnpm -C command-template run test:integration` | 12 条全过, `fail 0` / `skipped 0` / `todo 0` |
| `pnpm -C command-template run test:coverage` | 见下表, 全绿 |

覆盖率逐文件对照 (行 / 分支, 改前 = 只跑单元层, 改后 = 单元加集成):

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 |
| --- | --- | --- | --- | --- |
| `src/args.ts` | 56/56 | 56/56 | 17/17 | 17/17 |
| `src/frontmatter.ts` | 290/442 | 361/442 | 86/138 | 145/180 |
| `src/host.ts` | 24/48 | 40/48 | 0/7 | 9/17 |
| `src/index.ts` | 231/339 | 318/339 | 27/58 | 71/87 |
| `src/registry.ts` | 59/72 | 59/72 | 6/12 | 7/13 |
| `src/steps.ts` | 203/238 | 206/238 | 39/52 | 43/60 |
| `src/subagent.ts` | 212/278 | 223/278 | 35/63 | 48/73 |
| `src/timers.ts` | 107/155 | 115/155 | 8/23 | 10/29 |
| 合计 | 1182/1628 (72.6%) | 1378/1628 (84.6%) | 218/370 (58.9%) | 350/476 (73.5%) |

分支覆盖分母说明: 370 → 476 不是新增分支, 而是 V8 按需编译——改前未被任何用例调用的函数不产出块区间, 新增用例把 `apply` / 命令 handler / 宿主模块解析等函数拉进执行面后这些区间才出现; 已覆盖分支数 218 → 350 同步上升, 无下降文件.

未覆盖行 (改后, 工具口径): `frontmatter.ts` 119-123, 137, 177-178, 185-186, 188-192, 196-199, 218, 220-222, 224-225, 249, 251-252, 256-259, 262, 290-292, 295, 299-304, 321, 323-326, 334-335, 338-340, 342-365, 400, 441, 455, 475; `host.ts` 13, 19, 26, 37-39, 58-59; `index.ts` 75-77, 80, 95-96, 203, 208, 213-216, 222-223, 234, 236, 264, 359, 361-363; `registry.ts` 11-14, 24, 28, 33, 39, 61-62, 77-79; `steps.ts` 90, 115, 132, 135, 145-147, 160-169, 197, 205-207, 253, 257-266; `subagent.ts` 59-62, 87, 115, 120, 127-128, 131-132, 183-184, 190-192, 213, 235-236, 244, 246, 257, 260-274, 277-278, 283-298; `timers.ts` 16-19, 31-34, 37, 39, 41, 47, 57-60, 73, 91-93, 105-106, 113-117, 122-125, 127-129, 133-134, 144, 157-159. 其中纯类型行、上述不可达分支与「需要真实宿主 / 真机」的路径 (`importHostModule` 的解析失败重试分支、`availableProviders` 一类诊断函数) 按 4.3 / 4.5 豁免, 真机面留 `scripts/install.sh --sync` 后人工验收.

### 阶段 3 代码整理实跑

前置: `pnpm -C ../clock-base run build` (产出 `dist/`, 供包名 import 解析); 本包目录 `pnpm install` (建 `node_modules/@dsh-toolset/clock-base -> ../clock-base` 并更新 `pnpm-lock.yaml`).

| 命令 | 结果 |
| --- | --- |
| `pnpm -C command-template run check` | 通过 (`tsc --noEmit`, 无输出) |
| `pnpm -C command-template run test` | 48 例, pass 48, fail 0, skipped 0, todo 0 |
| `pnpm -C command-template run test:integration` | 12 例, pass 12, fail 0, skipped 0, todo 0 |
| `pnpm -C command-template run build` | 通过 (`tsc -p tsconfig.json`) |

改动量: 删 `src/timers.ts` 205 行、`declaredModels` 9 行、`availableProviders` 10 行; 改 5 个文件 (`src/index.ts` / `src/steps.ts` / `src/subagent.ts` / `tests/clock.test.ts` / `package.json`) 与 `pnpm-lock.yaml`, 合计 +27 / -33 行 (不含删除的 205 行). 用例数不变 (单元 48, 集成 12), 断言未改.
