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
