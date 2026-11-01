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

阶段 4 补.

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

## 偏差

无 (未改 `src`; 覆盖率与脚本按规划口径落地).

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
