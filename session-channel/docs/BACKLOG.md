# session-channel 待办

> 职责：session-channel 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与边界（见 `session-channel/README.md` 与 `session-channel/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `session-channel/tests/`（如 D4 / D5 / D6 已修复提交），不在此重复。
> 组织：缺陷 / 功能两区；条目统一结构——现状 → 期望 →（可选）接取时裁定 → 改动位置 → 验收 → 来源·状态·优先级。

## 1. 缺陷

（暂无）

> 2026-11-04 关闭: 「全仓并行测试下 `systemTimers` 计时用例偶发只触发 1 次」已修并移出清单（提交 `5028ae2e`）: `tests/entry.test.ts` 改用 `t.mock.timers` 推进时间, 断言仍要求 `ticks >= 2`, 不再真实等待; 包内 78 例、全仓 `check` / `build` / `test` 全绿（4573 例）; 按快速流程未建追踪文档, 记录见该提交信息.

## 2. 功能

（暂无）
