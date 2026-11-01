# output-compress 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 output-compress 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `output-compress` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 5 个 `.test.ts` (`deny-parity.test.ts` / `digest-db.test.ts` / `hooks.test.ts` / `summary.test.ts` / `trigger.test.ts`); 阶段 1 末 `pnpm -C output-compress run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 89.6% (1315/1467); 分支 76.7% (211/275).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C output-compress run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-output-compress && mkdir -p ../tmp/cov-output-compress && NODE_V8_COVERAGE=../tmp/cov-output-compress node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-output-compress tmp/cov-output-compress/report.json
```

- 专项: -.
- 验收: `pnpm -C output-compress run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 output-compress 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-output-compress`, worktree `.worktree/03-code/output-compress`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C output-compress run check` 与 `pnpm -C output-compress run test`.
- 任务:
  - 删失效类型 `src/digest-db.ts:53` `DigestPutOutcome`.
- 验收: `pnpm -C output-compress run check` 与 `pnpm -C output-compress run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(output-compress): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

阶段 4 补.

## 实现记录

2026-10-28 在分支 `history-cleanup/02-tests-output-compress` 完成, 未改 `src`.

- 基线: `pnpm -C output-compress run test` 57 条通过 (1900 ms), `check` 通过; 覆盖率行 89.6% (1315/1467)、分支 76.7% (211/275).
- 单元锚点 (57 → 75 条, 现有断言未改语义):
  - 新增 `tests/sandbox.test.ts` 6 条: 宿主沙箱请求形状 (`resolve` 先于 `run`、程序源/绑定/超时)、服务交互失败转 `RuntimeUnavailableError`、程序级失败不转、返回值 round-trip 归一 (`undefined` / 不可序列化 / 结构不合法各一档)、`RuntimeWithFallback` 的回落与不回落.
  - `tests/digest-db.test.ts` 追加 3 条: 异指纹 / 版本不符 / 空库版本异常都拒开且不建表, `searchDigests` 的 FTS 语法错误回落 LIKE 与通配符转义、`limit` 钳位, `readDigest` 未命中与 `pruneDigests` 的空表收尾.
  - `tests/trigger.test.ts` 追加 2 条: 宽松通知 (宿主文案演进、缺 `retrievalHint`) 仍解析 locator, locator 剥空后按未触发处理.
  - `tests/hooks.test.ts` 追加 7 条: `extractText` 六种载荷形态、沙箱普通错误转 `compress-failed`、digest.db 打开失败只告警一次、`sessionDirFor` 返回空路径、句柄写入返回空 `ids` 记 rejected、`attach` 宿主回非函数时 `detach` 幂等、凭据形态被底线闸拦下后不入库不推送.
- 集成层: 新增 `tests/assemble.ts` (假工具面 + 假事件面 + 假服务面拼 `apply`, 末缀不是 `.test.ts`) 与 `tests/integration/plugin.test.ts` 10 条: 订阅面与零工具注册、`registerKind` 的 canonical 入参、启动日志三要素、spill 通知按全文派生的 digest 行 canonical 列值与 `sha256` 去重键、FTS / LIKE 两路检索与 `referenced_at` 刷新、preview 投影的三段结构与 600 字符截断、spill 来源的 locator / retrieval / truncated 标注、`is_error` 行的 `put` 入参 (`tier` / `sessionId` / `importance` / `source`) 与 `push_state`、句柄缺失后巩固重推的补推与幂等、`dispose` 反订阅、`sessionPaths` 缺席的跳过与告警、事件形状的静默跳过. 落盘全部在 `os.tmpdir()` 的临时目录, 用后删除.
- 脚本: `package.json` 加 `test:integration` (`tests/integration/*.test.ts`) 与 `test:coverage` (命令按本文件「测试」节, 参数 `tmp/cov-output-compress`).

### 阶段 3 代码整理

- 删失效导出 `DigestPutOutcome` (`src/digest-db.ts:53`): 全仓无引用, 只声明未使用; 行为不变.
- 其余规划项 (无) 不涉及.

## 偏差

- 任务书里的「断言大输出入库工具的注册、canonical 值与 `output.render` 投影」在本包没有直接对应面: 本包不注册工具, 也不产出 `output.render` (它只订阅 `session/event` 的 `tool/result`). 按 4.2 的集成层本义 (插件的 `apply` 与宿主接线), 这三项落到等价位置: 工具面断「零注册」这条边界; canonical 值断 digest 行的列值与句柄 `put` 的入参; 「投影」断 `renderSummaryRecord` 的确定性 markdown (落库为 `preview`, 推送为 `content`). 未简化成只断返回值.
- 分支分母从 275 增到 305: 新用例执行到此前从未执行的函数, 覆盖率聚合的 block 计数随之增加, 不是新增的 `src` 分支 (`src` 未改). 行分母 1467 未变, 行覆盖 89.6% → 94.7%、分支覆盖 76.7% → 85.2%, 均上升.
- 未覆盖行集中在类型声明与注释行 (V8 按 range 计行, 这些行没有可执行语句) 与少数防御分支 (如 `registerKind` 返回非对象、宿主 `reflect.get` 缺省); 按 4.3 不设阈值、不为数字补用例, 明细见 `tmp/cov-output-compress/report.json`.

## 测试与证据

### 阶段 3 实跑

| 命令 | 结果 |
| --- | --- |
| `pnpm -C output-compress run check` | 通过 (`tsc --noEmit`, 无输出) |
| `pnpm -C output-compress run test` | 75 条通过, 失败 0 |

四条命令 (分支 `history-cleanup/02-tests-output-compress`, 提交 `test: 补 output-compress 测试锚定` 前的实跑):

| 命令 | 结果 |
| --- | --- |
| `pnpm -C output-compress run check` | ✓ 通过 (`tsc -p tsconfig.json --noEmit`, 无输出) |
| `pnpm -C output-compress run test` | ✓ 75 条通过, 失败 0, skipped 0, todo 0 (1889 ms) |
| `pnpm -C output-compress run test:integration` | ✓ 10 条通过, 失败 0, skipped 0, todo 0 (802 ms) |
| `pnpm -C output-compress run test:coverage` | ✓ 两轮跑全通过, 产出 `tmp/cov-output-compress/report.json` 与每包表 |

覆盖率 (只统 `src`, 改前 = 本分支动手前的单元层, 改后 = 单元层加集成层):

| 文件 | 行 (改前) | 分支 (改前) | 行 (改后) | 分支 (改后) |
| --- | --- | --- | --- | --- |
| `output-compress/src/deny-patterns.ts` | 100.0% (32/32) | 100.0% (3/3) | 100.0% (32/32) | 100.0% (3/3) |
| `output-compress/src/digest-db.ts` | 93.7% (311/332) | 65.7% (23/35) | 98.5% (327/332) | 89.7% (35/39) |
| `output-compress/src/hooks.ts` | 82.4% (455/552) | 72.5% (95/131) | 90.4% (499/552) | 80.4% (119/148) |
| `output-compress/src/index.ts` | 91.5% (182/199) | 90.7% (49/54) | 94.5% (188/199) | 92.7% (51/55) |
| `output-compress/src/render.ts` | 93.9% (62/66) | 81.8% (9/11) | 98.5% (65/66) | 91.7% (11/12) |
| `output-compress/src/sandbox.ts` | 91.3% (95/104) | 61.5% (8/13) | 95.2% (99/104) | 77.8% (14/18) |
| `output-compress/src/summary-program.ts` | 100.0% (132/132) | 100.0% (13/13) | 100.0% (132/132) | 100.0% (13/13) |
| `output-compress/src/trigger.ts` | 92.0% (46/50) | 73.3% (11/15) | 94.0% (47/50) | 82.4% (14/17) |
| 合计 | 89.6% (1315/1467) | 76.7% (211/275) | 94.7% (1389/1467) | 85.2% (260/305) |

- 分层贡献 (4.3 两轮取差): 只跑单元层为 93.8% (1376/1467) 行、84.0% (246/293) 分支; 单元层加集成层为 94.7% (1389/1467)、85.2% (260/305), 集成层贡献 +13 行、+14 分支 (分母同步增加, 因为集成层执行到此前未执行的函数).
- 行与分支均未下降; 无删除代码.
- 4.4 复核: 本包 `skip` 0 处、`todo` 0 处、无 `tests/fixtures/`, 无处置项; 新用例标题均为中文短句、不含宿主版本号. 集成层等落库用 20 ms 轮询、上限 4 s (真库落盘, 非真实时钟依赖).
