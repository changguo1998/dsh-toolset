# 审批面板焦点窗（BACKLOG: TUI#3.3.4）

状态：关闭　　开启：2026-09-26　　关闭：2026-09-26

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

审批面板改为与问答面板同构的两窗操作：`Tab` 切「描述窗（草稿）/ 选项窗（批准 / 拒绝）」，`↑/↓` 按焦点窗分派（滚草稿 / 移动选项），焦点指示沿用 3.2.8 口径（描述窗黄滑块、选项光标失焦降色、提示区 `▶草稿` / `▶选项` 前缀）。

## 调研

- 现状（3.2.4 起）：审批面板只有 `approvalFocus`（`approve` / `reject`），`↑/↓` 固定给草稿滚动、`←/→` 切选项，没有「焦点窗」概念。草稿仅数行时 `↑/↓` 无内容可滚 → 人工验收判为「上下箭头失效」。
- 问答面板（3.2.1 / 3.2.7 / 3.2.8）已有成熟口径：`item.focus: "desc" | "options"`、Tab 切窗、`↑/↓` 分派、描述窗左侧 1 列按「是否超屏」渲染滚动条或焦点条、选项光标失焦降色、提示区前缀标出焦点窗。审批面板照此对齐即可，无需新概念。

## 决策

- `state.ts`：新增 `approvalWindow: "desc" | "options"`（打开时归 `options`，与问答面板缺省一致）与 `approval-tab` action（切换，`focusApproval` / `setApproval` 同步清空无效键提示）。
- `index.ts`：`Tab` → `approval-tab`；`↑/↓` 按 `approvalWindow` 分派（`desc` → 滚草稿；`options` → 在批准 / 拒绝间移动）；`←/→` 保留为切选项快捷；`Enter` 提交当前选项；`1/2`、`y/n` 仍直答；`Esc` 取消。
- `components/ApprovalPrompt.ts`：`ApprovalView` 增 `window`；描述窗左侧列按 `window === "desc"` 着黄（可滚动时为滑块、否则整列焦点条），选项光标行仅在 `window === "options"` 时着黄。
- `layout/hints.ts`：`approvalHintLine(state)` 以 `▶草稿` / `▶选项` 前缀 + 紧凑 `·` 分隔列出当前可用键（无效键提示仍优先）。

## 规划

计划改动文件清单：`src/app/state.ts`、`src/app/index.ts`、`src/app/layout/hints.ts`、`src/app/layout.ts`、`src/app/components/ApprovalPrompt.ts`、`tests/approval-panel.test.ts`、`tests/app.test.ts`、`tests/fixtures/focus-frame-legacy.json`、`demo/main.ts`（提示行断言语）、`docs/SPEC.md` §7.1、`docs/IMPLEMENTATION.md`。

不做：问答面板操作方式、审批的其它按键、3.2.4 的选项语义。

## 实现记录

- `state.ts`：`approvalWindow`（`desc` / `options`，打开归 `options`）+ `approval-tab` action + `toggleApprovalWindow()`（切窗顺带清空无效键提示）。
- `index.ts`：`Tab` → `approval-tab`；`↑/↓` 按 `approvalWindow` 分派（草稿 → `approval-scroll`；选项 → `approval-focus` 切换）；`←/→` 保留切选项快捷；`Enter` / `y` / `n` / `1` / `2` / `Esc` 语义不变。
- `components/ApprovalPrompt.ts`：`ApprovalView.window`；描述窗左侧列按 `window === "desc"` 着黄（可滚动 = 滑块、不滚动 = 整列焦点条），选项光标行仅在 `window === "options"` 时着黄。
- `layout/hints.ts`：`approvalHintLine(state)`（`▶草稿` / `▶选项` 前缀 + 紧凑 `·` 分隔，与 `questionHintLine` 同口径）。
- `layout.ts`：把 `approvalWindow` 传入面板。
- 测试 / 基线 / 冒烟：`tests/app.test.ts` 新增「Tab 切焦点窗、↑/↓ 随焦点窗分派」用例（断言用去色文本，避免 SGR 颜色码干扰）；`demo/main.ts` 提示行断言语更新；冻结基线重跑。

## 测试与证据

- 全量 `node --experimental-transform-types --test tests/*.test.ts`：**1138 pass / 0 fail**。
- `npm run demo -- --smoke`：**43 pass / 0 fail**；冻结基线重跑（提示行改为 `▶选项·…·[Tab]草稿·[1/2]直答`）。
- `npm run check` / `npm run build` 通过。
- 人工复验点：`Tab` 切窗后提示前缀变化、`↑/↓` 在选项窗移动 `>`、在草稿窗滚草稿且选项不动、描述窗聚焦时左侧列变黄。

## 收尾

- 条目 3.3.4 标「完成」；文档回写 `docs/SPEC.md` §7.1 与 `docs/IMPLEMENTATION.md`；本追踪文档归档 `TUI/docs/archived/`。
- 未做：问答面板操作方式（保持不变）、审批其它按键语义。
- 遗留：`main.ts` 的 `approvalTimeoutMs` 仍为 **10s（TEMP-TEST）**——人工验收超时自动关闭后需还原 60_000。
