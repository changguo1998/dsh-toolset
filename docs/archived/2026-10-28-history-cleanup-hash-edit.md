# hash-edit 整理 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 hash-edit 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `hash-edit` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 4 个 `.test.ts` (`edit.test.ts` / `fs.test.ts` / `hashline.test.ts` / `tool.test.ts`); 阶段 1 末 `pnpm -C hash-edit run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 87.0% (653/751); 分支 73.3% (85/116).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C hash-edit run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-hash-edit && mkdir -p ../tmp/cov-hash-edit && NODE_V8_COVERAGE=../tmp/cov-hash-edit node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-hash-edit tmp/cov-hash-edit/report.json
```

- 专项: -.
- 验收: `pnpm -C hash-edit run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 hash-edit 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-hash-edit`, worktree `.worktree/03-code/hash-edit`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C hash-edit run check` 与 `pnpm -C hash-edit run test`.
- 任务:
  - `src/index.ts:294` 的计数注释改指向常量, 不再写死数字.
  - 按 `.ts` 符号扫描复核本包, 有零引用导出按 5.2 处理, 无则记「无」.
- 验收: `pnpm -C hash-edit run check` 与 `pnpm -C hash-edit run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(hash-edit): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

- 分支 `history-cleanup/04-package-docs-hash-edit`, worktree `.worktree/04-package-docs/hash-edit`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/BACKLOG.md`.
- `README.md`: 现有 7 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- `docs/BACKLOG.md`: 同文件的命令与术语同步改; 条目内容、状态与顺序不动.
- `README.md` 的「注册两个模型侧工具」与「注册两个工具」去数字, 改为「注册模型侧工具」.
- 验收: 六节齐 (无配置可省)、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(hash-edit): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

日期: 2026-11-01. 分支 `history-cleanup/02-tests-hash-edit`.

> 测试基线、单元锚点、集成层与脚本见「四份测试产物」; 本节保留范围说明与阶段 3 / 4 记录.

- 未改 `src`; 用例只经 `src/index.ts` 与同包模块的公开导出。

- 阶段 3 代码整理 (日期 2026-11-01, 分支 `history-cleanup/03-code-hash-edit`): 计数注释 `src/index.ts:294` 改「构造工具定义」, 不写数量 (本包没有与工具数对应的导出常量, 按任务口径用文字表述); 零引用导出按 5.2 复查为「无」 (28 个具名导出都有引用, 明细见「测试与证据」); 路径注释与标题补 4 处 (`src/index.ts:260` 与 `src/fs.ts:30` 的 `edit.ts` → `hash-edit/src/edit.ts`、`src/index.ts:15` 的「本包 fs.ts」→ `hash-edit/src/fs.ts`、`src/index.ts:7` 的 `task-engine/src/main.ts` → `task-engine/src/index.ts`), 并把 `src/index.ts:2` 的标题 `main` 改为 `index`; 未删代码, 工具名 / 参数面 / `output.render` 投影 / 配置键 / 注入文案与用例断言均未动。

- 阶段 3 补丁 (2026-11-01): `apply` 补非对象 `ctx` 守卫 (stderr 告警后返回); 包 BACKLOG #1 关闭.

- 阶段 4 包文档 (2026-11-02, 分支 `history-cleanup/04-package-docs-hash-edit`): `hash-edit/README.md` 的 7 个二级标题归并为六节 —— 原来是「能力 / 配置 / 使用示例 / 与官方 read / edit 的边界 / 边界与限制 / 文件结构与相关文档 / 测试」, 改成「定位 / 能力 / 配置 / 用法 / 边界 / 测试」; 首段定位文字移入 `## 定位`, 原「文件结构与相关文档」整段降为 `## 定位` 下的 `### 文件结构与相关文档`, 原「与官方 read / edit 的边界」与「边界与限制」降为 `## 边界` 下的两个 `###`; 原「使用示例」改名 `## 用法`; 测试块 4 条命令的 `npm` 改 `pnpm`; 「注册两个模型侧工具」与文件结构块里的「注册两个工具」去数字, 改为「注册模型侧工具」; `hash-edit/docs/BACKLOG.md` 无 `npm`、无旧术语、无未完成条目, 未改.

## 偏差

- 集成层装配形态收窄为 `full` / `no-tools` 两种, 计划里的「空 `ctx`」未做: `apply` 没有 `ctx === null || typeof ctx !== "object"` 守卫, 传 `undefined` 会抛 `TypeError: Cannot read properties of undefined (reading 'tools')` (实测), 补守卫属 `src` 改动, 本阶段不动; 已在 `hash-edit/docs/BACKLOG.md` 登记 `#1` 并进下方豁免台账。同类判断散落见总追踪调研 1.8「上下文对象守卫」(15 个包), 统一收口留阶段 3。后续: 2026-11-01 补丁轮已补守卫 (`src/index.ts:377`, 提交 `54ac908c`), 包 BACKLOG `#1` 关闭; 集成用例未加空 `ctx` 一例, 留给阶段 4 复核补测.
- 阶段 3 的代码项在本包只有注释一类可落: 本包无 `src/timers.ts`, 无跨包复制的同名函数 (`src` 最大文件 390 行), 结构改写 (删失效 / 并定时器族 / 拆长文件 / 收拢判断) 没有对应对象, 故只做计数注释、零引用导出复查与路径注释。
- 计划写「计数注释改指向常量」, 实际落为去数字: 本包没有与「两个工具」对应的导出常量 (两个工具定义在 `createTools` 内就地构造), 造常量只为给注释引用不划算, 按任务口径写成「构造工具定义」。
- 比任务清单多改两处同属注释口径的位置: `src/index.ts:7` 的跨包入口路径 `task-engine/src/main.ts` 已不存在 (该包入口改名为 `index.ts`), 改为 `task-engine/src/index.ts`; `src/index.ts:2` 的标题 `main` 与实际文件名 `index.ts` 不一致, 改为 `index`。两处都不影响行为, 记为计划外更正。
- 阶段 4 的「文件结构与相关文档」在六节模板里没有对应节: 本包就是 7 个二级标题要并成 6 节, 多出来的正是这一节; 处理成 `## 定位` 下的 `### 文件结构与相关文档`, 理由是该段讲本包在仓内的位置与相邻文档, 与定位同主题, 内容与表格一字未改。若后续统一口径要求另作处理, 只需移走这一节。
- 阶段 4 的文件结构块里 `src/main.ts` 已在入口迁移时改名为 `src/index.ts` (提交 `cfbcbe64`, R100), README 未跟改; 本阶段按实际路径更正为 `index.ts`, 同行的「注册两个工具」按去数字口径一并改为「注册模型侧工具」。
- 阶段 4 的测试行原写「53 例」, 阶段 2 之后已变为单元 57 例 + 集成 18 例; 该行改为不写例数, 并在测试区域与结构块里补上 `integration` 目录, 只对齐现状, 未加结论。

## 测试与证据

> 四入口、覆盖率、用例清单与豁免台账见「四份测试产物」; 本节保留阶段 3 / 4 实跑与复查.

### 阶段 3 命令实跑 (2026-11-01, 分支 `history-cleanup/03-code-hash-edit`)

| 命令 | 结果 |
| --- | --- |
| `pnpm -C hash-edit run check` | 通过 (`tsc --noEmit` 无输出) |
| `pnpm -C hash-edit run test` | 57 例通过 / 0 失败 / 0 跳过 / 0 todo, 约 98ms |
| `pnpm -C hash-edit run test:integration` | 18 例通过 / 0 失败 / 0 跳过 / 0 todo, 约 93ms |
| `pnpm -C hash-edit run build` | 通过 (`tsc -p tsconfig.json` 无输出) |
| `prettier --check src/index.ts src/fs.ts` | 通过 (两文件已符合格式) |

用例未增删, 断言未改; 行为面未动, 57 + 18 例与阶段 2 结果一致。

### 零引用导出复查 (5.2)

扫描口径: 对 `src` 的 28 个具名导出 (`hashline.ts` 11、`edit.ts` 6、`fs.ts` 7、`index.ts` 4) 按符号名全仓检索, 范围 `src` / `tests` / `demo` / `docs` / `scripts` / `profiles`, 排除 `node_modules` 与 `dist`; `index.ts` 的 `export *` 不重复计数。结果:

- 入口对外引用: `apply` / `name` / `inject` / `Config` 被 `tests/assemble.ts` 与 `tests/integration/plugin.test.ts` 引用; 宿主按 `cordis.patch.yml` 装配入口, 其他包不 import 本包内部模块。
- 测试或 demo 引用: `hashLine`、`hashlines`、`splitLines`、`detectLineEnding`、`formatAnchor`、`parseLineAnchor`、`HASH_LEN`、`AnchoredEditError`、`EditOp`、`FileEditError`、`readHashlines`、`applyAnchoredEditsFile`、`listDir`、`applyAnchoredEdits`、`fileHash`、`Hashline`、`EditSuccess`。
- 仅包内引用: `LINE_ANCHOR_RE`、`Anchor`、`EditErrorCode`、`AnchorDetail`、`FileErrorCode`、`ReadResult`、`FileEditSuccess` (被同包函数签名或实现使用, 引用数不为 0)。
- 结论: 零引用导出「无」, 未删任何符号。

### 阶段 4 包文档 (2026-11-02, 分支 `history-cleanup/04-package-docs-hash-edit`)

| 检查 | 结果 |
| --- | --- |
| `format hash-edit/README.md hash-edit/docs/BACKLOG.md` | 通过 (无输出) |
| `git diff` 自查 | 只有节名与层级改动、整段移动 (`文件结构与相关文档`) 与命令 / 数字措辞; 无段落删除, 无新增结论 |
| 二级标题 | 6 个: 定位 / 能力 / 配置 / 用法 / 边界 / 测试 |
| 正文 `npm` | 0 (仅 `pnpm` 前缀) |
| 符号变体 | 0 |
| Markdown 引用 | `docs/host/DSH-CTX-API.md` / `ast-tools/README.md` / `docs/ARCHITECTURE-REUSE.md` 三个目标均存在 |

本阶段为文档改动, 未跑代码门禁 (`check` / `test` / `build`); 未改 `src` / `tests` / `package.json` / `tsconfig.json` / `cordis.patch.yml`。

## 四份测试产物

> 四类数据从「实现记录」「测试与证据」搬入本节; 原节保留指针; 数字照录, 未重新计算.

### 覆盖率

- 基线 (改动前, 本分支): 覆盖率行 87.0% (653/751), 分支 73.3% (85/116).
- 覆盖率 (改前 / 改后):

| 文件 | 行 (改前) | 行 (改后) | 分支 (改前) | 分支 (改后) | 未覆盖行 (改后) |
| --- | --- | --- | --- | --- | --- |
| `src/edit.ts` | 96.6% (257/266) | 96.6% (257/266) | 88.7% (47/53) | 88.9% (48/54) | 55, 165-169, 209, 210, 212 |
| `src/fs.ts` | 88.5% (108/122) | 94.3% (115/122) | 75.0% (15/20) | 80.0% (20/25) | 47, 66, 101, 119, 120, 139, 148 |
| `src/hashline.ts` | 96.3% (52/54) | 96.3% (52/54) | 84.6% (11/13) | 84.6% (11/13) | 85, 86 |
| `src/index.ts` | 76.4% (236/309) | 97.1% (300/309) | 40.0% (12/30) | 91.4% (53/58) | 97, 104, 244, 245, 306, 307, 350-352 |
| 合计 | 87.0% (653/751) | 96.4% (724/751) | 73.3% (85/116) | 88.0% (132/150) | - |

- 分层贡献 (两轮跑取差): 只跑单元层 行 88.1% (662/751) / 分支 75.4% (89/118); 单元加集成 行 96.4% / 分支 88.0%, 集成层贡献 62 行 / 43 个块。单元锚点自身贡献 +1.1pp 行 (87.0% → 88.1%)、+2.1pp 分支 (73.3% → 75.4%)。
- 未覆盖行的构成: 多数是注释行、类型声明行与 V8 小块区间归因 (如 `src/index.ts:350-352`、`src/edit.ts:209-212`、`src/hashline.ts:85-86` 处的分支体已被用例执行, 报告仍按零命中小块记入); 真实未覆盖只有两条, 见「skip 计数与豁免台账」。

### 用例清单

- 基线: `check` 绿; `test` 54 例全通过, `skipped` 0 / `todo` 0, 耗时约 98ms.
- 单元锚点 (3 条, 均新增, 未改既有断言语义):
  - `tests/edit.test.ts`: 「malformed: 未知变体键 / 空对象 / 三个变体键同时出现」补 `parseOp` 的变体键形状判定 (未知键、`{}`、三键)。
  - `tests/fs.test.ts`: 「目录路径 → io_error」补 `readFile` 非 `ENOENT` 分支 (EISDIR); 「写盘失败 → io_error」补 `writeFile` 失败分支 (`readHashlines` / `applyAnchoredEditsFile` 的 `io_error` 映射), 同时断原文件不变与无临时文件残留。
- 集成层 (新增 2 个文件):
  - `tests/assemble.ts`: 三个假面 (工具 / 事件 / 服务) + `captureStderr` + `makeWorkspace` (临时目录), 装配 `apply`; 两种宿主形态 `full` / `no-tools`。
  - `tests/integration/plugin.test.ts`: 18 例, 覆盖装配面 (注册名 / 参数 schema / 零事件订阅 / 零 provide / 缺 `ctx.tools` 与注册被拒的降级)、`hash_read` 与 `hash_edit` 的 canonical 值 (行号 1 基、sha256 前 8 位定值、全文哈希定值、`applied`)、`output.render` 投影 (逐字等于 `JSON.stringify(value, null, 2)`)、相对路径基准 (`config.root` 与空串回落 exec 会话 cwd)、落盘 (内容一致、目录无残留)、失败路径 (stale / out_of_range / malformed 七种形状 / not_found / not_utf8 / 入参校验)。
- 脚本: `package.json` 增 `test:integration` (跑 `tests/integration/*.test.ts`) 与 `test:coverage` (两轮目录合并 + `dev/coverage/report.mjs tmp/cov-hash-edit tmp/cov-hash-edit/report.json`)。
- 新增单元用例 3 条 (`tests/edit.test.ts` 1, `tests/fs.test.ts` 2)。
- 新增集成用例 18 条 (`tests/integration/plugin.test.ts`)。
- 新增装配器 1 个 (`tests/assemble.ts`, 不以 `.test.ts` 结尾, 不计入覆盖率)。
- 删除用例 0 条, 删除夹具 0 个.

### skip 计数与豁免台账

- 本包用例里 `skip` 0 处、`todo` 0 处 (存量与新增合计), 条件式 `skip` 只有 1 处 (写盘失败用例在 root 下跳过), 本机未触发。
- 豁免台账:

| 位置 | 缺什么 / 为什么补不了 | 触发条件 | 交给谁 |
| --- | --- | --- | --- |
| `src/fs.ts:139` `stat` 失败分支 (`io_error: stat failed`) | `readFile` 成功后对同一路径 `stat` 几乎不可能失败, 只能靠并发删除竞态构造, 不可稳定复现 | 构造不出 | 阶段 3 判断是否随改写删掉该防御分支 |
| `src/index.ts:141` `compileParameters` 的幂等分支 (入参已是顶层 object schema) | 两个工具的参数面都是 property-map, 该分支要先从 `src` 导出才能测; 本阶段不动 `src` | 参数面改成 JSON Schema 时 | 阶段 3 (代码整理) |
| `src/index.ts:377` `apply` 的 `ctx` 守卫 (缺 `ctx === null \|\| typeof ctx !== "object"`) | 阶段 2 时守卫不存在, 只会抛 `TypeError`; 2026-11-01 补丁轮已补 (告警后返回), 条目关闭 | - | 已修 (`54ac908c`); 对应用例留阶段 4 复核 |

### 四入口实跑

| 入口 | 结果 |
| --- | --- |
| `pnpm -C hash-edit run check` | 通过 (`tsc --noEmit` 无输出) |
| `pnpm -C hash-edit run test` | 57 例通过 / 0 失败 / 0 跳过 / 0 todo, 约 100ms |
| `pnpm -C hash-edit run test:integration` | 18 例通过 / 0 失败 / 0 跳过 / 0 todo, 约 91ms |
| `pnpm -C hash-edit run test:coverage` | 行 96.4% (724/751), 分支 88.0% (132/150) |
