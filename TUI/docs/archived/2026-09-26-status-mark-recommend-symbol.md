# 面板状态标记改用推荐符号（BACKLOG: TUI#3.2.9）

状态：关闭　　开启：2026-09-26　　关闭：2026-09-26

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把问答 / 审批面板标题里的状态标记 U+26A0（旧的面板状态标记） 换成项目推荐符号 `△`，使 UI 文案与符号规范（以及输入侧归一结果）一致。

## 调研

- `src/app/symbols.ts`：`"U+26A0": "△"`（归一映射；理由注释「emoji 呈现为填色，与 ✓/✗ 细线风格不一致 → 换空心三角 △」），且 U+26A0（旧的面板状态标记） 属 `EMOJI_ORIGIN`（emoji 起源别名集）。
- 输入文本（模型输出 / 用户输入）里的 U+26A0（旧的面板状态标记） 会被 `normalizeSymbols` 归一为 `△`；而 UI 文案（面板标题）由布局层字面拼接、不经归一 —— 直接输出 U+26A0（旧的面板状态标记），两处口径不一致。
- 宽度不受影响：`layout/markdown.ts` 的 `NARROW_TEXT_SYMBOLS` 把 `0x26A0`（U+26A0）按 1 列计，`△`（U+25B3）实测同为 1 列（`charWidth("△") === 1`）。

## 决策

1. 面板文案改用 `△`（白名单族代表、宽度 1 列、与 `✓`/`✗` 风格一致），`slice(" U+26A0 ".length)` 之类的长度锚点同步为 `" △ "`（两者都是 3 个字符，宽度亦相同）。
1. 输入侧的归一机制、`symbols.test.ts`（U+26A0 → △ 归一用例）、`layout.test.ts` / `width-eaw.test.ts`（U+26A0 宽度用例）**保持不动**——它们覆盖的是输入与宽度规则，与 UI 文案无关。
1. `markdown.ts` 的 `0x26A0` 条目保留（防其它路径出现），注释补充「面板文案已改用 △」。

## 规划

计划改动文件清单：`src/app/components/QuestionPrompt.ts`、`src/app/components/ApprovalPrompt.ts`、`src/app/layout/markdown.ts`（注释）、`tests/app.test.ts`（标题断言）、`tests/fixtures/focus-frame-legacy.json`（重跑）。

不做：不改 `symbols.ts` 的归一表与 `EMOJI_ORIGIN`；不动输入侧反馈机制。

## 实现记录

- `components/QuestionPrompt.ts`：题头文案 ` U+26A0 …` → ` △ …`（plan-review 与普通两处），`seg(" U+26A0 ")` → `seg(" △ ")`，长度锚点 `slice(" U+26A0 ".length)` → `slice(" △ ".length)`（两者同为 3 字符、同为 1 列宽）。
- `components/ApprovalPrompt.ts`：`APPROVAL_TITLE` 由 `" U+26A0 [审批] 等待审批 "` 改为 `" △ [审批] 等待审批 "`。
- `layout/markdown.ts`：`NARROW_TEXT_SYMBOLS` 的 `0x26A0` 条目注释更新为「面板文案已改用 △；条目保留以防其它路径出现」。
- `tests/app.test.ts`：审批标题用例名与 SGR 断言改为 `△`。
- 冻结基线重跑：面板标题行由 U+26A0（旧的面板状态标记） 变为 `△`（问答与审批两处），其余不变。

## 测试与证据

- `npm run check` / `npm run build`：通过。
- 全量 `node --experimental-transform-types --test tests/*.test.ts`：全绿（含符号归一/宽度用例——`symbols.test.ts` 的 `U+26A0 → △` 归一用例、`layout.test.ts` / `width-eaw.test.ts` 的 U+26A0（旧的面板状态标记） 窄宽用例按决策 2 保持不变）。
- `npm run demo -- --smoke`：`SMOKE_OK`，无 `SMOKE_FAIL`。
- 冻结基线：`tests/fixtures/focus-frame-legacy.json` 中 `│ U+26A0 等待审批` → `│ △ [审批] 等待审批`、`│ U+26A0 请回答（第 1/1 题）` → `│ △ [单选] 请回答（第 1/1 题）`。
- UI 与输入侧口径一致：输入文本里的 U+26A0（旧的面板状态标记） 归一为 `△`（`symbols.ts`），面板文案现在直接输出 `△`，不再出现两种字形。

## 收尾

- 条目 3.2.9 标「完成」；文字口径统一为 `△`（源码注释、测试、冻结基线、归档文档）。
- 未做：不改 `symbols.ts` 的归一表与 `EMOJI_ORIGIN`；输入侧反馈机制（U+26A0（旧的面板状态标记） 触发「请将「U+26A0」改为「△」」）保持原样。
- 本追踪文档归档 `TUI/docs/archived/`。
