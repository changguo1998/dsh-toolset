# 代码整理（阶段 3，所属总追踪：`docs/implementation/2026-10-28-history-cleanup.md`）

状态：完成　　开启：2026-10-28　　关闭：2026-10-28
本文件是阶段 3 的阶段追踪文档，记录范围、波次、门禁与合并结论；逐包细节见 34 份包追踪文档。分支 agent 不改本文件。

## 目标

按总追踪第 5 章的五步整理 24 个有代码改动的包：删失效导出、定时器族并入 `clock-base`、按职责拆超长文件、收拢散落判断、改本包注释；行为不变（工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动）。另 10 个包无代码改动，不建分支。

## 范围

- 建分支的 24 个包：`TUI`、`agent-group`、`ast-tools`、`auto-approve`、`background-daemon`、`clock-base`、`coagent`、`code-map`、`command-template`、`fs-digest`、`goal-contract`、`hash-edit`、`herdr-integration`、`herdr-use`、`md-map`、`memory-base`、`output-compress`、`preference-analysis`、`rule-engine`、`script-interpreter`、`security-guard`、`session-channel`、`session-paths`、`task-engine`。
- 不建分支的 10 个包：`behavior-correction`、`context-report`、`escalation-hint`、`md-logic`、`md-table-check`、`metric-loop`、`ponytail`、`session-title-cutoff`、`symbol-normalizer`、`tool-consult`。
- 分支 `history-cleanup/03-code-<包>`，worktree `.worktree/03-code/<包>`；`TUI` 用 `-tui` 后缀。

## 波次

1. 第一波（基础包，先行合并）：`clock-base`（接收定时器族）、`herdr-use`（沙箱枚举持有者）、`memory-base`（记忆层级持有者）。
2. 第二波（依赖包，从新 `main` 开）：`agent-group`、`ast-tools`、`auto-approve`、`command-template`、`herdr-integration`、`rule-engine`、`script-interpreter`、`session-channel`、`task-engine`（均需 `clock-base` 已合并；`script-interpreter` 另需 `herdr-use`）。
3. 第三波（独立包，可与第二波并行）：`TUI`、`background-daemon`、`coagent`、`code-map`、`fs-digest`、`goal-contract`、`hash-edit`、`md-map`、`output-compress`、`preference-analysis`、`security-guard`、`session-paths`。
4. 并发数 2 至 4：coagent 上限 4；出现 `TRANSPORT 422` 时降到 2。

## 门禁

每包按同一套收尾：

1. 分支内跑 `pnpm -C <包> run check` 与 `pnpm -C <包> run test`；`TUI` 另跑 `demo -- --smoke`。
2. 提交（`refactor(<包>): <动作>`），包追踪文档追加「实现记录 / 偏差」，与代码同一批提交。
3. `rebase main` 后复跑上述命令；`git merge --no-ff` 合并回 `main`。
4. `git worktree remove` 删除 worktree，关 coagent，分支保留到总任务关闭。

全部合并后跑全量 `pnpm run check` / `build` / `test` 与 `test:coverage`，再写本文件「实现记录」与总追踪。

## 实现记录

- 2026-10-28 第一波合并: `clock-base` (`1df62e2a`, 合并提交 `7265223a`, 新增 12 个导出与 2 例), `memory-base` (`a54ad8dd`, 合并提交 `3d04c043`, 层级谓词 `isSessionTier`).
- 2026-10-28 随后合并: `herdr-use` (`4ba3a88e`, 合并提交 `64518eaf`), `ast-tools` (`d9737d19`, 合并提交 `1b394081`), `coagent` (`e8dd3d0f`, 合并提交 `289fb72e`), `md-map` (`68aa15ea`, 合并提交 `d2215a91`), `output-compress` (`5d454153`, 合并提交 `333cea11`), `goal-contract` (`e616a5ec`).
- 进行中: `TUI` 第二批 (拆长文件), `auto-approve`, `command-template`; 每包合并后在此追加一行.
- `herdr-integration` (`7b9ac9f6`) 已合并 `9ff3fa4b`: 删 `src/timers.ts`, 定时器族改用 `clock-base`; `check` / 60 例测试 / 11 例集成通过.
- `auto-approve` (`21816988` / `a1a32004`) 已合并 `70cd64f3`: 删 `AuditRecent` / `allowedByRisk` / `RuleInput` 与 `src/timers.ts`, `learn.ts` 1222 行拆成 `learn-rules.ts` 505 / `learn-observe.ts` 716 / `learn-decide.ts` 25; `check` / 181 例测试 / `build` 通过.
- `command-template` (`c1ae3ad5`) 已合并 `adb9f44c`: 删 `src/timers.ts`、`declaredModels`、`availableProviders`, 定时器族改用 `clock-base`; `check` / 48 例测试 / 12 例集成 / `build` 通过. 告警文案差异记入包追踪「偏差」.
- `preference-analysis` (`d7e5bd9c`) 已合并 `89d7b5b4`: 守卫收进入口, `tools.ts:97` 计数注释改指 `TOOL_NAMES`, 入口 4 处路径注释补全; `check` / 98 例测试 / 11 例集成通过.
- `fs-digest` (`b45807d5` / `cefe850e`) 已合并 `9216210c`: 守卫收进入口一处判定, 注释路径补全; 首笔曾把 `apply` 非对象上下文由抛错改成静默返回, 已按「行为不变」改回抛错再合并; `check` / 75 例测试 / 12 例集成通过, 覆盖率 91.8% / 80.3%.
- `agent-group` (`e5be0b08` / `2eeb6ad2` / `c040e36b`) 已合并 `f7183d4d`: `core.ts` 1250 行删成 `service.ts` 421 / `instruction.ts` 300 / `link.ts` 252 / `group.ts` 219 / `member.ts` 183 / `action-host.ts` 64 / `config.ts` 52 / `errors.ts` 8, 定时器族改用 `clock-base`; `check` / 108 例测试 / 13 例集成通过.
- `hash-edit` (`99b7bd09`) 已合并 `81c41134`: 计数注释去数字, 补 5 处路径 / 标题注释; `check` / 57 例测试 / 18 例集成 / `build` 通过.
- `code-map` (`27419775`) 已合并 `8bfe9272`: 上下文守卫收进入口; `check` / 测试通过 (需先建 `ast-tools` 依赖).
- `TUI` 收尾记录 (`51213f4f`) 已合并 `a5199284`; `TUI` 代码整理完成 (剩 `dsh.ts` 3603 / `index.ts` 6497 行, 偏差见包追踪).
- `TUI` 收尾拆分 (`14ca3530`) 已合并 `876c7bce`: 审批链 tool/call 登记表拆成 `adapter/approval-tool-calls.ts` 60 行; `dsh.ts` 3639 → 3603. 决定停在按可独立搬移的职责拆完这一步: 剩余 `dsh.ts` 3603 行与 `index.ts` 6497 行为有状态类, 继续拆需上下文对象重构, 记入包追踪「偏差」留后续条目.
- `background-daemon` (`809f96f8` / `8a010c3d`) 已合并 `e3600c38`: 删 `Subcommand` 与 `daysBetween`, 上下文守卫收进入口; `check` / 测试通过.
- `security-guard` (`4d4cfd65` / `1c1b8817`) 已合并 `4919cfcc`: `index.ts` 1378 行拆成 `tool-registry.ts` 270 / `arg-scan.ts` 243 / `config.ts` 202 / `engine.ts` 450 / `receipt.ts` 190 / 入口 176; 新旧 `dist` 26 个导出名与 11 组 `inspect` 回执逐字一致; `check` / 160 例测试 / 14 例集成通过, 覆盖率 99.1% / 94.1%.
- `task-engine` (`4aa5cb19` / `8d226a64` / `1a0777d4`) 已合并 `2ab7b760`: 删 `src/timers.ts`, `index.ts` 1867 行拆成 10 个文件 (入口仅 36 行 re-export), `engine.ts` 1050 → 622 并拆出 flow / types / store; `check` / 171 例测试 / 17 例集成 / `build` 通过. 集成层首跑 1 例既有 flake 重跑通过; `demo` 1 例 overBudget 既有失败 (拆前同样失败).
- `TUI` 第二批 `adapter/types.ts` 与 `index.ts` 第一批 (`8aa769b4` / `001c3f1b` + 两笔文档) 已合并 `f1ca5d2b`: 类型域模块与装配面 / 滚动助手拆出; `index.ts` 6601 → 6497, `adapter/dsh.ts` 4647 → 3639, `state.ts` / `layout.ts` / `adapter/types.ts` 降到 95 / 132 / 128 行; `check` / 1828 例测试 / `build` / 42 条 `SMOKE_PASS` 通过.
- `session-channel` (`ed3112a4` / `e5c71570` / `caf3793b` / `c5b681e3` / `3bda5b2e`) 已合并 `e9c7e3d5`: 删 5 个失效导出, 定时器族改用 `clock-base`, `index.ts` 1929 行拆成 `index.ts` 161 / `service.ts` 1055 / `task-layer.ts` 471 / `tools.ts` 404; `check` / 78 例测试 / 9 例集成 / `build` 通过.
- `TUI` 第二批 `adapter/dsh.ts` 拆分 (`28ae0e45` / `c71c2b3b`) 已合并 `4fabdbd5`: 辅助层拆出, 对外可见集合不变; `check` / 1828 例测试 / `build` / 42 条 `SMOKE_PASS` 通过.
- `TUI` 第二批 `state.ts` 拆分 (`35bfcf90` / `5908bc22`) 已合并 `9c90a600`: 3379 行拆成分层模块, 对外可见集合不变; `check` / 1828 例测试 / `build` / 42 条 `SMOKE_PASS` 通过.
- `script-interpreter` (`ae55f5d7` / `4eb82a0e`) 已合并 `710a35eb`: 删 `src/timers.ts`, 沙箱类型改从 `herdr-use` 入口引; `check` / 117 例测试 / 14 例集成 / `build` 通过.
- `herdr-use` 补丁 (`11571ed8`) 已合并 `d8312816`: 入口增加 `SandboxMode` 类型导出, 供 `script-interpreter` 从入口引而不是走 `dist` 深路径; `check` / 143 例测试通过.
- `rule-engine` (`d30fc86a` / `13b75663` / `d88239a2`) 已合并 `776394ba`: 删 `src/timers.ts`, `engine.ts` 1260 行拆成 `engine.ts` 593 / `consumers.ts` 477 / `engine-state.ts` 185 / `evaluation.ts` 136 / `delivery.ts` 115; `check` / 175 例测试 / 13 例集成 / `build` 通过.
- `TUI` 第二批 `layout.ts` 拆分 (`a7986664` / `2db2f0d0`) 已合并 `12363ed6`: 2440 行拆成 `layout/geometry.ts` / `layout/frame-build.ts` / `layout/frame-rows.ts` 等分层模块, 对外可见集合不变; `check` / 1828 例测试 / `build` / 42 条 `SMOKE_PASS` + `SMOKE_OK` 通过.
- `TUI` 第一批 (`7f326518` / `f7652029` / `5f46146a`) 已合并 `8b1ede1a`: 删 3 个零引用导出, 按键表 75 条键位 / 51 个动作, `name ===` 从 72 处降到 31 处, 消息谓词 21 处、层级判定 4 处、注释路径 32 处; `check` / `test` 1828 例 / `build` / `demo --smoke` 通过.
- 收口: 24 个有代码改动的包全部合并 (`TUI` 分 6 批, 其余一包一笔到数笔), 10 个无代码改动的包未建分支; 24 个 `history-cleanup/03-code-*` 分支保留到总任务关闭, worktree 全部删除.
- 2026-11-01 补丁轮 (阶段关闭后修潜伏项): `hash-edit` / `md-map` 的 `apply` 补非对象 `ctx` 守卫; `tool-consult` 的 `isVisible` 按 `maskMode` 解释 `initialNames`; 11 个包的 `logger` 调用补可选链; `code-map` / `md-map` / `session-channel` 的 `warn` 改显式分支; 8 个包的假 `exclude` 删除、`task-engine` 双 program 合并为一个 (同时删 `tests/tsconfig.json`); `TUI` 两处长文件拆分登记为包 BACKLOG 条目. 提交 `54ac908c` / `78500945` / `25fce711` 与本笔文档.

## 测试与证据

全量在 `main` 上实跑 (`e8ff096d` 之后, 依赖包先 `pnpm install --frozen-lockfile`):

| 命令 | 结果 |
| --- | --- |
| `pnpm run build` | 退出 0, 34 包编译到 `dist/` |
| `pnpm run check` | 退出 0, 无 error |
| `pnpm run test` | 退出 0, 34 包并行无失败 |
| `pnpm run test:coverage` | 退出 0; 行 87.7% (70114/79945), 分支 80.1% (16404/20491) |
| `pnpm -C TUI run demo:build -- --smoke` | 42 条 `SMOKE_PASS`, 退出 0 |
| `pnpm -C TUI run smoke:pty` | 未跑, 缺 `TOLLGATE_API_KEY` (与阶段 2 同) |

覆盖率口径与阶段 2 相同: `report.mjs` 不排 `dist`, 依赖包的 `dist` 会随引用被计入, 故数字只与同一命令的结果果比较. 阶段 2 为 86.4% / 79.9%.

2026-11-01 补丁后复跑: 17 个受影响包逐个 `check` + `test` 通过; 全量 `pnpm run build` / `check` / `test` 均退出 0. 补丁只动守卫、日志兜底与 `tsconfig`, 未重跑覆盖率.

## 偏差

- 总追踪 5.1 写「不改注释里的路径与计数（第 6 章）」，但「计划改动文件清单」第 3 节逐包列了注释项；按清单执行，注释项并入本阶段，阶段 5 只做项目级文档与其余注释。
- 清单 `session-channel` 一处写「`src/keys.ts` 的 3 个符号」，按 5.2 实为 4 个（`STATE_PATTERN`、`TASK_INDEX_PATTERN`、`sessionIdFromStateKey`、`sessionIdFromTaskIndexKey`）；实现按 4 个执行。
- 并发与传输: 3 个分支 agent 首轮均遇 `TRANSPORT 422 terminated`（5 次重试后中断），经 `session_channel send` 续跑恢复；`auto-approve` / `command-template` 首轮无产出。与阶段 2 同类，未再降并发（3 个），续跑后稳定。
- `TUI` 长文件只拆到「可独立搬移的职责」: `dsh.ts` 3603 行与 `index.ts` 6497 行是有状态类 (`DshAdapter` / `App`), 继续拆需上下文对象重构, 本轮停手, 记入包追踪「偏差」, 后续单独立条目.
- `fs-digest` 首笔把 `apply` 收非对象上下文由抛错改成静默返回, 属行为变化, 已改回抛错再合并 (提交 `cefe850e`).
- `task-engine` 的 `demo` 有 1 例 `overBudget` 既有失败 (拆前同样失败, 与引擎「只认宿主 max-tokens 信号」口径不一致), 未改.
- `agent-group` 任务书写「`src/index.ts` 内联 `systemTimers`」, 实际在 `core.ts` (随拆分删除), `main.ts:18` 实际是 `index.ts:18`; 实现按实际位置处理, 动作数确为 11.
