# 符号审查豁免代码段与引用示例（接取条目：symbol-normalizer「符号审查未豁免代码段与引用示例」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

回合审查前**掩码围栏代码块与内联代码**，使其中的「符号引用示例」不再被判违规（现象：正文写「别名替换（`✔→✓`、`❌→✗`）」被命中并注入模型反馈）。

## 决策（择一落地）

条目给了三条修法：① 审查前掩码代码段；② 引用示例（紧邻 `→`/`->` 或成对出现）不记违规；③ 粒度细化（只提示人不注入模型）。

- 本次只做 **① 掩码**：它对应实测场景（代码段/内联代码里的引用），改动最小且可判定。
- ② 需要启发式（「引用 vs 真实使用」本质模糊），③ 会把「提醒模型」的能力削弱；两者都不做，若掩码后仍有误伤再另立条目。
- **展示层归一不受影响**：TUI 的 `normalize(text)` 仍做全文别名替换（本条目只治理「审查」，不改展示行为）。
- 掩码用等长空白替换（保留字符串长度），避免与上游 `normalizeSymbols` 的偏移/索引口径发生错位。

## 规划

计划改动文件清单（**只改这些**）：

- `symbol-normalizer/docs/BACKLOG.md`（条目状态）
- `symbol-normalizer/docs/implementation/2026-09-29-mask-code-spans.md`（本文件）
- `symbol-normalizer/src/symbols.ts`（新增 `maskCodeSpans`）
- `symbol-normalizer/src/review.ts`（审查前掩码）
- `symbol-normalizer/tests/`（新增掩码用例：围栏块 / 内联 / 未闭合围栏 / 散文仍命中）

关闭时按需回写：`symbol-normalizer/README.md`（审查口径加一条边界）。

明确不做：不改展示层归一、不改冷却与注入通道、不实现修法 ②③。

## 实现记录

- `src/symbols.ts`：新增 `maskCodeSpans(text)`——依次掩码闭合围栏（`…` / ~~~…~~~）、未闭合围栏（掩到文末）、内联代码（`…`，含多反引号）；替换为**码点等长空格**，保证下游按码点扫描的偏移口径不错位。
- `src/review.ts`：`review()` 里改为 `normalizeSymbols(maskCodeSpans(text), rules)`（注释标明用途与条目归属）。
- 展示层 `normalize(text)` 未改（TUI 流式正文仍做全文别名替换——本条目只治理「审查」）。

## 测试与证据

- `tests/symbols.test.ts`：新增 3 例——① 围栏 + 内联等长掩码且散文保留；② 未闭合围栏掩到文末、围栏前散文保留；③ 多反引号与 `~~~` 围栏同样掩码。
- `tests/review.test.ts`：新增 1 例——内联代码与围栏块里的 `❌/✔/⭐/✗` 引用示例**不判违规**（返回 `null`），同一审查器对散文里的真实 `❌` 仍产出 `请将「❌」改为「✗」` 反馈。
- 结果：`npm --prefix symbol-normalizer run test` → 33 例全通过（原 29 + 新 4）；`run check` 0 error。
- 真机复验（2026-09-29，通过）：某一回合正文含 3 处 `❌`（2 处在行内代码/围栏块、1 处在散文），会话日志显示反馈只报散文那一处 → 代码位置被掩码；实测脚本对同一回合正文复算：掩码后仅剩散文处 `❌`。
- 附带确认：审查文本 = 回合**可见正文**（宿主 `assistant/message` 的 `text` 块，`reasoning` 不计入），故推理过程里的符号不会触发反馈。

## 收尾

- 条目 F1 标记完成并从 `symbol-normalizer/docs/BACKLOG.md` 移除；本文件移入 `symbol-normalizer/docs/archived/`。
- 回写 `symbol-normalizer/README.md`：审查口径加「行内代码与围栏代码块豁免」一条。
