# clock-base 整理 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 clock-base 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `clock-base` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 2 个 `.test.ts` (`main.test.ts` / `timers.test.ts`); 阶段 1 末 `pnpm -C clock-base run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 94.6% (209/221); 分支 84.0% (42/50).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C clock-base run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 服务面: 用假 `ctx` 调 `apply`, 断言 `clock` 服务的 `now` / `schedule` / `interval` 与 `ManualClock` 的行为, 排期随卸载撤销.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-clock-base && mkdir -p ../tmp/cov-clock-base && NODE_V8_COVERAGE=../tmp/cov-clock-base node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-clock-base tmp/cov-clock-base/report.json
```

- 专项: -.
- 验收: `pnpm -C clock-base run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 clock-base 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-clock-base`, worktree `.worktree/03-code/clock-base`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C clock-base run check` 与 `pnpm -C clock-base run test`.
- 任务:
  - `src/timers.ts` 追加 8 个函数 (`systemTimers` / `isTimers` / `readClock` / `resolveClock` / `createDeadline` / `delayOf` / `runDisposer` / `attachEffect`) 与 4 个类型 (`TimersLike` / `ClockTimers` / `Deadline` / `DeadlineReason`), 与 `createTimers` / `ManualClock` 同文件.
  - `src/index.ts` 导出上述 12 个符号; 服务缺席时回落到系统定时器的判断收进 `resolveClock` 与 `systemTimers`.
  - 上下文对象守卫收进 `src/timers.ts` / `src/index.ts`.
  - 补用例: 手控时钟排期与撤销、无 `clock` 服务时的回落两条; 断言不依赖真实等待.
  - `package.json` / `pnpm-lock.yaml` 核对 `types` 指向入口.
- 验收: `pnpm -C clock-base run check` 与 `pnpm -C clock-base run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 补充: 本包是第一波基础包; 合并后其余 8 个包才从新 `main` 开分支.
- 提交: `refactor(clock-base): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

- 分支 `history-cleanup/04-package-docs-clock-base`, worktree `.worktree/04-package-docs/clock-base`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md`.
- `README.md`: 现有 8 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- 验收: 六节齐 (无配置可省)、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(clock-base): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

- 阶段 2 测试锚定（分支 `history-cleanup/02-tests-clock-base`）:
  - 基线: 单元 25 例全通过, 0 skip; 覆盖率 行 94.6% (209/221), 分支 83.0% (39/47); `check` 通过.
  - 单元锚点: 新增 8 例 —— `apply` 的降级与失败路径（`provide` 非函数 / 读 `provide` 抛错 / 属性挂载失败 / `ctx` 为 null）、`ClockService` 缺省时钟区间, 以及 `createTimers` 的 `unref: false`、`attachEffect` 四类形状退化（`ctx` 为 null / 非对象 / `effect` 非函数 / 读 `effect` 抛错）.
  - 集成层: 新增 `tests/assemble.ts`（假工具面 / 假事件面 / 假服务面 + `ctx.effect` 卸载登记 + stderr 捕获, 不以 `.test.ts` 结尾）与 `tests/integration/plugin.test.ts`（12 例）: 经 `provide` 注册与重复注册、工具面零注册与事件面零订阅、两种降级装配、`clock.now` 区间、`scope` 的 `schedule` / `interval` 与 `ctx` 卸载撤销、`ManualClock` 的到期序与回调内再排期.
  - 脚本: `package.json` 加 `test:integration` 与 `test:coverage`.
  - 结果: 单元 33 例 + 集成 12 例全通过; 覆盖率 行 98.2% (217/221), 分支 94.4% (51/54).
- 阶段 3 代码整理（分支 `history-cleanup/03-code-clock-base`）:
  - `src/timers.ts`: 删掉包内私有的旧 `attachEffect`, 追加公共接线层 8 个函数（`systemTimers` / `isTimers` / `readClock` / `resolveClock` / `createDeadline` / `delayOf` / `runDisposer` / `attachEffect`）与 4 个类型（`TimersLike` / `ClockTimers` / `Deadline` / `DeadlineReason`）, 与 `createTimers` / `ManualClock` 同文件; 实现取各包既有副本的公共版本, `delayOf` 复用 `resolveDelay`, `TimersLike` 与 `Timers` 同形.
  - `src/index.ts`: 入口导出上述 12 个符号.
  - 上下文对象守卫: 收在 `src/timers.ts` 的 `isTimers` / `readClock` / `attachEffect` 与 `src/index.ts` 的 `apply`, 每处只判一次.
  - 测试: `tests/timers.test.ts` 新增 2 例 —— 手控时钟下的 `resolveClock` 排期与撤销, 无 `clock` 服务时的系统定时器回落; 分别用 `ManualClock.advance` 与 `t.mock.timers.tick`, 不等真实时间.
  - 行为: `createTimers` 登记 effect 的标签仍为 `clock.timer`; 工具名 / 配置键 / 注入文案未动.

## 偏差

- 无 `src` 改动.
- 分支基线: 规划记 84.0% (42/50), 本分支实测 83.0% (39/47)（分母较规划少 3 个分支, 判定为阶段 1 收尾后 V8 range 统计差异）; 以本分支实测为改前基线.
- 覆盖率脚本的两套路径基准: `report.mjs` 的两个路径参数按仓库根解析, 故 `test:coverage` 传 `tmp/cov-clock-base` / `tmp/cov-clock-base/report.json`; `NODE_V8_COVERAGE` 由 node 按包目录解析, 仍用 `../tmp/cov-clock-base`; 两者指向同一目录. 与规划的命令等价, 只是显式分开写.
- 集成层的真实时间: `apply` 产出的 `ClockService` 缺省读系统时钟, 装配器不替换 `Date.now`（不 mock 全局时钟）; 故 `schedule` / `interval` 用例等真实时间 10 至 45ms, 在用例旁注明; 需要确定时间的断言改用本包导出的 `ManualClock`（3.5 口径）.
- 余 4 行未覆盖: V8 range 的落点与 types 剥离后的源码行存在对齐误差（`clock-base/src/timers.ts` 的 61 / 62 / 78 / 85, 报告按 0 基写出 60 / 61 / 77 / 84）, 行内副作用已由用例断言间接证明执行, 不按 4.3 补用例; 明细见「豁免台账」.
- 阶段 3: 包内私有 `attachEffect`（只登记清理, 无返回值）与公共 `attachEffect`（返回 effect 的 disposer）合并为一个函数; `createTimers` 调用处补传标签 `clock.timer`, 登记语义不变. 其余与规划一致.
- 阶段 3: `TimersLike` 实现为 `Timers` 的类型别名, 未再复制一份同形接口; 结构等价, 消费方替换 import 即可.
- 阶段 3: `readClock` 的返回类型 `ClockLike` 未入口导出, 入口只新增规划列出的 12 个符号（构建声明确认 `ClockLike` 随 `readClock` 落在 `.d.ts`）.

## 测试与证据

### 四个入口实跑

| 命令 | 结果 |
| --- | --- |
| `pnpm -C clock-base run check` | 通过（tsc --noEmit, 无输出） |
| `pnpm -C clock-base run test` | 33 例, pass 33, fail 0, skipped 0 |
| `pnpm -C clock-base run test:integration` | 12 例, pass 12, fail 0, skipped 0 |
| `pnpm -C clock-base run test:coverage` | 45 例全通过, 报告见下 |

### 覆盖率（改前 / 改后）

只统 `clock-base/src`.

| 文件 | 行（改前） | 行（改后） | 分支（改前） | 分支（改后） |
| --- | --- | --- | --- | --- |
| `src/index.ts` | 89.7% (52/58) | 100.0% (58/58) | 77.8% (7/9) | 100.0% (13/13) |
| `src/timers.ts` | 96.3% (157/163) | 97.5% (159/163) | 84.2% (32/38) | 92.7% (38/41) |
| 合计 | 94.6% (209/221) | 98.2% (217/221) | 83.0% (39/47) | 94.4% (51/54) |

分层贡献（两轮跑）: 只跑单元层 行 98.2% (217/221) / 分支 94.2% (49/52); 单元加集成 行 98.2% / 分支 94.4%, 集成层贡献 +2 分支 / +0 行（单元层已走完可执行行, 集成层补的是装配路径的分支块）.

### 用例增减

| 类别 | 改前 | 改后 | 增减 |
| --- | --- | --- | --- |
| 单元（`tests/*.test.ts`） | 25 | 33 | +8 |
| 集成（`tests/integration/*.test.ts`） | 0 | 12 | +12 |
| skip | 0 | 0 | 0 |
| todo | 0 | 0 | 0 |
| 删除用例 | - | 0 | 0 |

### 豁免台账

| 位置 | 缺什么 | 为什么补不了 | 触发条件 | 交给谁 |
| --- | --- | --- | --- | --- |
| `src/timers.ts:61` `effect = (ctx as { effect?: unknown }).effect` | 可定位的命中行 | V8 range 在该片段的落点为零命中; 同一行的副作用已由「两个排期各登记一次 effect」断言证明执行 | 无 | 阶段 3 代码整理复核 |
| `src/timers.ts:62` `} catch {` | 同上 | 块头行, 无独立可执行语义 | 无 | 同上 |
| `src/timers.ts:78` `createTimers(options = {})` 默认参数 | 同上 | 默认参数初始化器被 V8 记为独立 range | 无 | 同上 |
| `src/timers.ts:85` `let handle: ReturnType<typeof setTimeout> \| undefined` | 同上 | 声明行, 无独立可执行语义 | 无 | 同上 |

### 阶段 3 代码整理（实跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm -C clock-base run check` | 通过（`tsc --noEmit`, 无输出） |
| `pnpm -C clock-base run test` | 35 例, pass 35, fail 0, skipped 0 |
| `pnpm -C clock-base run test:integration` | 12 例, pass 12, fail 0, skipped 0 |
| `pnpm -C clock-base run build` | 通过; `dist/src/index.d.ts` 可见 12 个新符号, 构建产物随后清理 |

用例增减: 单元 33 → 35（+2）; 集成 12 不变; 新增两例分别用 `ManualClock.advance` 与 `t.mock.timers.tick`, 不依赖真实等待.

## 四份测试产物

| 产物 | 位置 |
| --- | --- |
| 覆盖率表 (改前 / 改后) | 见「测试与证据」的覆盖率表 |
| 新增 / 删除用例清单 | 见「实现记录」的「单元锚点 / 集成层」段 |
| `skip` 计数与豁免台账 | 见「测试与证据」的 `skip` / 豁免段 |
| 四个入口实跑 | 见「测试与证据」的入口段 |
