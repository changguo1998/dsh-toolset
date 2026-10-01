# 历史区分块：按 `[step 变化 | 工具调用行]` 取最近一块正文（接取条目：`TUI/docs/BACKLOG.md`「正文被思考/工具行打断时只有最后一段进历史区，前段被丢」）

状态：已完成　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

历史区只放**最后的总结与正式回复**；分块边界 = `[step 变化 | 工具调用行]`（thinking / notice / 空行**不**切割），取**最近一块的正文**整块进历史区；更早的块留在活动区（下回合随活动区清空）。

用户裁定（2026-10-01）：

1. 历史区只放最后的总结与正式回复；工具调用前后的简短说明不进历史。
1. 分块边界 = `[step 变化 | 工具调用行]`，取**最近一块的全部行**（不再受「≤6 行」「连续段」限制）。
1. 问答面板「提问前正文」来源段用**同一分块口径**；本回合取不到时**先回退**取「上一回合的最近一块」（不加相关性闸门）；显示加 `- 上文 -` 标记；行数与滚动沿用现有实现。
1. 追加裁定（实现期询问）：**最近一块无正文**（只剩宿主补发的空锚点）→ **回退取本回合更早的含正文块**（空块不吞正文）。

## 计划改动文件清单

代码：

- `TUI/src/app/state.ts`：`BufferLine` 增 `step` 标（`appendStream` 落）；新增分块函数（`textBlocks` / `prevSeparator` / `lastTextBlock` / `blockText`，供 `markFinalSummary` 与 `recentQuestionSource` 共用）；`markFinalSummary` 改为「最近一块含正文的全部 assistant 行标 `final`」；`recentQuestionSource` 改为同口径 + 跨回合回退链（并移除旧 `SOURCE_SCAN_MAX` 扫描上限）。
- `TUI/src/app/components/QuestionPrompt.ts`：来源段前加 `- 上文 -` 标记（纯文本行、不经 markdown 解析）。

测试：

- `TUI/tests/state-history-blocks.test.ts`（新增 11 例）：thinking / notice / 空行不切割、工具行切块、step 变化切块、空锚点回退、幂等、来源段整块 / 跨回合回退 / 都无正文为空。
- `TUI/tests/approval-panel.test.ts`：来源段三条用例按新口径更新（不再有扫描上限、整块不限 6 行）。

文档：

- `TUI/docs/SPEC.md` §15.5 新增「历史区正文分块（`final` 标记口径）」小节；`TUI/docs/DESIGN.md`「活动区」一句同步。
- `TUI/docs/BACKLOG.md`：条目接取标进行中，收尾清理移除。
- 本文件。

## 设计

- **step 标**：`appendStream` 落新行时写 `step: state.stepGroup?.step`（`step/start` 已维护 stepGroup；step 头行本身不带标，其 `kind="step"` 即硬边界）——「step 变化」判定靠它，比「仅按 step 头行切」更稳（step 头行可能被裁剪出窗口）。
- **分块**：`textBlocks` 遍历区间，`kind ∈ {tool, step, separator}` 或「相邻两行 step 标不同」即硬边界；块内只收集 `assistant` / `plain` 行（thinking / notice 不切割也不入块）。
- **最近一块**：`lastTextBlock` 从尾部向前找**第一块含非空白正文**的块——位置最近但全空的块被跳过（裁定 4）。
- **回退链**：`recentQuestionSource` = 本回合最近一块 → （无）→ 上一回合最近一块 → （无）→ 空串；回合范围由 `prevSeparator` 界定（不含分隔线本身）。
- **标记位置**：`- 上文 -` 由面板渲染层加（`pushPlain`，避免 `- ` 被 markdown 解析成列表项）；来源段之后仍保留一个空行再接题干。

## 验证

- `npm run check`（TUI 单包 + 仓库根全包）：通过。
- `npm run build`（TUI）：通过（dist 已更新，profile `fff` 走 `link:` 实时可见）。
- `npm run test:tui`：**1273 通过 / 0 失败**（新增 11 例：`state-history-blocks.test.ts`；`approval-panel.test.ts`、`layout4.test.ts` 按新口径更新后无回归）。
- `npm run demo -- --smoke`：SMOKE_OK。
- **真机验证项（待人工确认）**：① 被 reasoning 打断的正式回复，历史区含完整正文（不再只剩尾段）；② 工具调用之前的说明不进历史、之后的正文块进历史；③ 再发一条消息后正文仍完整留在历史区；④ 问答面板来源段显示最近一块全文并带 `- 上文 -`，长来源段滚动表现与现状一致；⑤ 本回合无正文时来源段取上一回合最近一块。

## 过程记录

- 实现期发现 `turnRange` 回退链 bug（把「上一回合」退化成空区间，回退恒为空）→ 改为 `prevSeparator`（返回下标而非区间，段首 = 下标 + 1）后修复，并补「跨回合回退」用例。
- 空块语义歧义（条目边界① vs 内容丢失风险）→ 用一次询问定格：**空块不吞正文，回退取本回合更早的含正文块**（裁定 4，已回填条目边界①）。
- 旧 `SOURCE_SCAN_MAX = 40` 与「至多 6 行」两项限制随分块口径一并移除（整块取用、超长由描述窗滚动与历史窗口承接）。
- `plain` 行按旧行为仍算正文（与 `assistant` 同入块）；`markFinalSummary` 只对 `assistant` 行打 `final`。
