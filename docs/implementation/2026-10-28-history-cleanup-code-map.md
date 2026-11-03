# code-map 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 code-map 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `code-map` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 5 个 `.test.ts` (`bundle.test.ts` / `graph.test.ts` / `report.test.ts` / `scan.test.ts` / `semantic.test.ts`); 阶段 1 末 `pnpm -C code-map run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 83.1% (877/1055); 分支 61.5% (115/187).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C code-map run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-code-map && mkdir -p ../tmp/cov-code-map && NODE_V8_COVERAGE=../tmp/cov-code-map node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-code-map tmp/cov-code-map/report.json
```

- 专项: -.
- 验收: `pnpm -C code-map run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 code-map 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-code-map`, worktree `.worktree/03-code/code-map`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C code-map run check` 与 `pnpm -C code-map run test`.
- 任务:
  - `src/semantic/lsp.ts` 的上下文对象守卫收进本包入口, 只判一次.
- 验收: `pnpm -C code-map run check` 与 `pnpm -C code-map run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(code-map): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

- 分支 `history-cleanup/04-package-docs-code-map`, worktree `.worktree/04-package-docs/code-map`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/DESIGN.md` / `docs/BACKLOG.md`.
- `README.md`: 现有 6 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- `docs/DESIGN.md`: 归并为四节 `## 背景` / `## 结构` / `## 机制` / `## 取舍`; 只改节名与合并重复, 机制与取舍内容不动.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- `docs/BACKLOG.md`: 同文件的命令与术语同步改; 条目内容、状态与顺序不动.
- 验收: 六节齐 (无配置可省)、四节齐、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(code-map): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

- 新增 `tests/assemble.ts` (装配器, 不以 `.test.ts` 结尾): 假工具面 / 假事件面 / 假服务面 + 假 astTools 面.
  假 ast 按固定表回放 `outline` / `search` (含 import 整行形态、`signature` 缺失、空 `astKind`),
  并让 `broken/gen.ts` 一律抛错; 项目落 `os.tmpdir()` 的临时目录, 用例结束删除, 不依赖 ast-grep 二进制.

- 新增 `tests/integration/plugin.test.ts`, 15 条: `apply` 注册与 `provide` 面; `index` / `refresh` /
  `callers` / `callees` / `impact` / `cycles` / `report` / `summary` 八个 action 的 canonical 值与未索引错误;
  `output.render` 投影 (含 `undefined` / 字符串兜底与形参顺序哨兵); `codeMap.getSummary` / `getBundle`;
  宿主形态 (缺 `tools` / 缺 `provide` / `register` 抛错 / 无 logger 落 stderr); `ctx.get("lsp")` 语义层接线
  (`precision=lsp` 且不搜候选); 临时目录清理.

- 单元锚点 12 条 (24 → 36): `graph` 2 条 (`addImport` 任一端不在图时忽略、自环不入依赖环);
  `report` 2 条 (符号 kind 归一全桶、跨模块 import 上卷去重与 `.` 模块); `scan` 3 条
  (绝对说明符按仓库内外分流、噪音目录跳过、`outline` 抛错或返回空数组时跳过且 `filesScanned` 仍计数);
  `semantic` 4 条 (`ctx.get` 抛错回落直接属性、`query` 非函数、结果形状 fail-open 与非法条目丢弃、
  `AbortSignal` 透传、`symbolPositionAt` 入参守卫); `bundle` 1 条 (惰性索引、并发 `inflight` 去重、
  已索引摘要、`refresh` 与 `index({ root })` 重扫). 存量断言未改语义, 只补 `inject` 契约一条.

- `package.json` 加 `test:integration` / `test:coverage` (后者含单元与集成两层 glob, 输出到 `tmp/cov-code-map`).

- 观察项 (留阶段 3): `src/report/builder.ts` 的 `kindBucket` 只认 `class` / `interface` / `enum` /
  `function|method|arrow` / `variable|let|const` / `type` / `import` 词根, ast-grep 的 `lexical_declaration`
  与空 `astKind` 都落 `other`; 本阶段按现状锁定 (`kindCounts` 断言写 `other: 2`), 未改实现.

- 另记: `src/index.ts` 的 `callees` / `impact` / `report` / `summary` 等方法在集成跑里被逐个调用,
  但报告仍按未覆盖计 (见「测试与证据」的口径说明); 未为凑数加用例.

- 阶段 3 (代码整理): 上下文对象守卫收进 `apply` 入口 (`src/index.ts` 新增 `host` 归一);
  `resolveLspReferences` 改收已归一的 `object` (缺省空对象), `src/semantic/lsp.ts` 的 `readLspSurface`
  删掉 `ctx === null || typeof ctx !== "object"` 这一判断, 每处只判一次. 判定结果不变: `null` / 非对象
  仍等价空上下文 (无 `lsp` 服务 → `undefined`), 工具注册 / `provide` / `logger` 的取值路径未动.

- 阶段 3 (零引用导出复查): 无. 44 个模块级导出逐个扫 worktree (排除 `node_modules` / `dist` / `tmp`),
  每个都至少有「声明行 + 一处引用」, 未发现零引用符号, 未删任何导出.

- 阶段 3 (`kindBucket` 复核): 详见「偏差」第 2 条.

- 阶段 3 补丁 (2026-11-01): `warn` 改为显式分支, 避免 logger 返回 `void` 时同时落 stderr.

## 偏差

1. 入口守卫的边界变化: `apply(undefined)` / `apply(null)` 此前读 `ctx.logger` 就抛 `TypeError`,
   现按空上下文继续; 这是总追踪 5.6「上下文对象守卫收各包入口」的预期收敛,
   非对外可见面 (工具名 / 参数 / 投影 / 配置键不变). 另: `tests/assemble.ts:392` 的注释仍写
   「`apply` 未做守卫, 传 `undefined` 会抛」, 已随本次改动失效; 本阶段只允许改源码与测试 import,
   该注释留阶段 5 (第 6 章)「注释与代码不一致」处理.
2. `kindBucket` 忽略 `lexical_declaration`: 字面属实 (函数级判断里没有该词根, 会落 `other`), 但实测
   ast-grep 0.51.0 的 `outline --json=compact` 对顶层声明给 `variable_declarator` (落 `variable`) 与
   `export_statement` (落 `other`), 不出现 `lexical_declaration`; 观察项「ast-grep 的
   `lexical_declaration` 落 `other`」与真实管线不符. 真实失真在导出声明的 `astKind` 是
   `export_statement`, 以及成员 `property_signature` / `property_identifier` 与空 `astKind` 都落 `other`,
   故 `report.kindCounts` 对导出符号基本失真. 属行为改动 (改 `kindBucket` 或 `scan` 的 kind 选取),
   本阶段不改, 交后续条目. 阶段 3b 已登记为 `code-map/docs/BACKLOG.md` `#1` (需连同 `kindCounts`
   快照一起改), 本阶段不修.
3. 阶段 2 的覆盖率口径未变; 本次在 `src/index.ts` 入口新增归一与注释, 阶段 2 的行覆盖数字不再逐行
   可比 (本阶段未重跑覆盖率, 验收只要求 `check` / `test`).

## 测试与证据

命令 (均在 `code-map/` 下实跑, 2026-11-01):

| 命令 | 结果 |
| --- | --- |
| `pnpm run check` | 通过 (tsc --noEmit 无输出) |
| `pnpm run test` | 36 条通过 / 0 失败 / skipped 0 / todo 0, 约 213ms |
| `pnpm run test:integration` | 15 条通过 / 0 失败 / skipped 0 / todo 0, 约 104ms |
| `pnpm run test:coverage` | 行 93.6% (987/1055), 分支 87.9% (225/256) |

用例数: 单元 24 → 36 (+12), 集成 0 → 15 (+15); 未删用例, 无 `skip` / `todo`, 包内无夹具.

覆盖率 (改前 / 改后, 同一命令):

| 文件 | 行 改前 | 行 改后 | 分支 改前 | 分支 改后 |
| --- | --- | --- | --- | --- |
| `src/graph/graph.ts` | 97.2% (104/107) | 100.0% (107/107) | 89.5% (17/19) | 100.0% (27/27) |
| `src/graph/query.ts` | 100.0% (41/41) | 100.0% (41/41) | 100.0% (2/2) | 100.0% (2/2) |
| `src/index.ts` | 72.0% (293/407) | 86.2% (351/407) | 50.0% (30/60) | 76.3% (61/80) |
| `src/indexer/refs.ts` | 100.0% (34/34) | 100.0% (34/34) | 100.0% (2/2) | 100.0% (2/2) |
| `src/indexer/scan.ts` | 92.1% (199/216) | 96.3% (208/216) | 71.1% (27/38) | 89.4% (42/47) |
| `src/report/builder.ts` | 77.8% (77/99) | 100.0% (99/99) | 51.9% (14/27) | 94.9% (37/39) |
| `src/semantic/locate.ts` | 90.0% (18/20) | 100.0% (20/20) | 87.5% (7/8) | 100.0% (11/11) |
| `src/semantic/lsp.ts` | 84.7% (111/131) | 96.9% (127/131) | 51.6% (16/31) | 89.6% (43/48) |
| 合计 | 83.1% (877/1055) | 93.6% (987/1055) | 61.5% (115/187) | 87.9% (225/256) |

契约面: 导出覆盖 7/7 (`name` / `inject` / `provide` / `createCodeMapBundle` / `getCodeMapBundle` /
`getCodeMapSummary` / `apply` 均有用例断言); 错误码 4/5 (`not_indexed`、`未知 action`、
`未索引（先调用 index）`、`impact 需要 file 参数` 有断言, `ast-grep 不可用（code-map 降级）` 仅降级路径给).

口径说明: 报告按 `dev/coverage/report.mjs` 的「行取最小 span」聚合, 与 TS 类型擦除后的 v8 range
叠加后, 少量确被走到的方法行仍显示未覆盖 (`src/index.ts` 的 111-112、179-181、215-217、227-259、
446-447、457-463 等, `src/semantic/lsp.ts` 62 / 126-127 / 136 亦同); 因此本表只做**同命令**改前改后
对比, 未逐行追该偏移. 另: `report.mjs` 不排除 `dist`, 依赖包 `ast-tools/dist/src/*` 会一并进汇总表的
`ast-tools` 行 (合计行含对端), 本包数字按 `code-map` 行取.

豁免台账:

| 位置 | 缺什么 / 为什么补不了 | 触发条件 | 交给谁 |
| --- | --- | --- | --- |
| `src/index.ts:282-283` 与 `degradedBundle` (288-311) | 本机有 ast-grep, `createCodeMapBundle` 在 `config.ast` 为空时直接自建真 bundle, 没有注入口可强制失败 | 目标机无 ast-grep 二进制 | 阶段 3 (可考虑给工厂留注入口, 或包内用子进程改 PATH 隔离) |
| `src/indexer/scan.ts:72,78-81` (`readdirSync` / `statSync` 失败的防御分支) | 需不可读目录或悬空符号链接; 当前用户权限下临时目录造不出 | 权限受限或扫描中并发删文件 | 阶段 3 判定是否可删该防御 |
| `src/index.ts:341,346-347,361,365` (工具描述与参数文案) | 纯文案 (总追踪 4.1 的 P4) | - | 不补 |

阶段 3 (代码整理, 2026-11-02, 均在 `code-map/` 下实跑):

| 命令 | 结果 |
| --- | --- |
| `pnpm run check` | 通过 (tsc --noEmit 无输出) |
| `pnpm run test` | 36 条通过 / 0 失败 / skipped 0 / todo 0, 约 206ms |
| `pnpm run test:integration` | 15 条通过 / 0 失败 / skipped 0 / todo 0, 约 104ms |

守卫行为实测 (临时脚本调 `apply`, 未改用例): `undefined` / `null` / `42` / `"x"` / `{}` 五种入参均不抛,
`getCodeMapSummary()` 均为 `undefined`; 与改前语义一致 (无宿主面 → 无服务). 改前仅 `undefined` / `null`
在读 `ctx.logger` 处抛 `TypeError` (数字 / 字符串 / 空对象本就不抛), 现一并收敛为空上下文.

零引用导出复查: 44 个模块级导出逐名扫 worktree (含 `src` / `tests` / `docs` / 配置文件, 排除
`node_modules` / `dist` / `tmp`), 最少命中 2 行 (声明 + 一处引用), 零引用 0 个, 故无删除.

`kindBucket` 复核实测 (ast-grep 0.51.0, 临时目录 3 个文件: 未导出 `const` / `var` / `function` /
`class` 与导出 `function` / `interface` / `type` / `enum`): `report.kindCounts` 为
`{"variable":3,"function":1,"class":1,"other":7}`; 顶层声明实际 `astKind` 为 `variable_declarator` /
`export_statement`, 不出现 `lexical_declaration`.

## 四份测试产物

| 产物 | 位置 |
| --- | --- |
| 覆盖率表 (改前 / 改后) | 见「测试与证据」的覆盖率表 |
| 新增 / 删除用例清单 | 见「实现记录」的「单元锚点 / 集成层」段 |
| `skip` 计数与豁免台账 | 见「测试与证据」的 `skip` / 豁免段 |
| 四个入口实跑 | 见「测试与证据」的入口段 |
