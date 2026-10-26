# 嵌套列表按缩进产真子列表（接取条目：`TUI/docs/BACKLOG.md`「结构层遗留：嵌套列表按缩进产真子列表」）

状态：完成　　开启：2026-10-27　　关闭：2026-10-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

§2 `parse` 按前导缩进产出带层级的列表（每 2 列一层），§4 `structure` 按层级缩进排版；
把 `tests/thinking-markdown.test.ts` 里四条 `test.todo`（嵌套列表）还原为正式用例。

## 现状（开工前实测）

`- 甲` / `  - 乙` / `    - 丙` 三个不同缩进的行，经 `parse` 得到一个 List 块、**1 个条目**：
后两行先命中续行判定 `LIST_CONT_RE = /^\s{2,}\S/`，被 `trimStart()` 后拼进父项正文
（`甲\n- 乙\n- 丙`），缩进信息与层级全丢。根因：`LIST_ITEM_RE` 的前导缩进上限写死
`^ {0,3}`，而续行判定在取到条目后先执行。

## 设计

- **层级口径**：前导缩进列数按 Tab = 4 列折算，层级 = `floor(列 / 2)`，显示缩进 = `层级 × 2`
  （与测试口径「每 2 列一层」一致；1 空格仍算顶层）。
- **IR**：`List` 增加可选 `indents?: readonly number[]`（逐条目缩进列数，与 `items` 等长；
  全 0 时不写该字段，保持既有块形状与深比较稳定）。条目顺序即源顺序——父子关系靠缩进列
  表达，不再引入递归 `ListItem` 容器（视觉与顺序等价，改动面最小）。
- **§2 parse**：标记正则去掉 `^ {0,3}` 上限、改捕获前导空白；`listItemMark` 返回
  `{ mark, body, strike?, indent }`；`isListItemStart` 仍是唯一判定入口（与解析同源）。
  列表块收集时同层/跨层连续项都进同一个 List（见「口径」）。
- **§4 structure**：`listItemBox` 增加 `indent` 参数——标记盒 `widthFixed = indent + 标记宽`，
  盒内文本前置 `indent` 个空格。续行因此自然悬挂到「缩进 + 标记宽」列。

## 计划改动文件清单

- `TUI/src/app/layout/pipeline/ir.ts`：`List.indents` 字段与注释。
- `TUI/src/app/layout/pipeline/parse.ts`：缩进捕获、`listItemMark` 返回值扩字段、两个槽位的
  列表收集写入 `indents`。
- `TUI/src/app/layout/pipeline/structure.ts`：`toList` / `listItemBox` 缩进排版。
- `TUI/tests/pipeline-parse.test.ts`：嵌套解析用例（层级列数、有序/任务混合、续行归属）。
- `TUI/tests/thinking-markdown.test.ts`：四条 `test.todo` 还原为正式用例。
- `TUI/tests/layout-hang-guard.test.ts`：语料加深缩进嵌套形态。
- `TUI/docs/BACKLOG.md`：条目标进行中 / 完成。

## 实现记录

1. **`ir.ts`**：`List` 增 `indents?: readonly number[]`（逐条目缩进列数；全 0 时 parse 不写）。
2. **`parse.ts`**
   - `TASK_RE` / `LIST_ITEM_RE` 去掉 `^ {0,3}` 上限、改捕获前导空白；标记集扩到三种
     （无序 `-`/`*`/`+`、有序 `1.`/`1)`、圆括号编号 `(1)`）——后者是四条 todo 里
     「孙编号 `(1)`」的既定口径。
   - `listItemMark` 返回值加 `indent`（`listIndentOf(前导空白)`：Tab 记 4 列，
     层级 = `floor(列 / 2)`，缩进 = 层级 × 2）。
   - 新增 `isListContinuation(text)` = 缩进够深 **且本身不是列表项**；两个槽位的续行循环
     改用它。**这是本任务的关键缺口**：子项同样以 ≥2 空白开头，若先按续行吞掉，
     层级永远读不到（开工前实测三行只出 1 个条目）。
   - 两个槽位的列表收集写入 `indents`，块上按「有非零缩进才写」落字段。
3. **`structure.ts`**：`toList` 读 `indents[i]`，`listItemBox` 增 `indent` 参数——标记盒
   `widthFixed = indent + 标记宽`、格内文本前置 `indent` 空格；续行因此悬挂到
   「缩进 + 标记宽」列（不用额外 hanging 字段）。

## 偏差

- 条目层级没有引入递归条目容器（`ListItem { blocks }`），而是 `items` 平铺 + 逐条目
  `indents`：顺序即源顺序、视觉等价，改动面最小（structure 与既有断言都不受影响）。
- 缩进口径定为「每 2 列一层」，故 3 空格缩进算 1 层（2 列），与 CommonMark「≤3 空格算顶层」
  不同；四条 todo 与既有渲染口径都按每 2 列一层，取一致优先。

## 测试与证据

- `tests/thinking-markdown.test.ts`：四条 `test.todo` 全部还原为正式用例并通过
  （两级缩进 / 有序+圆括号编号 / 嵌套任务 / 嵌套长项折行悬挂 4 列）。
- `tests/pipeline-parse.test.ts`：新增 5 例——嵌套层级与 `indents`、扁平列表不写 `indents`、
  层级不影响有序/任务标记、续行与子项的分界（无标记 = 续行）、Tab 按 4 列折算。
- `tests/layout-hang-guard.test.ts`：语料加 `nestedList`（8 层深缩进 × 长项折行）。
- 证据：`npm run check` 绿；`npm run build` 通过；`npm run test:tui`
  **1798 pass / 0 fail / 0 todo**（原 4 条 todo 转正 + 新增 5 例）；`npm run demo -- --smoke`
  42 条 `SMOKE_PASS`。

## 收尾

已关闭并移入 `TUI/docs/archived/`；BACKLOG 条目移除并加关闭注记。
