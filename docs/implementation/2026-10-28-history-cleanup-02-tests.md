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

(待填)

## 偏差

无

## 测试与证据

(待填)

## 收尾

(待填)
