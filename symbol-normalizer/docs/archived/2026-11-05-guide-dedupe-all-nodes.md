# 开局指南在所有节点都按会话记录去重（接取条目：`symbol-normalizer/docs/BACKLOG.md`「开局指南在所有节点都按会话记录去重（取消直写）」）

状态：完成　　开启：2026-11-05　　关闭：2026-11-05
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把指南消费者的注入判据统一成一条：**注入前先读会话记录（可见投影 + 未消费 inbox），投影里已有 1 条同 `summary` 的注入就不注入，看不见才注入**。`session-start` / `compaction` / `step-end` 三个节点一视同仁，取消 `directWrite` 直写。

## 背景

现注册参数为 `sources: ["session-start", "compaction", "step-end"]` + `dedupeInRecord: 1` + `directWrite: ["session-start", "compaction"]`：直写节点跳过 `dedupeInRecord` 判断。

- 压缩只遮蔽 `compaction/summary.shadowedRange`（`docs/host/DSH-CTX-API.md:147`），区间外的尾部消息仍留在投影里；指南注入多落在尾部，常被保留，此时压缩节点直写会重复注入同一条指南。
- 恢复会话（`session/created`）同理：投影里本就看得见旧指南，直写仍再注入一次。
- `step-end` 已按 `dedupeInRecord: 1` 判断，语义才是用户要的「看得见就不补」。

## 决策（用户 2026-11-05）

范围**全部节点**：不只压缩节点，会话开始的时机也检查——所有注入前都检查上下文投影。

## 规划（计划改动文件清单）

1. `symbol-normalizer/docs/BACKLOG.md`：条目按完成清理（关闭时）。
2. `symbol-normalizer/docs/implementation/2026-11-05-guide-dedupe-all-nodes.md`：本文件。
3. `symbol-normalizer/src/index.ts`：指南消费者去掉 `directWrite`（= `rule-engine` 缺省 `[]`，所有节点都按记录判断），注释同步。
4. `symbol-normalizer/src/guide.ts`：头注释里的注册口径同步。
5. `symbol-normalizer/tests/assemble.ts`：假引擎补「记录计数」语义（按 `dedupeInRecord` / `directWrite` / `summary` 模拟投影），供行为用例断言。
6. `symbol-normalizer/tests/main.test.ts`：注册参数断言（`directWrite` 为 `undefined`）。
7. `symbol-normalizer/tests/integration/plugin.test.ts`：注册断言 + 三节点行为用例（投影内已有 → 跳过；投影为空 / 已被挤出 → 注入）。
8. `symbol-normalizer/docs/DESIGN.md`：「机制」第 5 条口径。
9. `symbol-normalizer/README.md`：指南触发与去重一行（如提及直写则同步）。

不改：审查消费者（`symbol-normalizer`）的注册参数、`src/review.ts`、`src/symbols.ts`、`rule-engine` 侧实现。

## 实现记录

- `src/index.ts`：指南消费者删除 `directWrite: ["session-start", "compaction"]`，只留 `sources` / `delivery: "steer"` / `dedupeInRecord: 1`——rule-engine 缺省 `directWrite: []`，故三个节点都先按会话记录计数（`consumers.ts:225-232`：先 `decide` 取 `summary`，再判 `countInRecord >= dedupeInRecord`，命中即跳过）；注释同步为「都先看投影」。
- `src/guide.ts`：头注释的注册口径同步。
- `tests/assemble.ts`：假引擎补记录语义——`record: Map<sessionId, summary[]>` 模拟「可见投影 + 未消费 inbox」，派发时照 rule-engine 顺序先 `decide` 再判 `dedupeInRecord`（`directWrite` 内的节点跳过），命中即不入 `delivered`；新增 `clearRecord(sessionId?)` 模拟压缩挤出投影 / 恢复会话投影为空。
- `tests/main.test.ts`：注册参数断言改为 `directWrite === undefined`。
- `tests/integration/plugin.test.ts`：断言同上；行为用例改为三节点统一口径——首条 `session-start` 注入 1 条，随后 `session-start` / `compaction` / `step-end` 均 0（投影里仍看得见），`clearRecord()` 后 `compaction` 补 1 条、`step-end` 再 0。
- `docs/DESIGN.md` 机制第 5 条、`README.md` 第 3 节：口径改为「所有节点注入前都查记录」，删去直写描述，并记明压缩只遮蔽 `shadowedRange`、不保证挤出。

## 测试与证据

- `symbol-normalizer`：`pnpm run check` 通过；`pnpm run test` **46/46**；`pnpm run test:integration` **10/10**。
- 反向验证（用例能否抓住退化）：临时把 `directWrite: ["session-start", "compaction"]` 加回，`tests/main.test.ts` 注册断言失败 1 例、集成层 `apply 接线` 与 `开局指南` 失败 2 例；撤回后全绿。
- 全仓：`pnpm run check` 通过、`pnpm run build` 通过、`pnpm run test` 退出码 0、`pnpm run check:docs` 0 错误 0 警告。
- 真机未验证：需 `pnpm run build` 后重启会话（主 profile 走 `scripts/install.sh --profile fff --sync`），观察「压缩未挤出旧指南时不重复注入」「挤出后补一次」「恢复会话不重复注入」。已验证的仅是注册口径与假引擎语义。

## 收尾

- 代码 + 测试 + 文档随任务关闭后的一次提交。
- 关闭日期：2026-11-05。
