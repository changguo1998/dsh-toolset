# 回合分隔线 / step 头宽度收到正文右缘，并归入所属段

状态：待提交　　开启：2026-10-27
接取条目：`TUI/docs/BACKLOG.md`「回合分隔线与 step 头的宽度收到正文右缘」。
本文件是本任务唯一的过程记录与文档变更落点。

## 现象与期望

- 现象：回合分隔线（`╌╌ 03:04:05 ⇆164 ╌…`）与 step 头行比正文多出 2 列——内容层已铺到
  文字排版宽，拼帧层又用 `╌` 补到 `contentW` 并在右缘框列补 `╌`（`layout.ts` 的 `padSegs`
  与 `grid.rightEdgeGlyph`）。用户观感是「分隔线比正文长」。
- 期望（用户 2026-10-27）：分隔线宽度与文本宽度一致；层级为 `pane → 每段一个盒 → 盒内 header 与 reason / assistant / user / call 平级`，且该行**不画**段盒的左竖线 `┃`。

## 实现

- `TUI/src/app/layout/pipeline/structure.ts`
  - `toPaneTree`：头类条目（`turn-header` / `step-header`）先攒着，遇到后随的段时并入**同一槽位**
    ——正文 / 思考段里标 `bare` 塞进内容 v（与各块同级）；用户段是右对齐盒（spacer + 符号 +
    内容），头行进不去它的内容列，提到段盒外层（槽位 = `v[头行盒, 用户盒]`）。攒不到后续段时
    按独立槽位收尾（`flushPending`），不丢行。
  - `toBarBox`：把 `bare` 头行从装饰盒里提出、包成 `headerRowBox`（`v fill[头内容]`）
    ——因此不画左竖线，横向铺满 pane 文字宽（右端 = `contentStartCol + dialogueTextW − 1`，
    与正文 / 用户块右竖线同列；120 列屏、状态列 40 时为第 117 列）。
- `TUI/src/app/layout.ts`：`padSegs` 补白字符由 `TURN_SEPARATOR_CHAR` 改为空格（`ruleRow` 分支删除）。
- `TUI/src/app/layout/grid.ts`：`rightEdgeGlyph("rule")` 返回空白占位（此前返回 `╌`）。

## 测试

- `TUI/tests/grid.test.ts`：右缘字形用例改为「回合分隔行留空」。
- `TUI/tests/pane-text-margin.test.ts`：原「横线一律铺到屏幕最右列」改为「回合分隔线右端
  = 正文排版右缘（`histFrom + dialogueTextW − 1`）」，边框行仍满宽。
- `TUI/tests/pipeline-structure.test.ts`：回合头用例改为断言头行盒形态
  （`v fill[分隔头 h[文本盒 + ╌ 填充盒]]`，`prefix` / `suffix` 均为 undefined）。

## 证据

- `npx tsc -p tsconfig.json --noEmit` 通过。
- `npm test`（TUI 全量）**1799 例全绿**。
- `npm run build` 通过；`npm run demo -- --smoke` 输出 `SMOKE_OK`。

## 收尾

（待关闭时填写。）
