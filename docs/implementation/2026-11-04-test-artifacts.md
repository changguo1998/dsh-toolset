# 迁出 34 包测试产物数据

状态: 规划
条目: 迁出 34 包测试产物数据

## 目标

把 34 份包追踪文档里分散在「实现记录」「测试与证据」的四类测试数据, 收进每份文档末尾已有的「四份测试产物」节, 使其可直接读取; 数据只搬不重算, 原节保留指向新节的指针.

## 现状

- 34 份 `docs/archived/2026-10-28-history-cleanup-<包>.md` 末尾都有统一的 9 行「四份测试产物」索引 (覆盖率表 / 用例清单 / `skip` 与豁免 / 四入口), 但索引只写「见某节」, 数据仍在别处.
- 数据形态不一: 28 份的四入口已是表; 6 份 (`agent-group` / `goal-contract` / `md-logic` / `preference-analysis` / `session-channel` / `symbol-normalizer`) 只有代码块或列表; 6 份有独立豁免台账 (`ast-tools` / `clock-base` / `code-map` / `hash-edit` / `herdr-integration` / `security-guard`), 其余以正文说明; 覆盖率有整包汇总、逐文件表、改前 / 改后两表等形态.
- 这些文档是归档记录, 数字是当时的实跑读数; 本次不重跑测试, 不按现状改写.

## 决策

1. 以每份文档为独立数据节, 不另建 34 包汇总: 数据属于包历史, 汇总会重复一遍大表并增加数字漂移面.
2. 目标结构: `## 四份测试产物` 下依次 `### 覆盖率` / `### 用例清单` / `### skip 计数与豁免台账` / `### 四入口实跑`, 四小节顺序固定.
3. 搬移而非复制: 四类数据从原节移入, 原节留一行 `见「四份测试产物」...` 的指针; 不用 Markdown 锚点 (`link.anchor` 仍在警告档), 指针按标题文字引用.
4. 范围只取阶段 2 测试锚定的四类数据: 覆盖率 (改前 / 改后)、新增 / 删除用例清单与夹具、`skip` / `todo` 与豁免台账、`check` / `test` / `test:integration` / `test:coverage` 四入口实跑. 阶段 3 / 4 的实跑表、冒烟、真机与人工确认留在原节.
5. 数字照录, 不重算; 四入口原为代码块或列表的, 只改成表格, 文案与读数逐字保留.
6. 缺项如实写: 原文无台账的写 `豁免台账: 无 (原文未记)`; 原文用正文说明未覆盖原因的, 原样搬进覆盖率小节, 不补造数字.
7. 一包一笔提交: 每包只改该包的归档文档与本追踪文档; 每包跑结构校验、数字保留校验、`pnpm run check:docs`, 全绿即提交.
8. 顺序按 `docs/archived/2026-10-28-history-cleanup.md` 的包表: `TUI` 起, 其后 `agent-group` 至 `tool-consult`.

## 计划改动文件清单

- `docs/archived/2026-10-28-history-cleanup-tui.md`
- `docs/archived/2026-10-28-history-cleanup-agent-group.md`
- `docs/archived/2026-10-28-history-cleanup-ast-tools.md`
- `docs/archived/2026-10-28-history-cleanup-auto-approve.md`
- `docs/archived/2026-10-28-history-cleanup-background-daemon.md`
- `docs/archived/2026-10-28-history-cleanup-behavior-correction.md`
- `docs/archived/2026-10-28-history-cleanup-clock-base.md`
- `docs/archived/2026-10-28-history-cleanup-coagent.md`
- `docs/archived/2026-10-28-history-cleanup-code-map.md`
- `docs/archived/2026-10-28-history-cleanup-command-template.md`
- `docs/archived/2026-10-28-history-cleanup-context-report.md`
- `docs/archived/2026-10-28-history-cleanup-escalation-hint.md`
- `docs/archived/2026-10-28-history-cleanup-fs-digest.md`
- `docs/archived/2026-10-28-history-cleanup-goal-contract.md`
- `docs/archived/2026-10-28-history-cleanup-hash-edit.md`
- `docs/archived/2026-10-28-history-cleanup-herdr-integration.md`
- `docs/archived/2026-10-28-history-cleanup-herdr-use.md`
- `docs/archived/2026-10-28-history-cleanup-md-logic.md`
- `docs/archived/2026-10-28-history-cleanup-md-map.md`
- `docs/archived/2026-10-28-history-cleanup-md-table-check.md`
- `docs/archived/2026-10-28-history-cleanup-memory-base.md`
- `docs/archived/2026-10-28-history-cleanup-metric-loop.md`
- `docs/archived/2026-10-28-history-cleanup-output-compress.md`
- `docs/archived/2026-10-28-history-cleanup-ponytail.md`
- `docs/archived/2026-10-28-history-cleanup-preference-analysis.md`
- `docs/archived/2026-10-28-history-cleanup-rule-engine.md`
- `docs/archived/2026-10-28-history-cleanup-script-interpreter.md`
- `docs/archived/2026-10-28-history-cleanup-security-guard.md`
- `docs/archived/2026-10-28-history-cleanup-session-channel.md`
- `docs/archived/2026-10-28-history-cleanup-session-paths.md`
- `docs/archived/2026-10-28-history-cleanup-session-title-cutoff.md`
- `docs/archived/2026-10-28-history-cleanup-symbol-normalizer.md`
- `docs/archived/2026-10-28-history-cleanup-task-engine.md`
- `docs/archived/2026-10-28-history-cleanup-tool-consult.md`
- `docs/BACKLOG.md` (接取时标进行中, 关闭时移除条目)
- 本文件

## 实施步骤

- B0: 接取, 把 `docs/BACKLOG.md` #1 标进行中, 建本文件, 提交规划.
- B1 至 B34: 按上列顺序, 每次一份包文档:
  1. 读全文, 定位四类数据的原节与表格 / 列表.
  2. 把数据搬进 `## 四份测试产物` 的四个小节, 原节留指针.
  3. `node tmp/test-artifacts-check.mjs <file>` 校验结构与数字保留; `format <file>`; `pnpm run check:docs`.
  4. 本文件「实现记录」追加一行 (包名 / 校验结果), 与包文档一并提交.
- B35: 34/34 复核, 关闭条目, 归档本文件 (待用户确认后执行收尾).

## 验收

- 34/34 文档的四个小节都非空; 四入口表都有 4 行 (`TUI` 另带 `test:e2e`); 覆盖率含改前 / 改后; 用例清单含新增 / 删除; `skip` 节含计数与豁免结论.
- 每包改动前后, 旧文出现的数字都能在新文找到; 覆盖率行 / 分支读数逐项一致.
- 指针只指向存在的节; `pnpm run check:docs` 与 `--strict` 0 错误 / 0 警告.
- 改动只落在 34 份归档文档 + `docs/BACKLOG.md` + 本文件, 无代码 / 配置改动.

## 实现记录

- `TUI`: 覆盖率 / 用例清单 / `skip` 与豁免 / 四入口搬入四个小节; 原「实现记录」「测试与证据」留指针; 结构校验与数字保留校验通过, `check:docs` 0 / 0.
- `agent-group`: 同上; 四入口由 4 条列表改为表; 补一行「新增与删除」汇总 (4 个单元文件 + 2 处追加 / 13 条集成 / 删除 0).
- `ast-tools`: 四个小节各就位; 四入口表表头改「入口」; 原「用例增减」「豁免台账」并入用例 / skip 小节.
- `auto-approve`: 覆盖率两表 + 分层贡献、3 个单元文件与集成断言、用例增减与夹具、四入口 (含辅助 build) 全部就位; 无台账, 记「无 (原文未记)」.
- `background-daemon`: 覆盖率表 + 口径说明 + 未覆盖行表、单元 / 集成锚点、用例增减与夹具、四入口全部就位; `skip` / `todo` 0 / 0, 无台账.
- `behavior-correction`: 基线 / 覆盖率 / 用例表 / skip / 四入口就位; 删除的契约探针保留在用例表, 无台账.
- `clock-base`: 覆盖率两表 + 分层贡献、用例增减表、4 行豁免台账、四入口就位.
- `coagent`: 覆盖率两表 + 分层贡献、文件级用例表 (含脚本行)、3 条防御分支豁免、四入口就位.
- `code-map`: 覆盖率表 + 契约面 + 口径说明、装配器 / 集成 / 12 条单元锚点、3 行豁免台账、四入口就位.
- `command-template`: 覆盖率表 + 分母说明 + 未覆盖行、15 条单元 + 12 条集成 + 断言清单、不可达分支豁免、四入口就位.
- `context-report`: 覆盖率表 + V8 口径、10 条单元 + 16 条集成、无台账、四入口就位.
- `escalation-hint`: 基线 + 覆盖率表 + 分母说明、6+10 单元 / 17 集成清单、覆盖豁免、四入口就位.
- `fs-digest`: 基线 + 覆盖率表 + 分层贡献 + 契约面、单元 / 集成清单与夹具、read.ts 豁免、四入口就位.
- `goal-contract`: 基线 + 覆盖率表 + 分层贡献、14 单元 / 9 集成清单、四入口由代码块改表.
- `hash-edit`: 基线 + 覆盖率表 + 分层贡献、3 单元 / 18 集成 / 装配器清单、3 行豁免台账、四入口就位.
- `herdr-integration`: 覆盖率表 + 分层贡献、3 单元 / 11 集成清单、win32 豁免、四入口就位.
- `herdr-use`: 覆盖率整包 + 逐文件表、改动文件 / 接线 / 锚点清单、四入口 (含 build) 就位.
- `md-logic`: 基线 + 覆盖率表 + 分层贡献、18 单元 / 10 集成清单、file_changed 豁免、四入口就位.

## 测试与证据

- 每包: `node tmp/test-artifacts-check.mjs <file>` 结构 + 数字校验; `format <file>`; `pnpm run check:docs`.
- 收尾: 34/34 复跑结构校验; `pnpm run check:docs` / `--strict`; `git diff --stat` 核对范围; 抽查 5 份 (`TUI` / `clock-base` / `rule-engine` / `session-channel` / `ponytail`) 数字与原文一致.

## 偏差

- 规划写「实现记录」带提交号; 提交号无法在同一笔提交内预写, 实际只记包名与校验结果, 提交号以 `git log` 为准.
