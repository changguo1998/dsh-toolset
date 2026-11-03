# 项目级四项待办批次（接取条目：`docs/BACKLOG.md`「历史清理文档残留修正」；「覆盖率报告排除 dist 并统一口径」；「修正 surfaceOp: replace 的识别与处理」；「复用审计补审 3 包」）

状态：关闭　　开启：2026-11-03　　关闭：2026-11-03

本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

按 `docs/BACKLOG.md` §2 的顺序依次完成上述四个条目：先修文档残留，再统一覆盖率口径，再修 `surfaceOp: replace` 的识别与处理，最后补审 3 个包的复用结论。每个条目收尾时按标准流程回写文档并在收尾清理 BACKLOG 条目。

## 调研

### 条目一：历史清理文档残留修正

来源：条目正文五处 + `docs/archived/2026-11-01-history-cleanup-audit.md` P4-08 / P5-12 / E-10 / E-16 + 仓库实测。

| 位置 | 现状 | 结论 |
| --- | --- | --- |
| `TUI/README.md:351` 与 `TUI/docs/DESIGN.md:378` | 条目称「仍用旧称」；两行现为 `/council` 行，用词已是「审阅子代理」，`grep 评审` 在非归档 TUI 文档 0 命中（命中仅在 `TUI/docs/archived/`，按规则不改） | 无需改动，记入「偏差」 |
| `docs/GLOSSARY.md` 场景表 | 有「存储 / 审计 / 实现 / 投递 / 文档」五行，缺「BACKLOG 条目」 | 补一行，与「需要替换」表的「按存储 / 审计 / 实现 / 投递 / 文档 / 条目分写」对齐 |
| `security-guard/scripts/tool-surface-check.mjs:925` | 提示文案写 `npm --prefix security-guard run build` | 改 pnpm 口径（仓内统一 `pnpm -C <包> run <脚本>`） |
| `security-guard/tests/script.test.ts:505` | 断言同一句 npm 文案 | 同步改断言 |
| `session-paths/README.md:75` | 写「两个 program 的类型检查」；实际 `check` 是单 `tsc -p tsconfig.json --noEmit` | 删掉「两个 program」，改单 program 口径 |
| `profiles/README.md:25` | 写「改完 `npm run build` 即生效」 | 改 `pnpm run build` |

### 条目二：覆盖率报告排除 dist 并统一口径

来源：`dev/coverage/report.mjs` 实测 + 阶段 3 / 阶段 5 追踪数字。

- `isPackageSource` 只排除仓库外路径、`node_modules` 与 `tests`，未排除 `dist`；包依赖以硬链接落在 `node_modules` 时不计，但被 `NODE_V8_COVERAGE` 记录到的 `dist/` 产物会被计入分母。
- 阶段 3（`docs/archived/2026-10-28-history-cleanup.md:1400`、`-03-code.md:74`）记 87.7%（70114/79945）/ 80.1%（16404/20491）；阶段 5（`docs/archived/2026-11-01-history-cleanup-audit.md` P5-25、E-15、`:337`、`:345`）记 86.6%（70416/81275）/ 80.0%（16407/20497）。两阶段口径不同（不排 dist）且跨阶段数字不可比。

### 条目三：修正 `surfaceOp: replace` 的识别与处理

来源：`docs/host/DSH-CTX-API.md:54-58`、`TUI/src/app/adapter/dsh.ts:1116-1122`、`rule-engine/src/engine.ts:368-377` 与 `:585-593`、两个包的用例。

- 宿主契约：`SurfaceOp = 'append' | { op: 'replace', startSeq, endSeq }`（首尾均含，`startSeq === endSeq` 为单节点替换），是**范围替换**语义。
- 现状：TUI 只读事件顶层字符串 `surfaceOp === "replace"` 并在 `assistant/message` 上整条丢弃；`user/message` 与 `tool/result` 完全未判。rule-engine 的 `surfaceOpOf` 同样只认字符串，且只在 `assistant/message` 分支判。
- 后果：对象形态的更正事件被当作 append 照常显示 / 照常入缓冲（同一段内容重复出现）；字符串形态的更正事件在 `user/message`、`tool/result` 上不被识别。

### 条目四：复用审计补审 3 包

来源：`docs/ARCHITECTURE-REUSE.md` §0 结论总表（31 行）与 `docs/archived/2026-10-19-reuse-reaudit.md`。

- 快照缺 `coagent` / `tool-consult` / `escalation-hint` 三包；文档同时存在「31 包快照」与「当前 34 包」两种口径。

## 决策

决策项 1：条目三的实现范围

- (a) 完整实现范围替换：按 `startSeq` / `endSeq` 重写已展示区间（TUI 缓冲区是 append-only 行缓冲，需新建「按事件 seq 反查已渲染区间」的索引并重排历史流；rule-engine 需把 `turn/end` 载荷按替换后重建）。风险高、改动面大。
- (b) 统一识别 + 记录为不支持并给替代：抽一个「更正事件」判定（同时认字符串与 `{op:'replace'}` 对象形态），在三个 surface 事件上都按同一口径跳过；文档写清「不做范围重写」与替代路径。
- **选定：b**。理由：TUI 显示面是 append-only（缓冲行不保留源事件 seq 到行的完整映射），按条目「记录为不支持并给替代」分支更符合现状与风险，且能立即修掉「对象形态被当 append」的重复显示。

决策项 2：条目三的「替代」

- 选定：更正内容需重现时，由模型重新整段 append（宿主 `followup` / 新 step），或用户 `/session` 重载会话从持久化事件重建画面；不使用范围替换。

决策项 3：条目一的 TUI 两处

- (a) 强行找旧称改写；(b) 按实测判定已修、记入偏差。
- **选定：b**（`grep 评审` 在非归档文档 0 命中，两处内容已是「审阅」）。

决策项 4：条目二的回写范围

- (a) 只改脚本并记录新数字于本追踪文档；(b) 同时在阶段 3 与阶段 5 追踪文档补「新口径复跑」注记。
- **选定：b**（条目验收要求「阶段 3 与阶段 5 文档按同一口径回写」）。

## 规划

任务拆分（按 BACKLOG 顺序串行）：

1. 条目一：改 5 处文档 / 文案（GLOSSARY 补行、security-guard 两句、session-paths 一句、profiles 一句）；TUI 两处记偏差。验证：旧文案 0 命中、`security-guard` 的 `check` / `test` 退出 0、`format` 幂等。
2. 条目二：`dev/coverage/report.mjs` 排除 `dist/`；跑 `pnpm run test:coverage`；把同 commit 的行 / 分支分子分母写进阶段 3 与阶段 5 追踪文档。验证：`dist` 条目 0、同 commit 两次报告一致、百分比可由分子分母复算。
3. 条目三：抽更正事件判定并在 TUI / rule-engine 三个 surface 事件上统一；补两侧用例；文档口径统一叫「更正事件」并写明不支持范围重写与替代。验证：两包 `check` / `test` 通过，反向验证（撤改即转红）。
4. 条目四：`docs/ARCHITECTURE-REUSE.md` 补 3 行、重算分布，31 包快照保留为历史、当前口径写 34 包。验证：3 行齐、分布可复算、两口径分列。

计划改动文件清单：

| 条目 | 文件 |
| --- | --- |
| 状态与追踪 | `docs/BACKLOG.md`（四条标进行中，收尾移除）、本追踪文档 |
| 一 | `docs/GLOSSARY.md`、`security-guard/scripts/tool-surface-check.mjs`、`security-guard/tests/script.test.ts`、`session-paths/README.md`、`profiles/README.md` |
| 二 | `dev/coverage/report.mjs`、`docs/archived/2026-10-28-history-cleanup.md`、`docs/archived/2026-10-28-history-cleanup-03-code.md`、`docs/archived/2026-11-01-history-cleanup-audit.md` |
| 三 | `TUI/src/app/adapter/dsh.ts`、`TUI/tests/adapter.dsh.test.ts`、`rule-engine/src/engine.ts`、`rule-engine/tests/bufferBoundary.test.ts`、`TUI/docs/DESIGN.md`、`rule-engine/README.md` |
| 四 | `docs/ARCHITECTURE-REUSE.md` |

明确不做：

- 不做 TUI 界面名称全量替换（那是另一条目）；
- 不做范围替换的完整实现（见决策项 1）；
- 不改 `docs/STATUS.md`（对照文档由用户择时更新）；
- 不改归档文档的历史数字，只在阶段 3 / 阶段 5 范围外补注记；
- 不碰 `md-table-check` 的镜像用例（除非本次改动使其转红，届时另行说明并请用户裁定）。

## 实现记录

- 2026-11-03：四条目标〔进行中: 2026-11-03〕，建本追踪文档（调研 / 决策 / 规划先写）。
- 条目一：
  - `docs/GLOSSARY.md` 场景表补「BACKLOG 条目 → 改动位置」一行（原缺，与「需要替换」表的六类落点对齐）。
  - `security-guard/scripts/tool-surface-check.mjs` 的构建提示改 pnpm 口径：`npm --prefix security-guard run build` → `pnpm -C security-guard run build`；`security-guard/tests/script.test.ts` 同步改断言正则。
  - `session-paths/README.md` 的 `check` 注释「两个 program 的类型检查」→「类型检查（单 program，tsc --noEmit）」（实测 `package.json` 的 `check` 只跑一个 `tsc -p tsconfig.json --noEmit`）。
  - `profiles/README.md` 的「改完 `npm run build` 即生效」→ `pnpm run build`。
  - TUI 两处按决策项 3 不改。
- 条目二：`dev/coverage/report.mjs` 的 `isPackageSource` 增加 `dist/` 排除，注释同步；连跑三次 `pnpm run test:coverage`（退出 0），报告内 `dist` 文件 0 条，总表 34 包。
- 条目三：两侧各抽「更正事件」判定（字符串 `"replace"` 或 `{ op: "replace", … }`；事件顶层优先、兼容 `data` 内）。
  - `TUI/src/app/adapter/dsh.ts`：新增模块级 `isCorrectiveEvent` / `isReplaceOp`，在 `assistant/message`、`user/message`、`tool/result` 三处统一跳过；`agent/inbox/spliced` 不是 surface 事件、不受此门影响。
  - `rule-engine/src/engine.ts`：删 `surfaceOpOf`，改 `isCorrectiveEvent` / `isReplaceOp`，同一套口径用于三类事件（缓冲与条目派发都不吃更正事件）。
  - 用例：`rule-engine/tests/bufferBoundary.test.ts` 新增两例（对象形态不入缓冲；user / tool 上的 replace 不派发，缺省与 append 仍派发）；`TUI/tests/adapter.dsh.test.ts` 新增一例（三类事件的对象 / 字符串 replace 均跳过，append 形态照常渲染）。
  - 文档：`TUI/docs/DESIGN.md` 非流式回复补发一条改「更正事件」口径并写明不支持范围重写与替代；`rule-engine/README.md` 的源表与「已知限制」同步。
- 条目四：`docs/ARCHITECTURE-REUSE.md` 补 `coagent`（保留）/ `tool-consult`（并存）/ `escalation-hint`（保留）三行，§1 / §2 / §3 / §7 与口径行同步；总表 34 行，分布「改用 0 / 保留 24 / 并存 10」（脚本按表格第三列复算，与口径行一致）。

## 偏差

- 条目一的「TUI 两处旧称」未改：`TUI/README.md:351` 与 `TUI/docs/DESIGN.md:378` 现为 `/council` 行，用词已是「审阅子代理」；`grep '评审'` 在非归档 TUI 文档 0 命中（命中全在 `TUI/docs/archived/`，按规则不改）。判定为审计快照的行号与结论已过期。
- 条目二「同 commit 两次报告一致」未达成：同一 commit 连跑三次，行覆盖 69437 / 69437 / 69440（分母 77567），分支覆盖 16269 / 16269 / 16272（分母 20298 / 20298 / 20303）。逐文件比对差异集中在 `memory-base/src/tiers.ts`、`script-interpreter/src/run.ts`、`session-channel/src/broker.ts` / `service.ts`，属并行测试的时序分支（同一路径有时执行、有时不执行）。因此回写时记录**区间**（行 69437~69440 / 77567 = 89.5%，分支 16269~16272 / 20298~20303 = 80.2%）并列出分子分母；百分比仍可由分子分母复算。
- 条目三选了「记录为不支持并给替代」而非「完整实现范围替换」（决策项 1、2）：TUI 缓冲行不保留源事件 seq 到行的映射，按 `startSeq` / `endSeq` 重写已展示区间需要另建索引并重排历史流，风险与改动面都超出本条目的 P2 边界。
- 计划外文件：无（实际改动与清单一致，另加 `docs/BACKLOG.md` 的条目状态与本追踪文档）。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `grep 'npm --prefix security-guard'` / `grep '两个 program'` / `grep '\`npm run build\`'`（现行文档与脚本） | 0 命中（`docs/archived/`的历史记录保留） | |`pnpm -C security-guard run check`/`run test`| 退出 0 / 160 例全过 | |`pnpm -C session-paths run check`| 退出 0 | |`pnpm run test:coverage`（三次，脚本加排 `dist/` 后） | 退出 0；`dist`文件 0；行 69437~69440 / 77567（89.5%），分支 16269~16272 / 20298~20303（80.2%） | |`pnpm -C rule-engine run check`/`run test`| 退出 0 / 177 例全过（较改前 168 例新增 9） | |`pnpm -C TUI run check`| 退出 0 | |`bash TUI/scripts/test.sh adapter.dsh.test.ts`| 218 例全过 | |`pnpm run check`/`pnpm run build`/`pnpm run test`（全仓） | 均退出 0（`test`无 fail 行） | |`format\`（全部改动文件） | 退出 0，复跑无变化 |

反向验证：条目三的两处用例在改动前会转红（`assistant/message` 的对象形态被当 append → 覆盖正文会进流；`user/message` / `tool/result` 的 replace 会照常派发）。改动后两包用例转绿，说明门确实生效。

## 收尾

- 回写文档：`docs/GLOSSARY.md`、`TUI/docs/DESIGN.md`、`rule-engine/README.md`、`docs/ARCHITECTURE-REUSE.md`、`session-paths/README.md`、`profiles/README.md`；阶段 3 与阶段 5 的追踪文档（`docs/archived/` 内三份）补「2026-11-03 口径补正」注记，历史数字不改。
- BACKLOG：四条从 `docs/BACKLOG.md` §2 移除，关闭注记留在原位置。
- 本追踪文档移入 `docs/archived/`。
