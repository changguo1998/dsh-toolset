# 起草 goal 时限制首句字数（接取条目：`docs/BACKLOG.md` §2「起草 goal 时限制首句字数（≤40 显示列）」）

状态：实施（待验证收尾）　　开启：2026-10-07　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。**同批** = `TUI/docs/implementation/2026-10-07-goal-objective-wrap.md`（显示侧改为「首逻辑行 + 完整折行」）。

## 目标

显示侧不再截断（首逻辑行按列宽完整折行），因此「一句话概括」的**字数必须在起草侧收住**——否则一个很长的首行会在状态列里折出很多行。本条给 `goal_contract_draft` 加首句长度上限：**≤40 显示列**（约 20 个汉字 / 40 个英文字符），超限在起草阶段就报错/重问。

## 决策

**D1｜上限取值** → `SUMMARY_MAX_WIDTH = 40` 显示列。理由：状态列最低 20 列 → 正文宽 19 列，40 列首句最窄也就折 3 行；常见宽度（正文 30-40 列）折 1-2 行，与「一句话」的直觉一致。**该常量是唯一旋钮**，要更严（如 ≤30 列）改一处即可。

**D2｜显示列而非字符数** → 用「显示列」而不是「字符个数」：中英文混排下字符数没有可比性（20 个汉字 40 列 vs 20 个英文字母 20 列）。宽字符判定只覆盖常见东亚全宽 / emoji 区段（够用即可，不追求逐码点精确）。

**D3｜校验落点（三处，各司其职）** →
① `buildObjective`（唯一嵌入咽喉）：首行超限抛 `ContractParseError`——兜底所有写入路径；
② 访谈状态机 `applyAnswer` 的 `ask-objective` 阶段：把超限当**本阶段校验失败**（沿用既有语义：错误拼进下次提问、最多重问 3 次后 aborted）——交互路径体验最好；
③ 工具 `execute` 的**预填路径**：解析出 `objective` 后立刻 `fail(超限原因)`——非交互路径给可操作报错，而不是等到嵌入阶段报「契约嵌入失败」。

**D4｜只限首个逻辑行** → 后续正文（多段细节）**不受限**：状态列只显示首行，正文是给 `/goal` 与 goal grounding 用的。

**已知覆盖边界**：宿主 `create_goal` / `/goal` 命令创建的目标不经过本工具，没有起草期约束（显示层仍只取首行、按列宽折行）。

## 规划（计划改动文件清单）

1. `goal-contract/src/contract.ts`：`SUMMARY_MAX_WIDTH` + `summaryWidth()` + `checkSummaryWidth()`；`buildObjective` 超限抛错。
1. `goal-contract/src/interview.ts`：`ask-objective` 阶段校验超限（重问 / 超限中止）。
1. `goal-contract/src/tool.ts`：预填路径即时 `fail`；`TOOL_DESCRIPTION` 与 `objective` 参数描述写明 ≤40 显示列与「按列宽完整折行」。
1. `goal-contract/README.md`：参数表 + 行为段同步。
1. 测试：`contract.test.ts`（宽度函数 / 超限抛错 / 正文不限）、`interview.test.ts`（重问 + 连续超限 aborted + 正文不限）、`tool.test.ts`（预填超限 `ok:false` 且不落 goal）。
1. `docs/BACKLOG.md`：条目〔进行中〕→ 关闭时移除；本追踪文档 → 关闭时归档。

## 实现记录

- `goal-contract/src/contract.ts`：新增 `SUMMARY_MAX_WIDTH = 40`、`isWideCodePoint()`（近似宽字符表）、`summaryWidth(objective)`（首个非空行的显示列宽）、`checkSummaryWidth(objective)`（超限返回可操作文案，含实际列数与上限）；`buildObjective` 在空值校验后调用它并抛 `ContractParseError`。
- `goal-contract/src/interview.ts`：`ask-objective` 阶段在空值校验后加超限分支（`error: overLimit`，达 `maxAttempts` 转 `aborted`）。
- `goal-contract/src/tool.ts`：`objective` 预填后立即校验并 `fail`；`TOOL_DESCRIPTION` 与 `objective` 参数描述改为「首行必须是一句话概括且 ≤40 显示列……状态列只显示首个逻辑行并按列宽完整折行」。
- `goal-contract/README.md`：`objective` 参数行 + 行为段写明上限与重问语义。
- 测试：`contract.test.ts` +2 例、`interview.test.ts` +1 例、`tool.test.ts` +1 例。

## 测试与证据

- `goal-contract`：`npm run check` exit 0；`npm run test` **41 pass / 0 fail**（原 37 + 新增 4 例：宽度函数 / `buildObjective` 超限 / 访谈重问与连续超限 / 预填超限不落 goal）。
- 全仓（与本批另一条同轮）：`npm run check` exit 0、`npm run build` exit 0、`npm run test` 全绿、`npm run demo -- --smoke` → `SMOKE_OK`。
- **构建产物直测**（`tmp/goal-wrap-probe.mjs`，跑完即删）：`SUMMARY_MAX_WIDTH === 40`；20 个汉字（40 列）通过、21 个汉字（42 列）报「首行（一句话概括）过长」；`summaryWidth` 只看首个逻辑行；`buildObjective` 超限抛错，而「首行短 + 长正文」合法；`TOOL_DESCRIPTION` 含「≤40 显示列」。
- 待人工：真机起草一次 goal（超限被拒/重问；合规时状态列按折行显示）。

## 收尾

- 条目「起草 goal 时限制首句字数（≤40 显示列）」：完成 → 从 `docs/BACKLOG.md` 移除（余下条目重编号）。
- 覆盖边界：宿主 `create_goal` / `/goal` 命令路径无起草期约束（显示层口径一致）。
- 本文件移入 `docs/archived/`。
