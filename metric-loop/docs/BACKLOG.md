# metric-loop 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 待办

- **缺省状态目录忽略 `DSH_HOME`, e2e 会写进真实 home**

  - 现状: `src/index.ts:98-103` 的 `defaultStateDir()` 取 `METRIC_LOOP_STATE_DIR` ?? `~/.dsh/metric-loop`, 不读 `DSH_HOME`; 而 e2e 夹具靠 `DSH_HOME` 隔离 home（`e2e/harness.ts:144`），故跑 `e2e/metric-loop.test.ts` 会往真实 `~/.dsh/metric-loop` 写状态, 本机真实状态与用例互相污染（同型问题已在 `rule-engine` 修复）。
  - 期望: 优先级改为 `METRIC_LOOP_STATE_DIR` > `<DSH_HOME>/metric-loop` > `~/.dsh/metric-loop`（空值视同未设），与 `rule-engine/src/persist.ts`（2026-11-08 修复）和 `session-paths/src/index.ts` 的 home 口径一致; 并补一条环境变量优先级单测。
  - 来源: 2026-11-08 修复 `rule-engine` 同类问题时发现（`rule-engine/docs/archived/2026-11-08-e2e-rule-review.md`「途中发现」）。优先级: 低。

（完成项见 git 历史与 `metric-loop/docs/archived/`; 关闭时把条目从这里移除。）
