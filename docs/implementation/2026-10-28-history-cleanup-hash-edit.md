# hash-edit 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

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

阶段 4 补.

## 实现记录

日期: 2026-11-01. 分支 `history-cleanup/02-tests-hash-edit`.

- 基线 (改动前, 本分支): `check` 绿; `test` 54 例全通过, `skipped` 0 / `todo` 0, 耗时约 98ms; 覆盖率行 87.0% (653/751), 分支 73.3% (85/116).
- 单元锚点 (3 条, 均新增, 未改既有断言语义):
  - `tests/edit.test.ts`: 「malformed: 未知变体键 / 空对象 / 三个变体键同时出现」补 `parseOp` 的变体键形状判定 (未知键、`{}`、三键)。
  - `tests/fs.test.ts`: 「目录路径 → io_error」补 `readFile` 非 `ENOENT` 分支 (EISDIR); 「写盘失败 → io_error」补 `writeFile` 失败分支 (`readHashlines` / `applyAnchoredEditsFile` 的 `io_error` 映射), 同时断原文件不变与无临时文件残留。
- 集成层 (新增 2 个文件):
  - `tests/assemble.ts`: 三个假面 (工具 / 事件 / 服务) + `captureStderr` + `makeWorkspace` (临时目录), 装配 `apply`; 两种宿主形态 `full` / `no-tools`。
  - `tests/integration/plugin.test.ts`: 18 例, 覆盖装配面 (注册名 / 参数 schema / 零事件订阅 / 零 provide / 缺 `ctx.tools` 与注册被拒的降级)、`hash_read` 与 `hash_edit` 的 canonical 值 (行号 1 基、sha256 前 8 位定值、全文哈希定值、`applied`)、`output.render` 投影 (逐字等于 `JSON.stringify(value, null, 2)`)、相对路径基准 (`config.root` 与空串回落 exec 会话 cwd)、落盘 (内容一致、目录无残留)、失败路径 (stale / out_of_range / malformed 七种形状 / not_found / not_utf8 / 入参校验)。
- 脚本: `package.json` 增 `test:integration` (跑 `tests/integration/*.test.ts`) 与 `test:coverage` (两轮目录合并 + `dev/coverage/report.mjs tmp/cov-hash-edit tmp/cov-hash-edit/report.json`)。
- 未改 `src`; 用例只经 `src/index.ts` 与同包模块的公开导出。

## 偏差

1. 集成层装配形态收窄为 `full` / `no-tools` 两种, 计划里的「空 `ctx`」未做: `apply` 没有 `ctx === null || typeof ctx !== "object"` 守卫, 传 `undefined` 会抛 `TypeError: Cannot read properties of undefined (reading 'tools')` (实测), 补守卫属 `src` 改动, 本阶段不动; 已在 `hash-edit/docs/BACKLOG.md` 登记 `#1` 并进下方豁免台账。同类判断散落见总追踪调研 1.8「上下文对象守卫」(15 个包), 统一收口留阶段 3。

## 测试与证据

### 命令实跑 (2026-11-01, 本分支)

| 命令 | 结果 |
| --- | --- |
| `pnpm -C hash-edit run check` | 通过 (`tsc --noEmit` 无输出) |
| `pnpm -C hash-edit run test` | 57 例通过 / 0 失败 / 0 跳过 / 0 todo, 约 100ms |
| `pnpm -C hash-edit run test:integration` | 18 例通过 / 0 失败 / 0 跳过 / 0 todo, 约 91ms |
| `pnpm -C hash-edit run test:coverage` | 行 96.4% (724/751), 分支 88.0% (132/150) |

### 覆盖率 (改前 / 改后)

| 文件 | 行 (改前) | 行 (改后) | 分支 (改前) | 分支 (改后) | 未覆盖行 (改后) |
| --- | --- | --- | --- | --- | --- |
| `src/edit.ts` | 96.6% (257/266) | 96.6% (257/266) | 88.7% (47/53) | 88.9% (48/54) | 55, 165-169, 209, 210, 212 |
| `src/fs.ts` | 88.5% (108/122) | 94.3% (115/122) | 75.0% (15/20) | 80.0% (20/25) | 47, 66, 101, 119, 120, 139, 148 |
| `src/hashline.ts` | 96.3% (52/54) | 96.3% (52/54) | 84.6% (11/13) | 84.6% (11/13) | 85, 86 |
| `src/index.ts` | 76.4% (236/309) | 97.1% (300/309) | 40.0% (12/30) | 91.4% (53/58) | 97, 104, 244, 245, 306, 307, 350-352 |
| 合计 | 87.0% (653/751) | 96.4% (724/751) | 73.3% (85/116) | 88.0% (132/150) | - |

分层贡献 (两轮跑取差): 只跑单元层 行 88.1% (662/751) / 分支 75.4% (89/118); 单元加集成 行 96.4% / 分支 88.0%, 集成层贡献 62 行 / 43 个块。单元锚点自身贡献 +1.1pp 行 (87.0% → 88.1%)、+2.1pp 分支 (73.3% → 75.4%)。

未覆盖行的构成: 多数是注释行、类型声明行与 V8 小块区间归因 (如 `src/index.ts:350-352`、`src/edit.ts:209-212`、`src/hashline.ts:85-86` 处的分支体已被用例执行, 报告仍按零命中小块记入); 真实未覆盖只有两条, 见下「豁免台账」。

### 用例清单

- 新增单元用例 3 条 (`tests/edit.test.ts` 1, `tests/fs.test.ts` 2)。
- 新增集成用例 18 条 (`tests/integration/plugin.test.ts`)。
- 新增装配器 1 个 (`tests/assemble.ts`, 不以 `.test.ts` 结尾, 不计入覆盖率)。
- 删除用例 0 条, 删除夹具 0 个; 本包用例里 `skip` 0 处、`todo` 0 处 (存量与新增合计), 条件式 `skip` 只有 1 处 (写盘失败用例在 root 下跳过), 本机未触发。

### 豁免台账

| 位置 | 缺什么 / 为什么补不了 | 触发条件 | 交给谁 |
| --- | --- | --- | --- |
| `src/fs.ts:139` `stat` 失败分支 (`io_error: stat failed`) | `readFile` 成功后对同一路径 `stat` 几乎不可能失败, 只能靠并发删除竞态构造, 不可稳定复现 | 构造不出 | 阶段 3 判断是否随改写删掉该防御分支 |
| `src/index.ts:141` `compileParameters` 的幂等分支 (入参已是顶层 object schema) | 两个工具的参数面都是 property-map, 该分支要先从 `src` 导出才能测; 本阶段不动 `src` | 参数面改成 JSON Schema 时 | 阶段 3 (代码整理) |
| `src/index.ts:373` `apply` 的 `ctx` 守卫 (缺 `ctx === null \|\| typeof ctx !== "object"`) | 守卫不存在, 只会抛 `TypeError`, 没有可断言的降级行为; 补守卫属 `src` 改动 | 缺守卫的包共 15 个 (调研 1.8) | 阶段 3; 已在 `hash-edit/docs/BACKLOG.md` 登记 `#1` |
