# md-map 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 md-map 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `md-map` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 5 个 `.test.ts` (`indexer.test.ts` / `links.test.ts` / `query.test.ts` / `refs.test.ts` / `tool.test.ts`); 阶段 1 末 `pnpm -C md-map run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 89.6% (1355/1512); 分支 78.4% (362/462).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C md-map run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-md-map && mkdir -p ../tmp/cov-md-map && NODE_V8_COVERAGE=../tmp/cov-md-map node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-md-map tmp/cov-md-map/report.json
```

- 专项: -.
- 验收: `pnpm -C md-map run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 md-map 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

分支 `history-cleanup/02-tests-md-map`;`src` 未改（本次为可测性不需要动 `src`）。

- 单元层新增两份用例, 并在 `tests/tool.test.ts` 追加两条边界用例（现有断言语义未改）:
  - `tests/render.test.ts`（8 条）: `renderIndex` / `renderCallers` / `renderImpact` / `renderOrphans` / `renderReport` / `renderSummary` 的空结果、kind 过滤标注、`RENDER_LIMIT` 截断与余数、每层 20 条上限、报告孤儿 15 条预览、断链三类原因、`refEdges` 缺省按 0。
  - `tests/service.test.ts`（5 条）: 未索引时各查询回空; `config.root` 作为缺省且显式 `root: undefined` 不冲掉它; 调用方 `root` 覆盖并覆盖旧索引; `hasDoc` 的后缀 / 文件名 / 锚点剥离; callers / impact / orphans / report / summary 转发; `refresh` 同义与 `dispose` 复位。
  - `tests/tool.test.ts`: 追加「root 相对路径以会话 cwd 为基准」(含无会话回落进程 cwd) 与「root 不存在 / 不是目录」两条。
- 集成层新增装配器与用例:
  - `tests/assemble.ts`: 假工具面（`ctx.tools.register` 收集, 可注入拒绝注册）/ 假事件面（零订阅断言）/ 假服务面（`ctx.provide` 同名重复即抛）/ 假 logger（`ctx.logger(ns).info`）; 装配形态 `full` / `no-tools` / `no-provide` / `no-logger`; 文档集 `DOC_FIXTURE` 落 `os.tmpdir()` 临时目录, 用后删除。
  - `tests/integration/plugin.test.ts`（15 条）: `md_map` 注册与参数 schema 面; `mdMap` 服务面 provide; 注册失败只告警; 缺 `ctx.tools` / 缺 `ctx.provide` / 无 logger 的降级; `index` 的六类边 canonical 值（含 `anchorOk`、`entry`、`backlinks`、三类 `broken` reason）与 render 投影; `callers` 的 anchor / kind 过滤回显与投影文本; `impact` 的 depth 缺省与逐层过滤; `orphans` / `report` / `summary` 的 canonical 值与投影; 未索引与非法入参的失败投影; root 相对解析与不存在 / 非目录; 服务面 `getSummary` 随索引变化; `output.render` 对畸形值不抛。
- `md-map/package.json`: 新增 `test:integration` 与 `test:coverage`（命令与 `hash-edit` / `fs-digest` 同构, 覆盖率目录 `tmp/cov-md-map`）。
- 删除用例与夹具: 无。`skip` / `todo`: 0 处（本机处理前后均为 0）。

## 偏差

无

## 测试与证据

命令（均在 `md-map/` 下实跑）:

| 入口 | 结果 |
| --- | --- |
| `pnpm run check` | 通过（tsc --noEmit 无输出） |
| `pnpm run build` | 通过 |
| `pnpm run test` | 65 条通过, 0 失败, 0 跳过（基线 50 条） |
| `pnpm run test:integration` | 15 条通过, 0 失败, 0 跳过 |
| `pnpm run test:coverage` | 见下表（`tmp/cov-md-map/report.json`） |

覆盖率（只统 `src`; 改前 = 阶段 1 末单元层单跑, 改后 = 单元 + 集成）:

| 文件 | 行（改前） | 行（改后） | 分支（改前） | 分支（改后） | 未覆盖行（改后） |
| --- | --- | --- | --- | --- | --- |
| `src/index.ts` | 87.6% (78/89) | 98.9% (88/89) | 0.0% (0/1) | 85.7% (6/7) | 66 |
| `src/indexer.ts` | 91.9% (363/395) | 92.2% (364/395) | 82.7% (110/133) | 83.5% (116/139) | 48, 53, 89, 104, 143, 180, 210-217, 258-260, 378-381, 394-397, 408, 409, 413, 414, 422, 423 |
| `src/links.ts` | 89.3% (327/366) | 93.7% (343/366) | 80.0% (128/160) | 81.4% (136/167) | 97, 98, 132, 167, 175, 240, 247, 259, 262, 274-276, 284, 287, 288, 315, 316, 338, 342, 343, 392-394 |
| `src/query.ts` | 94.4% (135/143) | 94.4% (135/143) | 93.0% (40/43) | 93.0% (40/43) | 3-9, 60 |
| `src/render.ts` | 79.2% (114/144) | 93.8% (135/144) | 48.6% (17/35) | 83.3% (45/54) | 107, 108, 114-119, 138 |
| `src/service.ts` | 86.4% (70/81) | 100.0% (81/81) | 25.0% (2/8) | 100.0% (14/14) | 无 |
| `src/tools.ts` | 91.2% (268/294) | 96.3% (283/294) | 79.3% (65/82) | 87.2% (82/94) | 195, 203, 227-233, 298, 308, 309 |
| 合计 | 89.6% (1355/1512) | 94.5% (1429/1512) | 78.4% (362/462) | 84.7% (439/518) | - |

- 分层贡献（两轮取差）: 只跑单元层为行 93.6% (1415/1512) / 分支 84.7% (425/502); 加集成层后行 94.5% (1429/1512) / 分支 84.7% (439/518), 集成层贡献 14 行。
- 分支分母随执行的函数数变化（未被调用的函数不上报 block range）: 改前 462、单元层改后 502、两层合计 518, 故分支覆盖以百分比为可比口径, 计数分母不跨轮比较。
- 未覆盖行的构成（逐条核对）: 多数是注释与类型声明行（如 `index.ts:66`、`indexer.ts:48, 53, 89, 104, 143, 180`、`query.ts:3-9`）, 以及多行对象展开的行归属偏差（如 `indexer.ts:378-381` 的 `external` 带 `text` 分支、`render.ts:107-108` 的报告首行, 用例已实际执行却仍记未覆盖）; 真实未测路径只剩少数边界（`links.ts` 的等长反引号跨行切段与目录相对候选、`indexer.ts` 的 `ref` 目录兜底越界分支）, 本阶段不补, 留代码阶段一并处置。
- `output.render` 投影、`index` 六类边、`callers` / `impact` / `orphans` / `report` / `summary` 的 canonical 值均由集成用例钉住: 文档集覆盖 internal / wiki / file / external / broken(missing-file, missing-anchor, outside-root) / ref 六类边与入口判定。
- 豁免台账: 「空 `ctx`」（`apply(undefined)`）不写用例——`apply` 无对象守卫, 传入即抛 `TypeError`, 补测只会固化崩溃行为, 已立 `md-map/docs/BACKLOG.md` #1（与 `hash-edit` 同源）; `warn` 在常规 logger（`info` 返回 `void`）下同时写 logger 与 stderr 的现状由集成用例钉住（断言 stderr 一条）, 处置见 `md-map/docs/BACKLOG.md` #2。
