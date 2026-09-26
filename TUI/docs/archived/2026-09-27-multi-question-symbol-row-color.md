# 多题符号行「题号 + 符号」同色（BACKLOG: TUI#15）

状态：关闭　　开启：2026-09-27　　关闭：2026-09-27

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

多题问答面板顶部符号行（如 ` 1○ 2□ 3△`）现为「**题号恒灰、当前题符号黄**」——同一题的题号与符号颜色不一致。改为**按题同色**：当前题的题号与符号均黄、其余题的题号与符号均灰。符号几何、间距与超宽截断口径不变（沿用 TUI#4 定稿）。

## 调研

- 现状（`src/app/components/QuestionPrompt.ts` 的 `buildSymbolRow`）：`push(String(i + 1), { fg: "gray" })` 与 `push(sym, { fg: i === active ? "yellow" : "gray" })` —— 题号恒灰、符号按当前题取黄。
- 基线：`tests/fixtures/focus-frame-legacy.json` **无多题场景**（`grep 1○` 0 命中）→ 本改动不触发冻结基线重跑。

## 规划

计划改动文件清单：

- `src/app/components/QuestionPrompt.ts`（`buildSymbolRow` 按题统一取色）
- `tests/question-window.test.ts`（符号行着色断言：当前题号 + 符号皆黄、其余皆灰）
- `docs/SPEC.md` §7.1、`README.md`（口径回写）
- 本追踪文档

不做：符号几何 / 间距 / 截断口径；单题面板（无符号行）；冻结基线（无需重跑，见「调研」）；`docs/IMPLEMENTATION.md`（其表述「当前题黄」已覆盖本改动，无需改）。

## 实现记录

- `components/QuestionPrompt.ts` 的 `buildSymbolRow`：题号与符号改为按题统一取色（`itemColor = { fg: i === active ? "yellow" : "gray" }`，题号与符号共用），函数头注释同步；几何 / 间距 / 截断口径不变。
- 测试：`tests/question-window.test.ts` 的「多题符号行」用例改写——当前题断言题号 + 符号皆黄、其余题两项皆不黄；新增「`question-nav` 切到第 2 题后，第 2 题题号 + 符号（`□`）皆黄、第 1 题两项皆灰」。
- 文档：`docs/SPEC.md` §7.1（「题号与符号同色——当前题均黄、其余均灰」）、`README.md`（问答面板段）。

## 测试与证据

- `npm run check`：通过；`./scripts/test.sh` 全量：**1155 通过 / 0 失败**（用例总数不变，新断言并入既有用例）；`npm run build`：通过；`npm run demo -- --smoke`：0 × `SMOKE_FAIL` / 43 × `SMOKE_PASS`（按 #14 口径不依赖 `SMOKE_OK` 标记）。
- 着色核对（`tmp/check-symbol-row.mts`，已删）：active=0 → `1`+`○` 黄、`2`+`□` 与 `3`+`△` 灰；active=1 → `2`+`□` 黄、其余灰。
- 冻结基线未重跑：基线无多题场景（`grep 1○` 0 命中），全量中的 focus-frame 基线用例全绿。
- 未验证：真机目视（人工项，需用户重启后进行）。

## 收尾

- 条目 TUI#15 标「完成」；文档回写 `docs/SPEC.md` §7.1 与 `README.md`；本追踪文档归档 `TUI/docs/archived/`。
- 未做：符号几何 / 间距 / 截断口径（沿用 TUI#4 定稿）；单题面板（无符号行）。
