# markdown 缓存键去 themeId（接取条目：`TUI/docs/BACKLOG.md`「`markdown.ts` 缓存键去掉 `themeId`」）

状态：进行中（2026-10-10 接取）

## 目标

- 排版缓存的键只留「文本 + 宽度」——换主题不再让整片缓存失效重排。
- 摘掉排版路径上不读主题的 `themeId` 参数链（纯噪声），渲染 / 焦点 / 状态侧真正用主题的地方保留。

## 调研

- `themeSizedKey` 定义在 `TUI/src/app/layout/cache.ts:83`，全仓唯一调用方就是 `markdown.ts` 三处：`:599`（`parseInlineMarkdown`）、`:703`（`wrapInlineMarkdown`）、`:821`（`wrapAssistantLine`）。
- 解析 / 折行不读主题：`inlineSegments`（`markdown.ts:605`）只产**语义色**（`fg: "blue"` / `bg: "code"` / `strike` 等），主题 → 实际颜色的映射在渲染层（`TUI/src/renderer/theme.ts`）；`markdown.ts:604` 注释自述「行内 token 样式为语义色，主题仅进缓存键」。
- `themeId` 透传链（每一跳都只为继续往下透传给 markdown）：
  - `layout.ts` 的 `state.themeId` → `buildBox` 选项（`layout/build-box.ts:60`，只被 `:570` `tableBox` 与 `:921` fill 上下文两处消费）；
  - → `FillContext.themeId`（`layout/fill.ts:26`，只被 `:395` `wrapAssistantLine(p.text, bodyW, ctx.themeId)` 消费）；
  - → `markdown.ts` → 缓存键。
  - 旁支：`layout/table.ts`（11 处内部函数）、`layout/panel.ts:170`（`panelMarkdownRows`）、`components/QuestionPrompt.ts` 与 `components/ApprovalPrompt.ts` 的面板布局函数（同样只透传）。
- 真需要主题的地方：`renderer/theme.ts` 的主题映射、`AppState.themeId`、`index.ts` 的 `set-theme`、交给渲染层的主题（焦点绘图取语义色 `focusColor()`，**不读** `themeId`——见下方审阅修正）。
- 现状影响（**2026-10-10 审阅修正**）：换主题**不会**触发全屏重排——行缓存键是「pane + 宽 + 档位 + 紧凑」（`layout/pipeline/rows.ts:459-469`）、box 缓存按节身份稳定（`layout/pipeline/boxes.ts:303`），主题都不在内，`/theme` 也不清缓存。真实代价有两条：① 换主题后**任何重新进入折行**的文本（面板每帧 `fillPanelBox → fillBoxTree` 重填、新物化 box 的重复文本）都要按新主题重折一遍；② 三处 markdown 缓存按主题各存一份（同文本双份占用、命中率减半）。

## 决策

- **D1 范围**：只摘「排版内容路径」的 `themeId`——`markdown.ts` → `table.ts` / `panel.ts` / `fill.ts` → `build-box.ts` 选项 → `layout.ts` 调用点；渲染 / 焦点 / 状态 / 组件 `render*` 侧保留。
- **D2 键**：三处改 `sizedKey(text, width)`；`themeSizedKey` 随之成为死代码 → 从 `cache.ts` 删除（判据：全仓零引用）。
- **D3 签名**：`parseInlineMarkdown(text)`、`wrapInlineMarkdown(text, width)`、`wrapAssistantLine(text, width)`、`assistantLineRows(text, width)`；`table.ts` 内部 cell 函数与 `tableBox(table, width)`；`panelMarkdownRows(text, width)`；`FillContext` 去 `themeId`、`fillBoxTree(box, height, width)`；`BoxOptions` 去 `themeId`；`QuestionPrompt` / `ApprovalPrompt` 中只用于透传的布局函数去参（`render*` 保留）。
- **D4 测试**：直接调用上述 API 的用例去掉 `themeId` 实参；`tests/layout-cache.test.ts` 的主题维度用例改为「跨主题同值 + 换主题排版逐字节一致」；新增「换主题后重复帧零重排（`rowRenderMisses()`）」用例。
- **D5 文档**：`TUI/docs/SPEC.md`（`tableBox` 签名 `:202`、缓存键口径 `:830`）与 `TUI/docs/DESIGN.md` 相关描述同步；`markdown.ts:604` 注释改写。
- **D6 明确不做**：不动渲染层主题映射与 `state.themeId`；不改面板 markdown 的渲染行为（只去参数）；不顺手清与主题无关的 `layout.ts` 死代码（那是 BACKLOG 条目「旧排版遗留死代码清理」）。

## 规划

计划改动文件清单：

- src：`TUI/src/app/layout/cache.ts`、`layout/markdown.ts`、`layout/table.ts`、`layout/panel.ts`、`layout/fill.ts`、`layout/build-box.ts`、`layout.ts`、`components/QuestionPrompt.ts`、`components/ApprovalPrompt.ts`（视 `tsc` 结果收尾）。
- tests：`layout-cache.test.ts`、`table.test.ts`、`fill.test.ts`、`panel.test.ts`、`tool-call-wrap.test.ts`、`content-mapping.test.ts`、`activity-*.test.ts`、`layout4.test.ts`、`layout-horizontal.test.ts`、`layout.test.ts`、`help.test.ts`、`turn-separator.test.ts`、`pipeline-equivalence.test.ts`、`code-block-gutter.test.ts`（视 `tsc` 结果收尾）。
- 文档：`TUI/docs/SPEC.md`、`TUI/docs/DESIGN.md`（如涉及）、`TUI/docs/BACKLOG.md`（进行中 → 完成）。

## 实现记录

- 2026-10-10 接取当天完成主体：
  - `layout/cache.ts`：删 `themeSizedKey`（改动后全仓零引用）。
  - `layout/markdown.ts`：三处缓存键改 `sizedKey(text, width)`；`parseInlineMarkdown(text)` / `wrapInlineMarkdown(text, width)` / `wrapAssistantLine(text, width)` / `assistantLineRows(text, width)` 去 `themeId`；`:604` 注释改「行内 token 样式为语义色，主题只在渲染层加」。
  - 内容链路去参：`layout/table.ts`（`tableBox(table, width)` 与内部 `cellPlainText` / `cellLeaf` / `rowBox`）、`layout/panel.ts`（`panelMarkdownRows(text, width)`）、`layout/fill.ts`（`FillContext` 去 `themeId`、`fillBoxTree(box, height, width)`）、`layout/build-box.ts`（`BuildBoxOptions` 去 `themeId`；`RenderOptions extends BuildBoxOptions` → 流水线 `render.themeId` 一并退场）、`layout.ts`（`buildContentRows` 选项、审批 / 问答面板构造、`fillPanelBox`、`questionCaretFor`、`buildCommandCompletionBox`、`renderStatusLine` 去形参）。
  - 组件里只为透传主题的形参 / 字段一并摘掉：`QuestionPrompt`（`buildQuestionPanelBox` / `maxDescScrollFor` / `questionCaretFor` / `layoutQuestionPanel` / `renderQuestionPanel`）、`ApprovalPrompt`（`approvalRows` / `maxApprovalScroll` / `buildApprovalBox` / `renderApprovalPrompt`）、`ModelPicker`（`renderModelPicker`）、`CommandCompletion` 与 `StatusPanel`（View 去字段）；`JobsPanel` / `HistoryPanel` / `CommandListPanel` 的薄包装只去实参（View 本就无该字段）。
  - **保留并注明**：`renderer/theme.ts` 的主题映射、`layout/focus-frame.ts` 的 `themeId`（焦点绘图）、`layout.ts:2670` 交给 `focusFrame` 的主题、`AppState.themeId` 与 `set-theme`；`buildStatusSeparator` 的 `void themeId` 属既有的「契约保留」死参，留给条目「旧排版遗留死代码清理」。
  - 测试：约 60 处调用点去 `themeId` 实参 / 字段（`table` / `pipeline-*` / `activity-*` / `content-mapping` / `modelpicker` / `completion` / `turn-separator` / `help` 等）；`tests/layout-cache.test.ts` 去主题维度并新增「换主题：排版结果逐字节一致，主题色只在渲染层加」；`tests/layout.test.ts:426` 的「行内 code 颜色随主题」把主题实参交给 `segsAnsi`（渲染侧）。
  - 文档：`TUI/docs/SPEC.md`（`tableBox` 签名、`panelMarkdownRows` 签名、缓存键口径、§11.1 的 `FrameContext` 去 `themeId` 提及）、`TUI/docs/DESIGN.md`（面板 API 去 `themeId`）、`TUI/README.md:350`（缓存键口径「不含主题」）。
  - **审阅后追加（同日，实现审阅 5 项必改全折）**：
    1. `layout.ts` 的 `buildStatusSeparator`：`themeId` 与 `sepFocus` 两个形参全程只被 `void`（样式由 `focusFrame` 统一覆写），连同只为死参计算的 `statusSepFocus` 块一并删除（`tests/tee-glyph.test.ts` 调用点同步）。
    1. `layout/focus-frame.ts` 的 `FocusFrameContext.themeId` 整文件零读取 → 摘字段与 `layout.ts` 传参（`tests/focus-draw.test.ts` 5 处同步）。
    1. 本次新引入的死引用清零：5 个组件残留的 `ThemeId` import、5 个测试文件残留的 `ThemeId` / `THEME`（判据见「测试与证据」的 `--noUnusedLocals` A/B）。
    1. 修正本文「现状影响」口径（见上）——原写「换主题全屏重排」与行缓存键事实矛盾。
    1. 收尾项（BACKLOG 标完成并移除、追踪文档归档、演示冒烟另立条目）在「收尾」节执行。

## 测试与证据

- `npm run check`：干净；`npm run build`：通过；`npm test`（TUI）：**1424 / 1424 通过**（原 1423 + 新增换主题用例 1）。
- 换主题一致性：新增用例断言同 state 在深 / 浅两主题下**段文本 + 段样式逐字节相同**，而两主题的 ANSI 序列不同（证明主题色确实只由渲染层加）。
- 零重排不回归：`tests/pipeline-frame.test.ts`「同窗重复出帧零重排」与 `tests/pipeline-equivalence.test.ts`「宽度不变 → 命中行缓存，不重排」保持绿。注：行缓存键本就是「pane + 宽 + 档位 + 紧凑」（`layout/pipeline/rows.ts:459`），主题从不进该键——本次修的是 **markdown 三处键**：换主题不再让折行缓存整片失效（旧行为下换主题后再出新内容会把全屏文本重折一遍）。
- 未做：真机目视（本次验收不含真机项；沙箱禁写 `~/.dsh`，无法起真机）。
- **途中发现（非本次改动引入）**：`npm run demo -- --smoke` 在**改动前**的 `HEAD` 上同样有 3 项失败（`step-header`、`activity-mixed-ordered`、`activity-mixed-activity-side`）。判据：`git worktree add /tmp/wt-head HEAD` 后在同一棵干净树上跑同一条命令，失败项与本工作树**逐字相同** → 属演示脚本期望值随六步流水线切换漂移，与主题无关；收尾时另立 BACKLOG 条目交其他 agent。
- 判别力说明（审阅意见）：换主题用例断言的是「排版输出与主题无关」这条**不变量**；对「缓存键去主题」本身**不具判别性**——键里是否含主题在换主题帧里不可观测（行缓存 / box 缓存本就无关主题，缓存命中统计也没有对外出口）。该改动的证据是**结构性**的：`markdown.ts` 三处键为 `sizedKey`（`:595` / `:696` / `:813`）+ `themeSizedKey` 全仓零引用 + 其余 memo 键无主题分量（`markdown.ts:560` / `:769`、`primitives.ts:54` / `:86`、`cache.ts:78`）。若将来要给「折行缓存跨主题复用」加行为断言，需先导出缓存命中统计。
- `--noUnusedLocals` A/B：`035d7ac`（改动前）与当前工作树各 53 条 TS6133/TS6196，**集合完全一致**（`comm` 双向差集为空）→ 本次未新引入死引用。
- 本次实现提交：`82c4a7f`；审阅折叠提交见收尾节的提交清单。

## 收尾

- 关闭：条目「`markdown.ts` 缓存键去掉 `themeId`」2026-10-10 完成，已从 `TUI/docs/BACKLOG.md` 移除（当场重排后编号 1）。
- 回写文档：`TUI/docs/SPEC.md`（`tableBox` / `panelMarkdownRows` 签名、缓存键口径、§11.1 `FrameContext` 去 `themeId` 提及）、`TUI/docs/DESIGN.md`（面板 API 去参）、`TUI/README.md:350`（缓存键不含主题）；`STATUS.md` 按流程不由本任务改。
- 另立条目：**演示冒烟 3 项期望漂移** → 登记为 `TUI/docs/BACKLOG.md` 第 2 条（同工时缺陷优先于重构）。
- 归档：本文件已移入 `TUI/docs/archived/`。
- 提交链：`035d7ac`（BACKLOG 重排）→ `82c4a7f`（实现）→ `74e3d93`（审阅折叠）→ 收尾提交（本文件归档 + BACKLOG 收尾）。
