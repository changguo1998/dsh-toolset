# 代码块排版：`\t` 展开为 4 个空格并保证底色填满整行（接取条目：`TUI/docs/BACKLOG.md`「#1 代码块排版…」）

状态：测试　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

围栏代码块内的制表符在出行前**固定展开为 4 个空格**（不按终端 tab stop 8 列推进），展开后再参与宽度计算、折行与底色补齐，使行号列、`↩` / `↪` 标记与续行缩进都对齐，灰底到右缘连续无断口。

交付：正文与思考区共用的预折路径、宽未知的退化路径、紧凑模式 fence 行三处口径一致；含 `\t` 的代码块用例。

边界：不改行内代码的处理（是否同样展开待实现时裁定）；不改 tab 之外的空白与缩进语义；不改代码块的配色与竖线形制。

## 调研

来源：源码阅读 + 本机实测（`node --experimental-transform-types` 直接调 `buildBox` / `fillBoxTree`，2026-10-23）。

**现状链路**（一处制表符会经过的全部宽度相关点）：

1. 计宽：`charWidth`（`TUI/src/app/layout/markdown.ts:538-566`）对 `\t`（U+0009）落到默认 1 列；`displayWidth` 同口径。终端把 tab 推进到下一个 tab stop（通常每 8 列），且推进量与当前列有关（列 4 处是 4 列，列 5 处是 3 列）——两侧永远不可能一致。
2. 出行路径三条（本任务要求口径一致的三处）：
   - **预折路径**（`codeBlockRows`，`build-box.ts:272-327`）：宽已知时按 `displayWidth` / `takeWidth`（`wrapCodeRows`，`build-box.ts:230-260`）构建期预折，续行缩进 4 列、行尾 `↩` / 行首 `↪`、右侧补白到内容宽；每物理行一个节点交 fill。
   - **宽未知退化路径**（同函数 `avail === undefined` 分支，`build-box.ts:300-304`）：`barLine(num + src)` 单节点交 fill，由 `fillParagraph` 的 `fillBg` 分支调 `wrapCodeLine`（`markdown.ts:806-818`）折行与底色补齐。
   - **紧凑模式 fence 行**（`build-box.ts:883-892` 与 `:1001-1008`）：`activityCompact.reply` 打开时围栏开栅行只置 `inFence = true`，fence 内 final 行按原始 `line.text` + `fillBg: true` + `width: fill` 交 fill → 同样走 `wrapCodeLine`；非 final 行先经 `compactRenderedLine` 压行（其末尾 `\s+` 归一已把 tab 变单空格）。
3. 底色补齐：`fillParagraph` 按 `rect.w - prefixW - suffixW` 传 `bodyW` 给 `wrapCodeLine`，后者折行后按**计算宽**补 `bg: "code"` 空格到 `bodyW`（`markdown.ts:812-818`）；`codeBlockRows` 的 `barLine` 另声明 `width: { mode: "fill" }` 让节点撑满。补白量因此跟随「算出来的宽」，与终端实际列不符。

**实测证据**（内容宽 30，同一窗格）：

- 预折路径：`\tindent();` 出行后文本仍是 `"┃ 1 \tindent();……"`，`displayWidth` 报 30（tab 记 1 列），终端实际多 3 列 → 右侧溢出；
- 预折折行：`"\tfoo(a, b, c) + bar(d, e, f) + baz(g, h, i);"` 按 1 列计宽折在 `baz(` 前（算出 40 列），终端实际 43 列 → 首行溢出、续行缩进与 `↩` 位置随之错位；
- 宽未知路径：`"\tindent();"` 出行后仍是 `"┃ 1 \tindent();……"`，同样记 30 实显 33；
- 紧凑 fence 行：`"┃\tindent();……"`，同样是「算 30 实显 33」；
- 思考区代码块：与正文同函数，同样残留 `\t`；
- 三条路径的补白都用 `bg: "code"` 空格铺到内容宽，故一旦展开正确，底色自然连续。

**结论**：`\t` 必须在**计宽之前**变成固定列宽的空白字符（空格）；只在补白端做任何补偿都无法与终端列位置对齐（tab 推进量随列变化）。当前仓库没有任何展开逻辑（`grep -rn 'replace(/\t' TUI/src` 零命中）。

## 决策

决策项 1：展开放在哪一层？
（a）只在 `codeBlockRows` 与紧凑 fence 分支各自展开；（b）在 `markdown.ts` 新增纯函数，`codeBlockRows` 逐行展开 + `wrapCodeLine` 直算路径展开（覆盖所有灰底代码行）；（c）改 `charWidth` 让 `\t` 计 4 列、文本保留 tab。
选定 **b**。理由：`wrapCodeLine` 是全部灰底代码行的唯一宽度出口（还服务审批面板 `ApprovalPrompt` 与 `panel.ts` 的 fence 行），在它内部展开能让「算宽 = 终端列」对这三处之外也成立；`codeBlockRows` 必须在预折**之前**展开（它自己算行号列与补白量），否则预折点仍按 1 列。c 被排除：终端仍看到真 tab，推进量随列位置变化（8 的倍数），按固定 4 列算宽只能更错。

决策项 2：展开宽度口径？
（a）固定 4 个空格；（b）按终端 tab stop（8 列、随列位置补齐）。
选定 **a**。理由：条目明确要求固定 4 列；按 tab stop 补齐会让同一段代码在不同缩进位置显示不同宽度，排版不可预期。

决策项 3：行内代码（`` `x` ``）里的 `\t` 是否同样展开？
（a）本次不展开，仅围栏块；（b）全文本统一展开。
选定 **a**。理由：条目边界写明「不改行内代码的处理」；行内代码中的真 tab 极罕见，且展开需侵入行内 markdown 解析（`wrapAssistantLine`）与列表前导缩进的口径（`listDepthOf` 另有自己的 tab 计法），属另一条任务。残留记入「偏差」节。

决策项 4：是否同时改 `charWidth` 的 `\t` 计宽？
（a）不改（展开后展示面不再有 tab 参与计宽）；（b）改为 4 列。
选定 **a**。理由：改 `charWidth` 会连带影响用户块 / 普通正文里的真 tab（终端按 tab stop 推进，与固定 4 列也不一致），且与本任务「代码块展开」的口径无关；保持单一改动点。

## 规划

任务拆分（与 task-engine 树一致）：a1-research（本文件调研与决策）→ a1-impl（代码）→ a1-test（用例）。

### 计划改动文件清单

- `TUI/src/app/layout/markdown.ts`：新增 `expandCodeTabs` 纯函数；`codeLineRows`（`wrapCodeLine` 直算路径）先展开再计宽。
- `TUI/src/app/layout/build-box.ts`：`codeBlockRows` 逐行展开后再参与预折 / 行号列 / 补白。
- `TUI/tests/code-block-tab.test.ts`（新增）：预折、宽未知、紧凑 fence、思考区四条路径的 tab 用例。
- `TUI/docs/implementation/2026-10-22-code-block-tab.md`（本文件）。

### 明确不做

- 行内代码、用户块、普通正文与列表前导缩进的 tab 口径（见决策项 3 / 4，残留记入「偏差」）。
- 共享文档（`TUI/docs/BACKLOG.md`、`TUI/docs/SPEC.md`、`TUI/README.md`、`TUI/docs/COMMANDS*.md`）与根级文件：按并行任务约定由主分支代理统一回写。
- 真机验收：本任务以单测与 demo 级验证为准，真机留到主分支人工确认。

### 验收

- 含 `\t` 的围栏代码块：每行 `\t` 显示为 4 个空格，输出不含 `\t`；折行、行号列、续行缩进与 `↩` / `↪` 位置按展开后的宽度算；每行（含补白）显示宽恰为内容宽，底色到右缘连续。
- 三条出行路径（预折 / 宽未知 / 紧凑 fence）与思考区代码块口径一致。
- 既有 `TUI/tests/code-block-gutter.test.ts` 等代码块断言全绿，全量 TUI 测试全绿。

## 实现记录

2026-10-23（提交前门禁：`cd TUI && npm run check` 与 `npm run build` 均通过；本工作树没有 `node_modules`，临时软链到主检出的 `TUI/node_modules`，软链属工作树环境准备、不进提交）：

- `TUI/src/app/layout/markdown.ts`：新增 `expandCodeTabs`（`\t` → 固定 4 空格，无 tab 时原样返回）与常量 `CODE_TAB_WIDTH = 4`；`codeLineRows`（`wrapCodeLine` 直算路径）先 `expandCodeTabs(text)` 再计宽 / 折行 / 补底色。
  - 覆盖：宽未知退化路径（`barLine` → `fillParagraph` fillBg → `wrapCodeLine`）、紧凑模式 fence 内 final 行（同走 fillBg），顺带覆盖审批面板与 `panel.ts` 的 fence 行（同一 `wrapCodeLine` 出口）。
- `TUI/src/app/layout/build-box.ts`：`codeBlockRows` 逐行 `expandCodeTabs` 后再预折（含行号列、续行缩进、`↩` / `↪` 预留位与补白量）；补一行注释说明终端 tab stop 与计宽不一致。
- 实测复核（临时 `node --experimental-transform-types` 脚本，内容宽 30）：预折、宽未知、紧凑 fence、思考区四条路径的 `\tindent();` 均输出 `"┃ 1     indent();…"`（4 空格），每行 `displayWidth` 恰为 30、无 `\t` 残留；含 `\t` 的长行按展开后的宽度折行，`↩` / `↪` 与右缘对齐。

## 偏差

- 行内代码（`` `x` ``）里的 `\t` 本次不展开（决策项 3 选定 a）：条目边界如此，且展开需改动行内 markdown 解析与列表前导缩进的 tab 口径。若真机出现行内代码 tab 导致的行宽偏差，另开条目。
- 普通正文 / 用户块里的真 `\t` 同样按 1 列计宽（决策项 4 选定 a，未改 `charWidth`）：本次范围仅围栏代码块，残留同上。

## 测试与证据

2026-10-23，命令均在 `TUI/` 下执行：

- `node --experimental-transform-types --test tests/code-block-tab.test.ts` → 6 例全通过（`tests 6 / pass 6 / fail 0`）。用例：
  - `expandCodeTabs` 纯函数：`\t` → 4 空格、无 tab 原样返回；
  - 预折路径：`\tindent();` → `┃ 1` + 4 空格 + 代码，行宽恰为 40（内容宽），行尾是代码底色段；
  - 预折路径长行：`\tfoo(a, b, c) + bar(d, e, f) + baz(g, h, i);` 按展开后的宽度折行，首行尾 `↩` / 续行首 `↪`，每行宽 40 且无 `\t`；
  - 宽未知路径（`buildBox` 不带 width → fill 折行）：展开后行宽恰为 40；
  - 紧凑模式 fence 行（`activityCompact.reply`）：竖线后 4 空格，灰底铺到正文右缘（`W - USER_MIN_LEFT_GUTTER`），行宽 40；
  - 思考区代码块：同一构建器，行号列后 4 空格、行宽 40。
- `npm test`（TUI 全量，`scripts/test.sh`）→ `tests 1689 / pass 1689 / fail 0`（duration 约 7.8s），既有代码块与排版断言全绿。
- `npm run check`（`tsc --noEmit`，含 tests）→ 通过；`npm run build` → 通过。
- 未做真机验收（按并行任务约定留到主分支人工确认）；共享文档与根级文件未改。
