# 代码整理（阶段 3，所属总追踪：`docs/implementation/2026-10-28-history-cleanup.md`）

状态：实现　　开启：2026-10-28　　关闭：
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

## 偏差

- 总追踪 5.1 写「不改注释里的路径与计数（第 6 章）」，但「计划改动文件清单」第 3 节逐包列了注释项；按清单执行，注释项并入本阶段，阶段 5 只做项目级文档与其余注释。
- 清单 `session-channel` 一处写「`src/keys.ts` 的 3 个符号」，按 5.2 实为 4 个（`STATE_PATTERN`、`TASK_INDEX_PATTERN`、`sessionIdFromStateKey`、`sessionIdFromTaskIndexKey`）；实现按 4 个执行。
