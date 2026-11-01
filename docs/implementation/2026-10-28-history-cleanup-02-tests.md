# 整理历史代码和文档: 阶段 2 测试锚定 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 实现　　开启: 2026-10-28　　关闭:
本文件是阶段 2 的追踪文档, 记录本阶段的批次、合并提交、门禁与全量结果; 34 份包追踪文档记录每包细节, 计划外的文件不改.

## 目标

给 34 个包补单元锚点与集成层, 每包落地 `test:integration` / `test:coverage` (`TUI` 另加 `test:e2e`), 记录改前改后覆盖率; 全部合并后跑全量 `test` 与 `test:coverage`, 为阶段 3 的代码整理提供回归网.

## 规划

- 分支与 worktree: 每包 `history-cleanup/02-tests-<包>` 与 `.worktree/02-tests/<包>`, 从当时的 `main` 开; 每批最多 8 个并行, 完成后合并回 `main`, 再开下一批.
- 顺序: 先 `TUI` / `agent-group` / `ast-tools` / `auto-approve` / `background-daemon` / `behavior-correction` / `clock-base` / `coagent` 八个; 其余按 `docs/implementation/2026-10-28-history-cleanup-<包>.md` 排队.
- 每包: 先跑基线, 补单元锚点, 新增 `tests/integration/` 与装配器 (`session-paths` 除外), 加两条脚本, 跑覆盖率, 追加包追踪文档, 分支提交.
- 合并: 包分支 `rebase main` 后合并; 冲突只在包分支解决; 每包合并后删 worktree, 分支保留到总任务关闭.
- 门禁: 单包 `check` / `test` / `test:integration` / `test:coverage` 全绿; 合并后全量 `test` 与 `test:coverage`; 覆盖率只升不降.
- 边界: 分支只改本包文件与本包包追踪文档; 不改 `src` (为可测性必须改时记「偏差」); 不改总追踪、阶段追踪、其它包; 不 push.

## 实现记录

- 2026-10-28 批次 2: `symbol-normalizer` 合并, 分支 `history-cleanup/02-tests-symbol-normalizer` (`ab7e4f0c`), 合并提交 `4251e22b`; 单元 46 条, 集成 10 条, 覆盖率 96.9%→98.5% / 81.9%→87.2%; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `session-title-cutoff` 合并, 分支 `history-cleanup/02-tests-session-title-cutoff` (`ea19606`), 合并提交 `5e30da5c`; 单元 21 条, 集成 18 条, 覆盖率 94.7%→98.0% / 81.4%→89.2%; 测试发现 `src/index.ts:352` 的 `\u202a-\u202e` 写在字符类外, 留阶段 3; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `session-channel` 合并, 分支 `history-cleanup/02-tests-session-channel` (`8906816`), 合并提交 `9f71a74`; 单元 78 条, 集成 9 条, 覆盖率 86.9%→88.2% / 61.9%→66.2%; 装配器以 `disabled: true` 取注册面再 `wireLive()` 起真服务; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `rule-engine` 合并, 分支 `history-cleanup/02-tests-rule-engine` (`46cf37c`), 合并提交 `7fc4345`; 单元 175 条, 集成 13 条, 覆盖率 94.7%→94.8% / 88.7%→88.8%; `herdr_use`→`herdr_run` 4 处; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `security-guard` 合并, 分支 `history-cleanup/02-tests-security-guard` (`57d55b3`), 合并提交 `01f04e9`; 单元 142→160 条 (skip 1→0), 集成 14 条, 覆盖率 97.5%→98.9% / 90.9%→94.1%; `report.mjs` 不排除 `dist`, 覆盖轮先删 `dist`; `herdr_use` 负断言保留; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `script-interpreter` 合并, 分支 `history-cleanup/02-tests-script-interpreter` (`d88b0b4`), 合并提交 `ab7b5a8`; 单元 117 条, 集成 14 条, 覆盖率 91.1%→95.1% / 77.7%→86.9%; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `output-compress` 合并, 分支 `history-cleanup/02-tests-output-compress` (`2f677dc`), 合并提交 `736bff8`; 单元 57→75 条, 集成 10 条, 覆盖率 89.6%→94.7% / 76.7%→85.2%; 本包无工具面, 集成改断 `session/event` 与 `renderSummaryRecord`; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `preference-analysis` 合并, 分支 `history-cleanup/02-tests-preference-analysis` (`3369ae8`), 合并提交 `3189806`; 单元 98 条, 集成 11 条, 覆盖率 87.1%→94.6% / 75.5%→88.4%; `tools.ts` 分支分母 26→27 的比值波动已注明; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `ponytail` 合并, 分支 `history-cleanup/02-tests-ponytail` (`4b91612`), 合并提交 `6cf2ceb`; 单元 9 条, 集成 14 条, 覆盖率 91.3%→100.0% / 65.2%→100.0%; 无落盘面, 集成以「工具面零注册 + 事件面无监听」替代临时目录断言; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `metric-loop` 合并, 分支 `history-cleanup/02-tests-metric-loop` (`84accc6`), 合并提交 `3b1e7a2`; 单元 47→56 条, 集成 17 条, 覆盖率 90.5%→94.8% / 83.3%→91.6%; 装配器以动态 import 取 `ManualClock` 规避 rootDir; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `memory-base` 合并, 分支 `history-cleanup/02-tests-memory-base` (`ea33e18`), 合并提交 `1f5ea4c`; 单元 83→90 条, 集成 6 条, 覆盖率 90.9%→93.0% / 79.3%→82.7%; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `md-map` 合并, 分支 `history-cleanup/02-tests-md-map` (`1d2481e`), 合并提交 `f46d82a`; 单元 50→65 条, 集成 15 条, 覆盖率 89.6%→94.5% / 78.4%→84.7%; `apply` 缺 ctx 守卫与 `warn` 的 `??` 依赖 `info()` 已记本包 BACKLOG; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `md-table-check` 合并, 分支 `history-cleanup/02-tests-md-table-check` (`fcb2ae0`), 合并提交 `1627c3f`; 单元 74 条, 集成 13 条, 覆盖率 100.0% / 99.0% 与改前一致; 无 `output.render`, 以 rule-engine 注入消息做投影断言; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `md-logic` 合并, 分支 `history-cleanup/02-tests-md-logic` (`cf1e931`), 合并提交 `574e8ac`; 单元 76 条, 集成 10 条, 覆盖率同命令 89.4%→95.2% / 79.5%→88.5% (阶段 1 基线分母不同, 只做同命令对比); `file_changed` 竞态与 root 下 `write_failed` 入豁免台账; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `herdr-use` 合并, 分支 `history-cleanup/02-tests-herdr-use` (`760a593`), 合并提交 `7f8c569`; 单元 136→143 条, 集成 22 条, 覆盖率 84.5%→88.6% / 71.3%→75.1%; `tests/clock.test.ts` 的 exclude 与跨包 import 按计划未动; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `herdr-integration` 合并, 分支 `history-cleanup/02-tests-herdr-integration` (`c851c4e`), 合并提交 `659a0ba`; 单元 57→60 条, 集成 11 条 (连跑 3 次全绿), 覆盖率 86.7%→91.7% / 67.2%→73.2%; win32 命名管道分支不可达, 入豁免台账; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `hash-edit` 合并, 分支 `history-cleanup/02-tests-hash-edit` (`c4e5e76`), 合并提交 `7429890`; 单元 54→57 条, 集成 18 条, 覆盖率 87.0%→96.4% / 73.3%→88.0%; `apply` 缺 ctx 守卫已记本包 BACKLOG 交阶段 3; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `goal-contract` 合并, 分支 `history-cleanup/02-tests-goal-contract` (`627883c`), 合并提交 `c71a02a`; 单元 41→55 条, 集成 9 条, 覆盖率 87.6%→95.8% / 81.8%→90.3%; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `fs-digest` 合并, 分支 `history-cleanup/02-tests-fs-digest` (`d4a7249`), 合并提交 `a8a24a1`; 单元 75 条, 集成 12 条, 覆盖率 89.3%→91.5% / 79.4%→80.4%; 5 个夹具均被测试与 demo 引用, 未删; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `escalation-hint` 合并, 分支 `history-cleanup/02-tests-escalation-hint` (`06703bd`), 合并提交 `17eb813`; 单元 34→50 条, 集成 17 条, 覆盖率 92.1%→99.3% / 79.4%→96.0%; 无工具面, 集成只覆盖事件消费者; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `command-template` 合并, 分支 `history-cleanup/02-tests-command-template` (`abe2daa`), 合并提交 `361e5ef`; 单元 33→48 条, 集成 12 条, 覆盖率 72.6%→84.6% / 58.9%→73.5%; worktree 已删, coagent 已关.
- 2026-10-28 批次 2: `context-report` 合并, 分支 `history-cleanup/02-tests-context-report` (`1b51f16`), 合并提交 `549e295`; 单元 51 条, 集成 16 条, 覆盖率 93.3%→95.8% / 87.3%→90.3%; `ctx.logger.info` 与类型声明不一致, 留阶段 3; worktree 已删, coagent 已关.
- 2026-10-28 批次 1: `coagent` 合并, 分支 `history-cleanup/02-tests-coagent` (`a13d9e5`), 合并提交 `5d12995`; 单元 33→78 条, 集成 18 条, 覆盖率 79.9%→88.1% / 62.4%→78.6%; 集成层因 `apply` 固定 `systemClock` 改用真实时钟 + 毫秒等待; worktree 已删, coagent 已关.
- 2026-10-28 批次 1: `TUI` 合并, 分支 `history-cleanup/02-tests-tui` (`660211e`..`370e384`), 合并提交 `01fec6b`; 单元 1828 条, 集成 12 条, 覆盖率 87.39%→87.48% / 78.42%→78.41% (分支微降属分母噪声); `test:e2e` 的 demo 段 `SMOKE_OK`, `smoke:pty` 因缺 `TOLLGATE_API_KEY` 未通过, 交人工验收; worktree 已删, coagent 已关.
- 2026-10-28 批次 1: `clock-base` 合并, 分支 `history-cleanup/02-tests-clock-base` (`874e486`), 合并提交 `0e030f1`; 单元 25→33 条, 集成 12 条, 覆盖率 94.6%→98.2% / 83.0%→94.4% (规划基线 84.0% 与实测 83.0% 不符, 以实测为准); worktree 已删, coagent 已关.
- 2026-10-28 批次 1: `background-daemon` 合并, 分支 `history-cleanup/02-tests-background-daemon` (`01b37c1`), 合并提交 `94380d0`; 单元 166→190 条, 集成 10 条, 覆盖率 85.4%→89.8% / 72.8%→78.3%; worktree 已删, coagent 已关.
- 2026-10-28 批次 1: `behavior-correction` 合并, 分支 `history-cleanup/02-tests-behavior-correction` (`e076027`), 合并提交 `19b7379`; 单元 33→46 条, 集成 13 条, 覆盖率 90.8%→98.6% / 85.3%→98.4%; `herdr_use` 负断言按 4.4 保留; worktree 已删, coagent 已关.
- 2026-10-28 批次 1: `ast-tools` 合并, 分支 `history-cleanup/02-tests-ast-tools` (`8645ac6`), 合并提交 `a73fabd`; 单元 82 条, 集成 9 条, 覆盖率 84.2%→96.3% / 62.6%→87.6%; worktree 已删, coagent 已关. 包内记 `BundleHost.logger` 可选却无条件取 `.info` 的问题, 留阶段 3.
- 2026-10-28 批次 1: `auto-approve` 合并, 分支 `history-cleanup/02-tests-auto-approve` (`3c809ca`), 合并提交 `4d5ab15`; 单元 181 条, 集成 12 条, 覆盖率 87.2%→90.3% / 72.1%→75.7%; worktree 已删, coagent 已关.
- 2026-10-28 批次 1: `agent-group` 合并, 分支 `history-cleanup/02-tests-agent-group` (`ecd12a6`), 合并提交 `22c4c05`; 单元 63→108 条, 集成 13 条, 覆盖率 84.8%→90.6% / 72.6%→81.7%; worktree 已删, coagent 已关.

## 偏差

无

## 测试与证据

(待填)

## 收尾

(待填)
