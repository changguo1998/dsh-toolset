# 会话区用户块改为平衡折行（接取条目：`TUI/docs/BACKLOG.md`「会话区用户块改为平衡折行（行数不变、收窄列宽）」）

状态：实现中　　开启：2026-10-18　　关闭：-
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

用户输入提交后, 若折行末行只剩几个字符会显得不平衡。改为: 行数不变的前提下收窄列宽, 让各行长度尽量一致。只作用于会话区用户块。

## 调研

- 用户块节点: `layout/build-box.ts` 的 `styled([{ text }], { suffix, balance })`, 宽度由外层 `h([spacer(fill), content])` 决定。
- 折行在 `layout/fill.ts` 的 `fillStyled` → `splitAndWrapSegments` → `wrapFrameSegments`（按码点、`charWidth` 计宽）。
- 现状: 直接按最大可用宽折行, 末行可能很短。

## 决策

用户给定算法（2026-10-18）: 总显示宽 L、最大列宽 Cmax → 行数 R = ceil(L / Cmax), 实际列宽 C = ceil(L / R)。实现加一步宽字符修正: `while (行数(C) > R) C += 1`（上限 Cmax）。

## 规划

1. `layout/box.ts`: `NodeBase.balance?: boolean`。
2. `layout/fill.ts`: `balancedWidth(segs, maxWidth, hanging)` + `fillStyled` 按 C 折行（仅无显式换行时）。
3. `layout/build-box.ts`: 用户块 body 标 `balance: true`。
4. `TUI/tests/user-width-balance.test.ts`: 单行 / 两行均衡 / 宽字符修正 / 显式换行不启用 / 窄窗。
5. `TUI/docs/SPEC.md` §15: 记录平衡折行口径。

明确不做: 输入区折行、活动区条目、notice / 工具块。

## 实现记录

- `layout/box.ts`：`NodeBase.balance?: boolean`。
- `layout/fill.ts`：`balancedWidth(segs, Cmax, hanging)`——R = 实际折行行数（等价 ceil(L/Cmax)），C = ceil(L/R)，宽字符多折一行时右移列宽；`fillStyled` 在 `balance` 且无显式换行时按 C 折行。
- `layout/build-box.ts`：用户块 body 标 `balance: true`。
- `layout/measure.ts`：测量同样按平衡列宽收窄（否则块宽仍按未平衡测量, 右对齐会失效——真机发现后补）。
- `TUI/tests/user-width-balance.test.ts`：7 例（公式 / 单行 / 宽字符修正 / 端到端等宽 / 显式换行不启用 / 窄窗 / 混排）。
- `TUI/docs/SPEC.md` §2 宽度规则增 `balance` 一条；`TUI/README.md` 用户块说明补充平衡折行。

## 偏差

- 首版只改了 fill 未改 measure, 块宽仍按未平衡宽度测量, 真机表现为「整体左对齐」; 已补 measure 同口径（`balancedWidthFor`），右缘恢复对齐。
- 宽字符取整的修正会让 C 略大于 `ceil(L/R)`（例如 62 列、Cmax 60 → C=32 而非 31），以保证行数不变；各行宽可能差 1 个字符。

## 测试与证据

- `npm --prefix TUI run check`：0 error。
- `npm --prefix TUI run test`：1632 例全绿（新增 7 例; 另更新 `layout4` 一条交错布局用例为「各行等宽 + 右缘对齐」）。
- `npm --prefix TUI run build`：通过；demo `SMOKE_PASS` / `SMOKE_OK`。
- 端到端：60 列宽文本在 60 列窗口下两行各 15 个宽字符（30 + 30），行数不变。

## 收尾

- 待办：条目 #2 标完成并移出 `TUI/docs/BACKLOG.md`；本文件移入 `TUI/docs/archived/`。
- 回写：`SPEC.md` / `README.md` 已完成。
