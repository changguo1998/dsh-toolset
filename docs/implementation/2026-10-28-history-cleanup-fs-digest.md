# fs-digest 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 fs-digest 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `fs-digest` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 4 个 `.test.ts` (`digest.test.ts` / `outline.test.ts` / `prune.test.ts` / `signatures.test.ts`); 阶段 1 末 `pnpm -C fs-digest run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 89.3% (1231/1379); 分支 79.4% (363/457).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 复核 `tests/fixtures/` 的 5 个夹具, 无引用删除
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C fs-digest run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-fs-digest && mkdir -p ../tmp/cov-fs-digest && NODE_V8_COVERAGE=../tmp/cov-fs-digest node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-fs-digest tmp/cov-fs-digest/report.json
```

- 专项: 复核 `tests/fixtures/` 的 5 个夹具, 无引用删除.
- 验收: `pnpm -C fs-digest run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 fs-digest 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-fs-digest`, worktree `.worktree/03-code/fs-digest`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C fs-digest run check` 与 `pnpm -C fs-digest run test`.
- 任务:
  - `src/lsp.ts` 的上下文对象守卫收进本包入口, 只判一次.
- 验收: `pnpm -C fs-digest run check` 与 `pnpm -C fs-digest run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(fs-digest): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

阶段 4 补.

## 实现记录

- 单元锚点:
  - `tests/digest.test.ts` 的「digest 错误路径」追加 4 条: 非法 `mode` (message 列出三模式)、`depth` 非整数、`maxLines` < 2 / 非整数、`maxTokens` < 2 / 非整数.
  - 新增 `tests/index.test.ts` (3 组 4 条): 入参校验 6 种探针 (缺 path / path 非 string / path 空串 / 缺 mode / mode 非 string / mode 非枚举) 的 `invalid_option`、`mode=unknown` 与 path 回显; 可选参数类型不符时被忽略 (字符串 `depth` 取缺省 3、非数字 `maxLines` / `maxTokens` 取缺省); `language` 提示覆盖扩展名、`requireLsp` 透传; 会话 cwd 为空串 / 非字符串时回退进程 cwd.
- 集成层:
  - 新增 `tests/assemble.ts`: 假工具面 (`createToolSurface` 收集注册, 按名 `require`)、假事件面 (`createEventSurface`, 记录订阅 / `listenerCount`)、假服务面 (`createServiceSurface`, `provide` / `get` / `names`), 由 `assemble()` 拼 `apply` 并回传宿主句柄; 另给 `renderText` (args 第一、value 第二). 不以 `.test.ts` 结尾.
  - 新增 `tests/integration/plugin.test.ts` (4 组 12 条): 注册面 (`fs_digest` 单工具、`required` / `mode.enum` / `output.schema`、零事件订阅、apply 不写服务面、`config.maxBytes` 透传); `execute` canonical 值 (Markdown outline 树与块、TS signatures、pruned 全文与裁剪、七类错误面、相对路径认会话 cwd); `output.render` 投影 (三模式文案、失败文案、`undefined` / 非三模式的 JSON 兜底、80 行截断标记); 假服务面 LSP (source=lsp、提供器抛错降级与 requireLsp 原因文案).
- 脚本: `package.json` 加 `test:integration` (只跑 `tests/integration/*.test.ts`) 与 `test:coverage` (单元 + 集成两 glob, 覆盖率目录 `tmp/cov-fs-digest`, 报告落 `tmp/cov-fs-digest/report.json`).
- 专项: `tests/fixtures/` 5 个夹具全部仍被引用 (`tests/digest.test.ts` 与 `demo/main.ts`), 无删除; `skip` / `todo` 改前改后均为 0, 未新增.
- `src` 未改动.

- 阶段 3 代码整理 (分支 `history-cleanup/03-code-fs-digest`):
  - 上下文对象守卫: `fs-digest/src/lsp.ts` 的 `ctx === null || typeof ctx !== "object"` 抽成导出函数 `contextContainer(ctx)` (非对象, 含 `null` / `undefined` / 原始值 → `undefined`), 全包只剩这一处判定; `readLspSurface` 先取容器再判一次, 入口 `fs-digest/src/index.ts` 的 `apply` 先经同一函数取 `host` 再读 `tools`, 并把它交给 `digest`, 下游不再重复判类型. 判定结果不变: 非对象上下文一律视为无上下文, `digest(null, …)` 等直调路径的降级行为与改前一致.
  - 零引用导出: 按 5.2 重扫本包 55 个导出 (`src` 全量, 含入口 5 个契约符号与 `types.ts` 的对外类型), 在 `src` / `tests` / `demo` / 仓内文档里均有引用, 零引用导出 0 个, 无删除.
  - 路径注释: `src/` / `tests/` / `demo/` 文件头与正文里的包内简写路径补成仓根路径 (如 `fs-digest/src/lsp.ts`), 涉及 10 个 `src` 文件、5 个单元测试文件、`tests/assemble.ts`、`tests/integration/plugin.test.ts` 与 `demo/main.ts`; 计数注释本包没有; `README.md` 里 `index.ts → src/main.ts` 的旧描述属包文档, 留阶段 4.

## 偏差

- 阶段 2: 无 (未改 `src`; 集成层与单元层均只经公开导出与既有工具面).

- 阶段 3: 守卫收进入口后, `apply` 收到非对象上下文 (含 `null`) 由「读 `ctx.tools` 抛 `TypeError`」变为静默返回 —— 这是守卫前置的直接结果, 工具名 / 参数面 / `output.render` 投影 / 配置键 / 注入文案均未动; 现有用例不含该路径.
- 阶段 3 覆盖率: 行 91.5% (1265/1382) → 91.8% (1280/1395) 上升, 分支 80.4% (386/480) → 80.3% (388/483) 下降 0.1 个百分点. 分子 +2 (新守卫的两个三元分支均被用例走到), 分母 +3 (含 `apply` 的非对象分支未被触达): 属新增防御分支的统计口径变化, 按 4.3 在用例旁不补假用例, 记在这里.

## 测试与证据

### 四个入口 (改动后实跑)

| 命令 | 结果 |
| --- | --- |
| `pnpm -C fs-digest run check` | 通过, 无输出 (exit 0) |
| `pnpm -C fs-digest run test` | 75 通过 / 0 失败 / 0 skipped / 0 todo |
| `pnpm -C fs-digest run test:integration` | 12 通过 / 0 失败 / 0 skipped / 0 todo |
| `pnpm -C fs-digest run test:coverage` | 87 通过 / 0 失败; 行 91.5% (1265/1382), 分支 80.4% (386/480) |

改前基线: `pnpm -C fs-digest run test` 67 通过 / 0 失败 / 0 skipped / 0 todo; 行 89.3% (1234/1382), 分支 79.4% (363/457).

新增用例: 单元 8 条 (`digest.test.ts` 4 + `index.test.ts` 4), 集成 12 条; 删除 0 条. `skip` / `todo` 计数改前改后均为 0, 无豁免台账条目.

### 覆盖率 (文件 / 行 / 分支 / 未覆盖行)

改前列为只跑单元层; 改后列为单元 + 集成 (`test:coverage`).

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 | 改后未覆盖行 |
| --- | --- | --- | --- | --- | --- |
| src/digest.ts | 85.2% (144/169) | 100.0% (169/169) | 90.9% (40/44) | 100.0% (50/50) | - |
| src/index.ts | 94.0% (205/218) | 95.0% (207/218) | 85.9% (55/64) | 89.9% (62/69) | 89, 90, 116, 117, 124, 125, 136, 140, 141, 169, 170 |
| src/languages.ts | 100.0% (40/40) | 100.0% (40/40) | 100.0% (6/6) | 100.0% (6/6) | - |
| src/lsp.ts | 95.7% (45/47) | 95.7% (45/47) | 83.3% (15/18) | 80.0% (16/20) | 47, 48 |
| src/outline.ts | 90.4% (423/468) | 90.4% (423/468) | 76.1% (134/176) | 75.4% (135/179) | 28, 98, 109-111, 125-126, 131-133, 137, 146, 148-149, 154, 164, 171, 206, 248-250, 259, 262, 272-277, 290, 293, 298, 305, 361-362, 374-376, 380, 394, 459, 478, 514, 516, 529 |
| src/prune.ts | 100.0% (86/86) | 100.0% (86/86) | 91.7% (22/24) | 88.5% (23/26) | - |
| src/read.ts | 88.0% (44/50) | 88.0% (44/50) | 90.9% (10/11) | 90.9% (10/11) | 38-43 |
| src/render.ts | 89.5% (51/57) | 89.5% (51/57) | 79.2% (19/24) | 79.2% (19/24) | 20, 22-24, 59, 60 |
| src/signatures.ts | 77.9% (180/231) | 79.7% (184/231) | 68.9% (62/90) | 68.4% (65/95) | 25-47, 69-73, 88, 101, 112, 124-125, 133, 145, 172-173, 181, 184, 200, 208, 227-228, 275-277, 281-282 |
| src/types.ts | 100.0% (16/16) | 100.0% (16/16) | n/a (0/0) | n/a (0/0) | - |
| 合计 | 89.3% (1234/1382) | 91.5% (1265/1382) | 79.4% (363/457) | 80.4% (386/480) | - |

- 分层贡献: 只跑单元层改后为 91.4% (1263/1382)、分支 80.7% (380/471); 集成层补 2 行 (1263 → 1265), 分支分母从 471 变 480, 百分比降到 80.4% 是 V8 block 范围随运行组合变化所致, 同口径对比改前 79.4% 仍为升.
- 行覆盖分母稳定 (1382 全书一致), 行数只升不降 (1234 → 1265); 分支分母在两次运行间有 ±10 内波动 (V8 block 统计口径), 以百分比与改前同命令对比.
- 契约面: 错误码 7/7 被断言 (`invalid_option` / `file_not_found` / `not_a_file` / `too_large` / `binary` / `lsp_unavailable` / `unsupported_language`); `src/index.ts` 的运行时导出 (`name` / `inject` / `apply` / `digest` / `DIGEST_MODES`) 均有用例触达.
- `src/read.ts` 38-43 (stat 成功后的 `readFile` 失败) 为竞态防御分支, 测试内无法确定性复现, 按 4.3 豁免并在用例旁不写假用例; 其余未覆盖行多为多行表达式 / 正则 / 三元续行在 V8 行映射上的归属偏移, 非行为缺口.

### 阶段 3 代码整理 (改动后实跑)

| 命令 | 结果 |
| --- | --- |
| `pnpm -C fs-digest run check` | 通过, 无输出 (exit 0) |
| `pnpm -C fs-digest run test` | 75 通过 / 0 失败 / 0 skipped / 0 todo |
| `pnpm -C fs-digest run test:integration` | 12 通过 / 0 失败 / 0 skipped / 0 todo |
| `pnpm -C fs-digest run test:coverage` | 87 通过 / 0 失败; 行 91.8% (1280/1395), 分支 80.3% (388/483) |

用例文件只改了文件头与正文的路径注释, 断言一条未改; 未新增 / 删除用例. 未覆盖行集合与阶段 2 表同构, 只是行号顺移 (`fs-digest/src/index.ts` 的 165 / 177 对应阶段 2 的 169 / 170 一类注释行与括号行); 分支分母的 +3 来自 `contextContainer` 的三元 (两个分支均被走到) 与 `apply` 的非对象上下文分支 (未被触达), `fs-digest/src/lsp.ts` 的行覆盖率 95.7% → 100.0%.
