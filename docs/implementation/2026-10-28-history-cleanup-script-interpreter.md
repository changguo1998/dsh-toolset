# script-interpreter 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 script-interpreter 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `script-interpreter` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 6 个 `.test.ts` (`clock.test.ts` / `index.test.ts` / `probe.test.ts` / `run.test.ts` / `sandbox.test.ts` / `tool.test.ts`); 阶段 1 末 `pnpm -C script-interpreter run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 91.1% (1485/1630); 分支 77.7% (317/408).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C script-interpreter run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-script-interpreter && mkdir -p ../tmp/cov-script-interpreter && NODE_V8_COVERAGE=../tmp/cov-script-interpreter node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-script-interpreter tmp/cov-script-interpreter/report.json
```

- 专项: -.
- 验收: `pnpm -C script-interpreter run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 script-interpreter 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-script-interpreter`, worktree `.worktree/03-code/script-interpreter`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 前置: `clock-base` / `herdr-use` 已合并, 本分支从含它的 `main` 开.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C script-interpreter run check` 与 `pnpm -C script-interpreter run test`.
- 任务:
  - 删 `src/timers.ts`; 入口 import 改从 `clock-base` 引.
  - `src/types.ts:14` 的沙箱模式枚举删本地副本, 改引 `herdr-use` 的枚举.
  - `package.json` / `pnpm-lock.yaml` 加 `link:../clock-base` 与 `link:../herdr-use`.
- 验收: `pnpm -C script-interpreter run check` 与 `pnpm -C script-interpreter run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(script-interpreter): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

- 分支 `history-cleanup/04-package-docs-script-interpreter`, worktree `.worktree/04-package-docs/script-interpreter`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/BACKLOG.md`.
- `README.md`: 现有 11 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- `docs/BACKLOG.md`: 同文件的命令与术语同步改; 条目内容、状态与顺序不动.
- 验收: 六节齐 (无配置可省)、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(script-interpreter): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

- 集成层: 新增 `tests/assemble.ts` (假工具面 / 假事件面 / 假服务面拼 `apply`, `ctx.get` 受保护读取 + `expose: "property"` 回落, 临时工作区与 `cleanup()`, `captureStderr`) 与 `tests/integration/plugin.test.ts` (14 条): 工具注册名 / 参数面 / 语言枚举, canonical 值 (成功 / 非零退出 / 超时), `output.render` 投影, 相对 workdir 与 `spillPrefix` 路径守卫, 参数校验 / 未启用语言 / 解释器缺失 / 围栏失败 / 审批拒绝的失败路径, 服务全缺与 `ctx.tools` 缺失的降级, 无事件消费者 (不订阅) 与日志回落.
- 单元锚点 (存量文件追加, 不改旧断言): `tests/index.test.ts` +4 (非数组 `languages`、小数钳位、`spillPrefix` 反斜杠与开头点横线净化、显式语言缺解释器的日志与探测痕迹、sh 不做版本探测); `tests/probe.test.ts` +4 (`resolveUvPython` 失败三态与空行跳过、`readVersion` 起不来 / stderr 版本、`.venv/bin/python3` 候选、uv 解析失败痕迹); `tests/run.test.ts` +4 (空 argv、调用前已取消的 signal、`maxOutputChars < 1`、落盘失败只丢路径); `tests/clock.test.ts` +5 (ctx 缺失 / 无 get / get 或 scope 抛错 / 形状不符的回落, `systemTimers` 延迟归一与 interval 撤销, deadline 取消幂等, effect 抛错 / 非函数, disposer 返回 Promise); `tests/sandbox.test.ts` +1 (空签名过滤与空行剔除); 新增 `tests/render.test.ts` 5 条 (两条流拼接、截断提示、标记顺序、失败值 / 畸形值全函数口径).
- 脚本: `package.json` 加 `test:integration` 与 `test:coverage` (后者按包文档命令, `report.mjs` 参数用 `tmp/cov-script-interpreter`).
- `src` 未改.

### 阶段 3 代码整理

- 删 `src/timers.ts` 整份本地副本 (205 行); `src/index.ts` (`createDeadline` / `resolveClock`), `src/run.ts` 与 `src/tools.ts` (`Deadline` 类型), `tests/clock.test.ts` (`ManualClock` / `createDeadline` / `resolveClock` / `systemTimers`) 的 timer 族 import 全改从 `@dsh-toolset/clock-base` 入口引.
- `src/types.ts` 的沙箱模式枚举删本地副本, 改从 `herdr-use` 的 `src/types.ts` 作类型级 import 并以原名 `SandboxMode` re-export (导出名与形状不变, `src/index.ts` 的注出未动).
- `package.json` 的 `dependencies` 加 `@dsh-toolset/clock-base` 与 `@dsh-toolset/herdr-use` (均 `link:`); 本包 `pnpm install` 生成软链并更新 `pnpm-lock.yaml` 的 importer.
- 落地顺序: 改 `package.json` → 本包 `pnpm install` → `pnpm -C ../clock-base run build` 与 `pnpm -C ../herdr-use run build` (两包入口指向 `dist/`, 未构建则类型与运行时都解析不到) → 改 import 与删副本 → `check` / `test`.
- 行为面未动: 两包入口的 `createDeadline` / `systemTimers` 与原副本逐字同实现; `resolveClock` 只差告警文案的标点 (随 `clock-base` 的英文标点口径, 本包无用例断言整句, 只断言 `clock 服务不可用` 子串). 工具名 / 参数面 / `output.render` 投影 / 配置键 / 注入文案不变.
- 收尾 (沙箱类型改从入口引): 本分支 `git rebase main` 取到 `herdr-use` 入口新导出的 `SandboxMode` 后, `src/types.ts` 的 `import type` 由声明模块深路径 `@dsh-toolset/herdr-use/dist/src/types.js` 改回包入口 `@dsh-toolset/herdr-use`; 别名 `HerdrSandboxMode` 与 `SandboxMode` 的 re-export 形状、导出名均不变, 该处注释同步改为「入口已导出」. 行为与产物面不变, 编译产物 `dist/src/types.d.ts` 只余包名引用.

## 偏差

1. (已解决) `herdr-use` 的包入口 (`src/index.ts`) 原未导出 `SandboxMode` (与其追踪文档「偏差 5」同一现状), 本包又不改他包源码, 当时按声明模块 `@dsh-toolset/herdr-use/dist/src/types.js` 作类型级 import. 现 `herdr-use` 入口已补 `export type { SandboxMode }` 并合并到 `main`, 本包 rebase 后已改回按包名从入口 import, dist 深路径已去掉; 枚举仍只有 `herdr-use/src/types.ts` 一处定义.
2. `tsconfig.json` 的 `exclude: ["tests/clock.test.ts"]` 保持不变: 纳入类型检查会暴露既有的 `assert.deepEqual(fired, [])` 断言收窄 (`@types/node` 的 `asserts actual is T` 把 `fired` 推成 `never[]`), 修它须改用 `deepStrictEqual` 或显式泛型, 超出「用例断言不改」; 已在 `tests/clock.test.ts` 头注释写明原因.
3. 规划要求开工先 `pnpm install --frozen-lockfile`, 按实际改为新增依赖后做一次普通 `pnpm install` (`--frozen-lockfile` 会因 lockfile 需变更而失败, 与 `herdr-use` 同例).
4. 规划只点名 `src/index.ts` 与「其它文件」的 timer import; 本轮按同一口径把 `tests/clock.test.ts` 的两处 import (`../src/timers.ts`、`../../clock-base/src/timers.ts`) 也改成包入口, 不再跨包引内部模块.

## 测试与证据

### 入口实跑

| 命令 | 结果 |
| --- | --- |
| `pnpm -C script-interpreter run check` | `tsc -p tsconfig.json --noEmit` 通过 (exit 0) |
| `pnpm -C script-interpreter run test` | tests 117 / pass 117 / fail 0 / skipped 0 / todo 0 |
| `pnpm -C script-interpreter run test:integration` | tests 14 / pass 14 / fail 0 / skipped 0 / todo 0 |
| `pnpm -C script-interpreter run test:coverage` | tests 131 / pass 131 / fail 0 / skipped 0; 本包行 95.1% (1550/1630), 分支 86.9% (398/458) |

- 新增用例: 单元 23 条, 集成 14 条; 删除用例 0 条, 夹具 0 个.
- `skip`: 本机 0 条; 集成层按 4.4 对 sh 解释器做条件式 skip (`shInfo() === null` 时 skip 并注明缺 sh), 本机触发 0 条.

### 覆盖率 (改前 → 改后, 只统 `src`)

| 文件 | 改前行 | 改前分支 | 改后行 | 改后分支 | 改后未覆盖行 |
| --- | --- | --- | --- | --- | --- |
| `src/index.ts` | 95.1% (291/306) | 86.6% (58/67) | 99.0% (303/306) | 95.9% (71/74) | 46,47,225 |
| `src/probe.ts` | 89.2% (141/158) | 79.1% (53/67) | 96.2% (152/158) | 89.0% (65/73) | 44,101,104,114,203,204 |
| `src/render.ts` | 91.5% (75/82) | 86.2% (25/29) | 100.0% (82/82) | 100.0% (39/39) | - |
| `src/run.ts` | 86.5% (268/310) | 69.2% (36/52) | 90.0% (279/310) | 79.7% (47/59) | 77,90,91,98,99,114,132,145,169,170,225-234,256,260-263,266-273,284,285 |
| `src/sandbox.ts` | 97.6% (124/127) | 90.0% (36/40) | 97.6% (124/127) | 86.0% (37/43) | 39,80,81 |
| `src/timers.ts` | 77.4% (120/155) | 37.5% (12/32) | 92.9% (144/155) | 83.3% (40/48) | 47,59,115-117,123,124,127-129,144 |
| `src/tools.ts` | 94.0% (406/432) | 80.2% (97/121) | 94.0% (406/432) | 81.1% (99/122) | 56-58,79,80,140,141,157,158,173-175,179,230,231,294,324,325,335,344-346,370,420,426,441 |
| `src/langs/*.ts` | 100.0% | n/a | 100.0% | n/a | - |
| `src/types.ts` | 100.0% (6/6) | n/a | 100.0% (6/6) | n/a | - |
| 本包合计 | 91.1% (1485/1630) | 77.7% (317/408) | 95.1% (1550/1630) | 86.9% (398/458) | - |

- 口径说明: `src/sandbox.ts` 的分支比例从 90.0% 降到 86.0%, 原因是集成层经 `src/index.ts` 也加载同一文件, 合并后的 block 分母 40 → 43 而命中只 +1; 行覆盖不变, 本包整体行 / 分支均上升, 不构成退化.
- 未覆盖行集中在类型 / 接口声明与闭包归因行, 以及 4.3 允许豁免的防御分支 (如 `index.ts:46,47` 的 `BundleHost` 接口、`run.ts` 的 `StreamCapture` 私有字段声明).

### 阶段 3 代码整理

| 命令 | 结果 |
| --- | --- |
| `pnpm -C clock-base run build` | 通过 (exit 0; 本包跨包依赖的前置) |
| `pnpm -C herdr-use run build` | 通过 (exit 0; 同上) |
| `pnpm -C script-interpreter run check` | `tsc -p tsconfig.json --noEmit` 通过 (exit 0) |
| `pnpm -C script-interpreter run test` | tests 117 / pass 117 / fail 0 / skipped 0 / todo 0 (与改前同数, 断言未改) |
| `pnpm -C script-interpreter run test:integration` | tests 14 / pass 14 / fail 0 / skipped 0 / todo 0 |
| `pnpm -C script-interpreter run build` | 通过 (exit 0; 产物 `dist/src/index.js` 从 `@dsh-toolset/clock-base` 裸引用, 类型声明里的 `SandboxMode` 为 herdr-use 声明模块的类型级引用) |

- 改动规模: 删除 205 行 (`src/timers.ts` 整份), 合计新增 32 行 / 删除 214 行 (含 lockfile、import 换行与被替换的枚举行).
- 未验证: 宿主 profile 装配实测 (`scripts/install.sh` 与真机 `dsh --profile fff-test`) 不在本轮门禁内, 留阶段收尾.

### 阶段 3 收尾 (沙箱类型改从入口引)

| 命令 | 结果 |
| --- | --- |
| `git rebase main` | 成功 (`main` 已含 `herdr-use` 入口导出 `SandboxMode` 的合并 `d8312816`) |
| `pnpm -C <worktree>/clock-base run build` | 通过 (exit 0) |
| `pnpm -C <worktree>/herdr-use run build` | 通过 (exit 0; 入口 `dist/src/index.d.ts` 已带 `SandboxMode` 类型导出) |
| `pnpm -C script-interpreter run check` | `tsc -p tsconfig.json --noEmit` 通过 (exit 0) |
| `pnpm -C script-interpreter run test` | tests 117 / pass 117 / fail 0 / cancelled 0 / skipped 0 / todo 0 |
| `pnpm -C script-interpreter run test:integration` | tests 14 / pass 14 / fail 0 / cancelled 0 / skipped 0 / todo 0 |
| `pnpm -C script-interpreter run build` | 通过 (exit 0; `dist/src/types.d.ts` 只余 `from "@dsh-toolset/herdr-use"` 入口引用) |

- 改动规模: 2 个文件, 新增 3 行 / 删除 3 行 (`src/types.ts` 的 import 与注释各一处) 加本文件.
- 用例断言、导出名与运行时行为均未改, 测试数与改前同数.

## 四份测试产物

| 产物 | 位置 |
| --- | --- |
| 覆盖率表 (改前 / 改后) | 见「测试与证据」的覆盖率表 |
| 新增 / 删除用例清单 | 见「实现记录」的「单元锚点 / 集成层」段 |
| `skip` 计数与豁免台账 | 见「测试与证据」的 `skip` / 豁免段 |
| 四个入口实跑 | 见「测试与证据」的入口段 |
