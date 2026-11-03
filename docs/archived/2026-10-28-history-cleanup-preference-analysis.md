# preference-analysis 整理 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 preference-analysis 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `preference-analysis` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 7 个 `.test.ts` (`apply.test.ts` / `e2e.test.ts` / `induce.test.ts` / `ledger.test.ts` / `main.test.ts` / `observe.test.ts` / `tools.test.ts`); 阶段 1 末 `pnpm -C preference-analysis run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 87.1% (1770/2032); 分支 75.5% (372/493).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C preference-analysis run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-preference-analysis && mkdir -p ../tmp/cov-preference-analysis && NODE_V8_COVERAGE=../tmp/cov-preference-analysis node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-preference-analysis tmp/cov-preference-analysis/report.json
```

- 专项: -.
- 验收: `pnpm -C preference-analysis run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 preference-analysis 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-preference-analysis`, worktree `.worktree/03-code/preference-analysis`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C preference-analysis run check` 与 `pnpm -C preference-analysis run test`.
- 任务:
  - `src/main.ts` 的上下文对象守卫收进入口, 只判一次.
  - `src/tools.ts:97` 的「三个工具」按实际去数字.
- 验收: `pnpm -C preference-analysis run check` 与 `pnpm -C preference-analysis run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(preference-analysis): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

- 分支 `history-cleanup/04-package-docs-preference-analysis`, worktree `.worktree/04-package-docs/preference-analysis`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/DESIGN.md` / `docs/BACKLOG.md`.
- `README.md`: 现有 12 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- `docs/DESIGN.md`: 归并为四节 `## 背景` / `## 结构` / `## 机制` / `## 取舍`; 只改节名与合并重复, 机制与取舍内容不动.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- `docs/BACKLOG.md`: 同文件的命令与术语同步改; 条目内容、状态与顺序不动.
- 验收: 六节齐 (无配置可省)、四节齐、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(preference-analysis): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

- 基线 (分支起点): `pnpm -C preference-analysis run test` 68 通过 / 0 失败; `check` 通过; 覆盖率行 87.1% (1770/2032), 分支 75.5% (372/493).
- 单元锚点 (+30 条, 68 -> 98): 按 4.4 只补现有用例没走到的分支与错误路径, 现有断言未改语义.
  - `tests/main.test.ts`: 未成形观察只记账与 `dispose` 后零报告 / `api.add` 空正文与无法归一化及标题项目缺省与撤销后拒重登记 / `api.list` 倒序与 `limit` 截断 / memory 缺席时 `add` 与 `remove` 的拒绝 / `autoApply: all` 的候选档写库 / 退休删行失败保状态 / `ctx.on` 缺失与 `tools.register` 抛错的告警 / `DSH_HOME` 派生 / 待归纳观测 2000 条上限.
  - `tests/apply.test.ts`: `applyEntry` 的 skipped 与抛错, `applyExplicit` 的隐私拦截与 skipped 与抛错, `retireEntry` 的 forget 抛错, `createMemoryPort` 的隐私闸崩溃与可写层不一致与注册抛错, 注入排序的同等重要度回退.
  - `tests/ledger.test.ts`: 未载入时的 `snapshot` / 异步 `load` 的坏文件留档与版本只读 / 条目级畸形字段收敛 / `pruneEntries` 超 500 条淘汰顺序 / `writeLedger` rename 失败清理临时文件 / 读盘非 ENOENT 错误 / 空抑制键.
  - `tests/observe.test.ts`: `turn/start` 与字符串 `turn/end.reason` / 自定义标记与码点上限 / 审批事件缺字段 / `paramHead` 非法 URL 与非 JSON 参数 / `messageText` 非对象块 / 审批配对表 500 条上限.
  - `tests/induce.test.ts`: `findEntry` 多相似条目取最高分 / 最近证据窗口边界 / 合并时补标题不覆盖已有标题.
- 集成层 (新增 `tests/assemble.ts` 与 `tests/integration/plugin.test.ts`, 11 条):
  - 装配器用三个假面拼 `apply`: 假事件面 (`on` / `emit` / 解绑计数), 假工具面 (`register` / `call` / `render`), 假 memory 面 (复用 `tests/fakes.ts`) 与假 rule-engine 面; ctx 按 cordis 语义只经 `ctx.get` 取服务, `viaGet: false` 覆盖直接属性兜底.
  - 用例覆盖: 注册面各一次与启动归纳落盘 / 三条信号 (S1, S2 加权, S3 审批拒绝) 写回同一账簿 / 高置信自动写库与库行引用及注入正文与消费者冻结值 / 工具 canonical 值与 `output.render` 投影 / 候选待审与撤销 / 撤销生效条目真删库行 / memory 缺席与 ruleEngine 缺席降级 / `enabled: false` / `dispose` 解绑 / 非 cordis 宿主.
  - 状态一律 `mkdtemp` 临时目录, `cleanup` 解绑后删除; 无残留.
- 脚本: `package.json` 加 `test:integration` (`tests/integration/*.test.ts`) 与 `test:coverage` (按 4.2 的命令, 覆盖率目录 `tmp/cov-preference-analysis`).
- 未改 `src`.
- 阶段 3 代码整理（分支 `history-cleanup/03-code-preference-analysis`）：
  - 上下文对象守卫收进入口：`src/index.ts` 新增 `contextObject`（非对象 ctx 归一为共用空容器 `EMPTY_CONTEXT`），`HostContext` 补索引签名；`getService` 删掉逐次 `ctx === null || typeof ctx !== "object"` 判断，改收归一后的对象；`apply` 与 `createPlugin` 各在入口判一次。判定结果不变：null / 原始值仍取不到服务。
  - `src/tools.ts:97` 的「三个工具」去数字，按 3.9 改指向导出常量：构造工具定义（工具名见 `TOOL_NAMES`）。
  - 5.2 零引用导出复查：无。逐符号核对本包 5 个 `src` 文件的全部导出（含类型与常量），每个符号至少在定义文件内有实现引用；19 个仅在定义文件内使用，属内部实现，5.2 的「全仓含测试无任何引用」口径未命中，故不删。
  - 路径注释：入口文件头部 3 行里的 `observe.ts` / `induce.ts` / `ledger.ts` / `apply.ts` 简写补成从仓库根算起的 `preference-analysis/src/*.ts`。

## 偏差

- 阶段 2：无 (未改 `src`)。
- 阶段 3：
  - 5.1 与 6.7 把注释路径与计数排到第 6 章；本阶段任务单明确列了 `src/tools.ts:97` 计数注释与「路径注释补全」，按任务单执行，实现规划与总追踪未动。
  - 任务单写的 `src/main.ts` 在阶段 2 后已迁为 `src/index.ts`（入口迁移），本次落点即 `src/index.ts`，内容同一。
  - `tests/assemble.ts` 注释里的 `tests/fakes.ts` 简写未动：阶段 3 边界只含本包测试的 import，注释留给阶段 4 / 6。
  - `src/index.ts` 的上下文守卫由 `getService` 内联判断改为入口归一，`apply` 与 `createPlugin` 各判一次；`apply` 仍把原始 ctx 交给 `createPlugin`，两处互不依赖，判定结果与原实现一致。

## 测试与证据

### 覆盖率 (改前 / 改后)

| 文件 | 行 (改前) | 行 (改后) | 分支 (改前) | 分支 (改后) |
| --- | --- | --- | --- | --- |
| `src/apply.ts` | 83.8% (268/320) | 95.0% (304/320) | 69.5% (41/59) | 85.3% (58/68) |
| `src/index.ts` | 81.4% (476/585) | 90.6% (530/585) | 76.4% (123/161) | 88.1% (163/185) |
| `src/induce.ts` | 96.5% (191/198) | 99.5% (197/198) | 91.8% (45/49) | 98.1% (52/53) |
| `src/ledger.ts` | 86.4% (361/418) | 95.0% (397/418) | 61.4% (62/101) | 86.1% (118/137) |
| `src/observe.ts` | 89.7% (280/312) | 96.2% (300/312) | 80.4% (78/97) | 89.7% (104/116) |
| `src/tools.ts` | 97.5% (194/199) | 97.5% (194/199) | 88.5% (23/26) | 85.2% (23/27) |
| 整包 | 87.1% (1770/2032) | 94.6% (1922/2032) | 75.5% (372/493) | 88.4% (518/586) |

- `src/tools.ts` 分支比下降是分母由 26 变 27 (覆盖数 23 不变): 集成层让该文件在额外进程里被加载, V8 记到的块更完整; 整包与其余文件均升, 按 4.3「整包只升不降」判定通过.
- 未覆盖行: `apply.ts` 160, 166, 196-197, 214-215, 218-220, 235, 294, 304, 317, 329-331; `index.ts` 260-265, 278-287, 292, 294, 405-408, 414-416, 418, 437-440, 444-446, 448, 457-461, 503, 553-554, 576-578, 601, 603-605, 609-610, 646-647 等 (含 V8 行归属把分支块记在相邻行的假阴性); `induce.ts` 161; `ledger.ts` 79, 81, 289-290, 295-296, 326-327, 336-339, 379-380, 383, 441-442, 444, 446, 465-466; `observe.ts` 108, 183, 251-252, 322, 343-345, 347, 353-354, 365.
- 导出覆盖率: `src/index.ts` 9 个运行时导出 (`name` / `inject` / `MAX_PENDING_OBSERVATIONS` / `DEFAULT_MIN_INTERVAL_MS` / `resolveConfig` / `createPlugin` / `CONSUMER_REGISTRATION` / `apply` / `DAY_MS`) 全部在用例中被引用, 9/9.
- 错误码覆盖率: 本包不抛 `code` 常量, 错误一律以 `reason` 文本返回, n/a.

### 四条入口实跑 (分支上)

```text
pnpm -C preference-analysis run check             -> tsc --noEmit 通过 (exit 0)
pnpm -C preference-analysis run test              -> tests 98, pass 98, fail 0, skipped 0, todo 0
pnpm -C preference-analysis run test:integration  -> tests 11, pass 11, fail 0, skipped 0, todo 0
pnpm -C preference-analysis run test:coverage     -> tests 109, pass 109, fail 0; 报告 tmp/cov-preference-analysis/report.json
```

### 4.4 复核

- `skip` / `todo`: 0 处 (`grep` 只命中 apply 用例里的 `result.skipped`, 是业务字段不是测试修饰).
- 夹具: 无 `tests/fixtures/`; 临时状态都在 `mkdtemp` 目录, 用后删除.
- 存量用例: 未改名, 未改语义.

### 阶段 3 代码整理 (分支上)

```text
pnpm -C preference-analysis run check -> tsc --noEmit 通过 (exit 0)
pnpm -C preference-analysis run test  -> tests 98, pass 98, fail 0, skipped 0, todo 0
```

- 用例断言未改 (98 条与阶段 2 末一致, 无新增 / 删除).
- 非对象 ctx 实跑 (临时脚本, 用后已删): `apply` 与 `createPlugin` 传 `null` / `undefined` / `42` / `"x"` / `true` / `[]` / `{}` 均不抛错, `memoryAvailable` 皆为 `false`, `createPlugin` 告警各 1 条; 与改前判定一致.
- 5.2 零引用导出: 0 个 (逐符号在 `src` / `tests` / `docs` / `scripts` 中核对, 无「全仓无引用」符号).

## 四份测试产物

| 产物 | 位置 |
| --- | --- |
| 覆盖率表 (改前 / 改后) | 见「测试与证据」的覆盖率表 |
| 新增 / 删除用例清单 | 见「实现记录」的「单元锚点 / 集成层」段 |
| `skip` 计数与豁免台账 | 见「测试与证据」的 `skip` / 豁免段 |
| 四个入口实跑 | 见「测试与证据」的入口段 |
