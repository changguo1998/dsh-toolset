# 缺省状态目录尊重 DSH_HOME（接取条目：metric-loop/docs/BACKLOG.md「缺省状态目录忽略 `DSH_HOME`, e2e 会写进真实 home」）

状态：关闭　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. `defaultStateDir()`（`src/index.ts:98-103`）的优先级改为 `METRIC_LOOP_STATE_DIR` > `<DSH_HOME>/metric-loop` > `~/.dsh/metric-loop`, 空值视同未设。
2. 与 `rule-engine/src/persist.ts`、`session-paths/src/index.ts` 的 home 口径一致, 不再只看 `os.homedir()`。
3. 补一条环境变量优先级单测（含空 `DSH_HOME` 视同未设）; 本包 `check` / `build` / `test` 全绿, 缺省路径纯读不写盘。

## 调研

- 现状代码: `src/index.ts:98-103` 返回 `METRIC_LOOP_STATE_DIR ?? path.join(homedir(), ".dsh", "metric-loop")`; 调用点 `src/index.ts:636` / `:687` 均为 `config?.stateDir ?? defaultStateDir()`。
- 参照实现: `rule-engine/src/persist.ts:30-38`（2026-11-08 已提交的修法）与 `session-paths/src/index.ts` 的 `resolveRoot` 口径——`DSH_HOME` 优先、空值视同未设、最后回落 `~/.dsh`。
- e2e 现状: `e2e/metric-loop.test.ts:7-10` 在 profile patch 里显式写 `stateDir: "<临时 home>/metric-loop"`; `bootPackage` 只隔离 `DSH_HOME`（`e2e/harness.ts:113,144`）。故本包 e2e **不经过**缺省路径, 原条目「e2e 会写进真实 home」的表述不成立（已在 BACKLOG 更正）。
- 复核证据: 本机 `~/.dsh/metric-loop` 为空目录（`ls -la` 无文件, 目录创建于 2026-10-02）; 单测 / 集成用例均显式传 `stateDir`（`tests/controller.test.ts:41`、`tests/integration/plugin.test.ts:30-46`）。
- 仍存在的风险: 任何未传 `stateDir` 的宿主嵌入（将来的 e2e 简化写法、smoke、第三方 profile 缺省挂载）都会落到用户真实 `~/.dsh/metric-loop`; 与同仓其它插件口径不一致, 排查时容易误判。

## 决策

1. 是否修: a 仍修, 只对齐 home 口径 / b 不修, 只改条目描述并关闭。
   选定 a —— 改动约 10 行 + 1 例单测, 与 `rule-engine` 的修法同构; 风险虽已由 e2e 显式 `stateDir` 掩盖, 但缺省路径仍是真实用户目录, 口径不一致会在下次「简化 e2e」时复现同类污染。
2. 函数位置: a 函数留在 `src/index.ts`, 只改优先级 / b 函数移入 `src/persist.ts`（与 rule-engine 同构）, 单测归位 `tests/persist.test.ts`。
   选定 b（2026-11-08 用户批准）—— 按结构分工: `src/persist.ts:1-34` 已是持久化层（状态文件路径 / 读写 / schema 版本）, 「状态目录从哪来」属同一职责; `index.ts` 是装配层（Config / `apply` / 工具注册）, 让缺省目录解析留在入口与 `rule-engine/src/persist.ts:30` 的同名函数分居两层。`background-daemon/src/main.ts:139` 放 main 是因为该包没有 persist 层, 不构成反例。
   （此条先按 a 记录, 经用户指出「符合项目结构设计规范」后改判为 b。）
3. 空值口径: 与 `rule-engine` 一致 —— 空字符串视同未设（`typeof === "string" && length > 0`）。

## 规划

- 计划改动文件清单:
  - `metric-loop/src/index.ts`（移出 `defaultStateDir()`, 改从 `./persist.ts` 导入并继续 re-export; `Config.stateDir` 注释同步）
  - `metric-loop/src/persist.ts`（新增 `defaultStateDir()`: 环境变量 > `<DSH_HOME>/metric-loop` > `~/.dsh/metric-loop`, 空值视同未设）
  - `metric-loop/tests/persist.test.ts`（新增一例: 显式环境变量 > `<DSH_HOME>/metric-loop` > `~/.dsh/metric-loop`, 空值视同未设, 全程纯读不写盘, try/finally 还原环境变量）
  - `metric-loop/README.md:56`（配置表 `stateDir` 默认值一栏同步优先级）
- 明确不做: 不做持久化层之外的结构调整、不改 e2e 用例、不动其他包、不改 smoke 脚本。
- 验证: `pnpm -C metric-loop run check` / `build` / `test` / `test:integration`; 根 `pnpm run check:docs`。

## 实现记录

- 2026-11-08: `defaultStateDir()` 移入 `src/persist.ts`（决策 2 = b）, 优先级改为 `METRIC_LOOP_STATE_DIR` > `<DSH_HOME>/metric-loop` > `~/.dsh/metric-loop`, 空值视同未设; `src/index.ts` 删除本地实现与 `node:os` / `node:path` 导入, 改为从 `./persist.ts` 导入并继续 re-export（公共 API 不变）。
- 2026-11-08: `Config.stateDir` 注释、`metric-loop/README.md:56` 配置表默认值同步新优先级。

## 测试与证据

- `pnpm -C metric-loop run check`: 通过（`tsc -p tsconfig.json --noEmit` 无输出）。
- `pnpm -C metric-loop run build`: 通过。
- `pnpm -C metric-loop run test`: 57 pass / 0 fail（含新增 `defaultStateDir：METRIC_LOOP_STATE_DIR > DSH_HOME > ~/.dsh/metric-loop（纯读，不写盘）`）。
- `pnpm -C metric-loop run test:integration`: 17 pass / 0 fail。
- `pnpm run check:docs`: 119 篇现行 Markdown / 957 个 .ts, 错误 0 / 警告 0。
- 未跑 e2e: 本改动不触及 e2e 路径（用例显式传 `stateDir`）。
- 真实 home 复核: `ls -la ~/.dsh/metric-loop` 仍为空目录, 未新增文件。

## 收尾

- BACKLOG 条目已移除（`metric-loop/docs/BACKLOG.md` 现无未完成项）, 本文件移入 `metric-loop/docs/archived/`。
- 回写: `metric-loop/src/index.ts`（re-export 与 `Config.stateDir` 注释）、`metric-loop/README.md` 配置表; 本包为轻量包, 无 DESIGN / ROADMAP 需回写。
- 提交: `fix(metric-loop): 缺省状态目录尊重 DSH_HOME`（代码 + 单测 + README + 追踪文档）。
- 遗留: 无。
