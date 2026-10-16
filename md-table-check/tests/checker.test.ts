import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEEDBACK_SUMMARY,
  checkTables,
  hasCellPipe,
  renderFeedback,
  splitCells,
} from "../src/checker.ts";

/** 组多行文本（避免模板字符串里的竖线干扰可读性） */
const lines = (...items: string[]): string => items.join("\n");

test("splitCells / hasCellPipe：口径同 TUI（转义不切、剥除首尾空单元格）", () => {
  assert.deepEqual(splitCells("| a | b |"), ["a", "b"]);
  assert.deepEqual(splitCells("a | b"), ["a", "b"]);
  assert.deepEqual(splitCells("| a \\| b | c |"), ["a \\| b", "c"]);
  assert.equal(splitCells("no pipes here"), null);
  assert.equal(splitCells(""), null);
  assert.equal(hasCellPipe("| a |"), true);
  assert.equal(hasCellPipe("a \\| b"), false);
  assert.equal(hasCellPipe("plain"), false);
});

test("分隔行列数少于表头 → 报出（表头行号 / 角色 / 期望与实际列数）", () => {
  const result = checkTables(
    lines("说明：", "| a | b | c |", "| --- | --- |", "| 1 | 2 | 3 |"),
  );
  assert.equal(result.tableTotal, 1);
  assert.equal(result.lineTotal, 1);
  const table = result.tables[0]!;
  assert.equal(table.headerLine, 2, "表头行号 = 1 基");
  assert.equal(table.expected, 3);
  assert.equal(table.mismatchTotal, 1);
  assert.deepEqual(table.mismatches, [{ line: 3, role: "delim", actual: 2 }]);
});

test("分隔行列数多于表头 → 报出", () => {
  const result = checkTables(
    lines("| a | b |", "| --- | --- | --- |", "| 1 | 2 |"),
  );
  assert.equal(result.tableTotal, 1);
  assert.deepEqual(result.tables[0]!.mismatches, [
    { line: 2, role: "delim", actual: 3 },
  ]);
});

test("数据行多格 / 缺格 → 都报出", () => {
  const result = checkTables(
    lines("| a | b |", "| --- | --- |", "| 1 | 2 | 3 |", "| 4 |", "| 5 | 6 |"),
  );
  const table = result.tables[0]!;
  assert.equal(table.mismatchTotal, 2);
  assert.deepEqual(table.mismatches, [
    { line: 3, role: "row", actual: 3 },
    { line: 4, role: "row", actual: 1 },
  ]);
  assert.equal(result.lineTotal, 2);
});

test("列数一致的表格 → 不报（含对齐冒号与无外框竖线写法）", () => {
  assert.equal(
    checkTables(
      lines(
        "| a | b | c |",
        "| :-- | :-: | --: |",
        "| 1 | 2 | 3 |",
        "| 4 | 5 | 6 |",
      ),
    ).tableTotal,
    0,
  );
  assert.equal(checkTables(lines("a | b", "--- | ---", "1 | 2")).tableTotal, 0);
});

test("`\\|` 转义不切分 → 不报", () => {
  assert.equal(
    checkTables(lines("| a \\| b | c |", "| --- | --- |", "| 1 | 2 |"))
      .tableTotal,
    0,
  );
});

test("行首尾空单元格剥除：`| a | b |` 与 `a | b` 同判 → 不报", () => {
  assert.equal(
    checkTables(lines("| a | b |", "--- | ---", "| 1 | 2 |")).tableTotal,
    0,
  );
});

test("围栏代码块内的表格 → 不报（反引号与波浪号两种栅，闭栅后的真表格仍报）", () => {
  const fence = "```";
  const fenceTilde = "~~~";
  assert.equal(
    checkTables(lines("示例：", fence, "| a | b | c |", "| --- | --- |", fence))
      .tableTotal,
    0,
  );
  assert.equal(
    checkTables(lines(fenceTilde, "| a | b |", "| --- |", fenceTilde))
      .tableTotal,
    0,
  );
  const after = checkTables(
    lines(fence, "| a | b |", "| --- |", fence, "| a | b |", "| --- |"),
  );
  assert.equal(after.tableTotal, 1, "闭栅后的表格照常检查");
  assert.equal(after.tables[0]!.headerLine, 5);
});

test("无竖线文本 / 空文本 / 只有 `|` 的行 → 不报", () => {
  assert.equal(checkTables("").tableTotal, 0);
  assert.equal(checkTables("普通段落，没有表格。").tableTotal, 0);
  assert.equal(checkTables(lines("|", "| --- |")).tableTotal, 0);
});

test("分隔行不是分隔格（`| --- | x |`）→ 不构成候选（伪表格不做）", () => {
  assert.equal(
    checkTables(lines("| a | b |", "| --- | x |", "| 1 | 2 |")).tableTotal,
    0,
  );
  assert.equal(
    checkTables(lines("正文 | 带竖线的普通行", "| a | b |")).tableTotal,
    0,
  );
});

test("多表汇总：两张问题表格都在结果里", () => {
  const result = checkTables(
    lines(
      "| a | b |",
      "| --- | --- | --- |",
      "| 1 |",
      "中间说明",
      "| x | y | z |",
      "| --- |",
      "| 1 | 2 | 3 |",
    ),
  );
  assert.equal(result.tableTotal, 2);
  assert.equal(result.tables.length, 2);
  assert.deepEqual(
    result.tables.map((table) => table.headerLine),
    [1, 5],
  );
  assert.equal(result.lineTotal, 3);
});

test("maxTables 裁剪：只列前 N 张，其余进「另有 N 处未列出」", () => {
  const text = lines(
    "| a | b |",
    "| --- | --- |",
    "| 1 |",
    "中间说明",
    "| x | y |",
    "| --- |",
    "| 1 | 2 |",
  );
  const result = checkTables(text, { maxTables: 1 });
  assert.equal(result.tableTotal, 2);
  assert.equal(result.tables.length, 1);
  const feedback = renderFeedback(text, { maxTables: 1 });
  assert.match(feedback!.text, /另有 1 处不一致未列出。/);
});

test("maxRowsPerTable 裁剪：只列前 N 行，mismatchTotal 记全量", () => {
  const text = lines(
    "| a | b |",
    "| --- | --- | --- |",
    "| 1 |",
    "| 2 | 3 | 4 |",
    "| 5 |",
  );
  const result = checkTables(text, { maxRowsPerTable: 1 });
  const table = result.tables[0]!;
  assert.equal(table.mismatches.length, 1);
  assert.equal(table.mismatchTotal, 4);
  assert.equal(result.lineTotal, 4);
  const feedback = renderFeedback(text, { maxRowsPerTable: 1 });
  assert.match(feedback!.text, /另有 3 处不一致未列出。/);
});

test("表头行号：前置文本再多也按 1 基计数", () => {
  const result = checkTables(
    lines("1", "2", "3", "4", "5", "| a | b |", "| --- |"),
  );
  assert.equal(result.tables[0]!.headerLine, 6);
});

test("renderFeedback：无问题 → null；有问题 → 汇总提示 + 三条硬口径文案", () => {
  assert.equal(renderFeedback(lines("| a | b |", "| --- | --- |")), null);
  const feedback = renderFeedback(
    lines(
      "| 包 | 作用 | 状态 |",
      "| --- | --- |",
      "| md-logic | 节树 | 已建 | 备注 |",
    ),
  );
  assert.notEqual(feedback, null);
  assert.equal(feedback!.summary, FEEDBACK_SUMMARY);
  const text = feedback!.text;
  assert.match(text, /只针对回复正文/, "声明范围");
  assert.match(text, /表头在第 1 行/, "表头行号");
  assert.match(text, /期望 3 列/, "期望列数");
  assert.match(text, /第 2 行（分隔行）：2 列/);
  assert.match(text, /第 3 行（数据行）：4 列/);
  assert.match(text, /完整重发一次/, "要求更正后重新回复");
  assert.match(text, /不要修改仓库里的任何文件或文档/, "不要改仓库文件");
  assert.doesNotMatch(text, /另有/, "未超上限时不出「另有」行");
});

test("表头摘录：超长截断并加省略号", () => {
  const header = `| ${"长".repeat(80)} | b |`;
  const feedback = renderFeedback(lines(header, "| --- |"), {
    headerExcerptLimit: 12,
  });
  assert.match(feedback!.text, /长{10}…/);
});

test("选项非法值回退缺省（负数 / NaN 不抛）", () => {
  const text = lines("| a | b |", "| --- |");
  assert.equal(checkTables(text, { maxTables: -1 }).tables.length, 1);
  assert.equal(
    checkTables(text, { maxRowsPerTable: Number.NaN }).tables[0]!.mismatches
      .length,
    1,
  );
  assert.equal(renderFeedback(text, { headerExcerptLimit: -5 }) !== null, true);
});

// ---------------- 漏检形态筛查（任务 B）: 逐形态断言 ----------------
// 形态编号沿用 md-table-check/docs/BACKLOG.md 的「待查形态」; 证据与裁定见追踪文档
// docs/implementation/2026-10-16-three-surface-text-consistency.md 任务 B 的 S2–S4 与「决策」。

test("形态 ①+② 组合：分隔行与数据行同时不符 → 两处不一致且按行号排序", () => {
  const result = checkTables(
    lines("| a | b | c |", "| --- | --- |", "| 1 | 2 | 3 | 4 |"),
  );
  assert.equal(result.tableTotal, 1);
  assert.equal(result.lineTotal, 2);
  const table = result.tables[0]!;
  assert.equal(table.expected, 3);
  assert.deepEqual(table.mismatches, [
    { line: 2, role: "delim", actual: 2 },
    { line: 3, role: "row", actual: 4 },
  ]);
  const feedback = renderFeedback(
    lines("| a | b | c |", "| --- | --- |", "| 1 | 2 | 3 | 4 |"),
  );
  assert.match(feedback!.text, /第 2 行（分隔行）：2 列/);
  assert.match(feedback!.text, /第 3 行（数据行）：4 列/);
  assert.doesNotMatch(feedback!.text, /另有/, "未超上限时不出「另有」行");
});

test("形态 ② 相邻两表（无间隔）→ 与 TUI 同判为一张表、2 处不一致", () => {
  const result = checkTables(
    lines(
      "| a | b |",
      "| --- | --- |",
      "| 1 |",
      "| x | y |",
      "| --- | ---",
      "| 2 |",
    ),
  );
  assert.equal(
    result.tableTotal,
    1,
    "连续带竖线的行收进同一张表（与 TUI 同判）",
  );
  assert.equal(result.lineTotal, 2);
  assert.deepEqual(
    result.tables[0]!.mismatches.map((item) => item.line),
    [3, 6],
  );
});

test("形态 ③ 表格在回复末尾（无尾随空行 / 无末尾换行）→ 照常报出", () => {
  const text = lines("说明在前。", "| a | b |", "| --- | --- |", "| 1 |");
  assert.equal(text.endsWith("\n"), false, "文本末尾无换行符");
  const result = checkTables(text);
  assert.equal(result.tableTotal, 1);
  assert.deepEqual(result.tables[0]!.mismatches, [
    { line: 4, role: "row", actual: 1 },
  ]);
});

test("形态 ④ 行内代码含竖线 → 按字面切分（已裁定口径: 多报一处, 不修）", () => {
  // 表头字面 4 格（反引号里的竖线按字面切分）, 分隔行 / 数据行各 3 格 → 两处不一致。
  const result = checkTables(
    lines("| `a | b` | c | d |", "| --- | --- | --- |", "| 1 | 2 | 3 |"),
  );
  assert.equal(result.tableTotal, 1);
  assert.equal(
    result.lineTotal,
    2,
    "已裁定: 保持与 TUI 同口径（不做代码跨度感知）, 多报一处",
  );
  assert.equal(result.tables[0]!.expected, 4);
  assert.deepEqual(result.tables[0]!.mismatches, [
    { line: 2, role: "delim", actual: 3 },
    { line: 3, role: "row", actual: 3 },
  ]);
});

test("形态 ⑧ 单列表三态：列数一致不报 / 数据行多格报 / 分隔行 1 格报", () => {
  assert.equal(
    checkTables(lines("| a |", "| --- |", "| 1 |")).tableTotal,
    0,
    "单列表且列数一致 → 不报",
  );
  const extra = checkTables(lines("| a |", "| --- |", "| 1 | 2 |"));
  assert.equal(extra.tableTotal, 1, "单列表数据行多格 → 报");
  assert.deepEqual(extra.tables[0]!.mismatches, [
    { line: 3, role: "row", actual: 2 },
  ]);
  const shortDelim = checkTables(lines("| a | b |", "| --- |", "| 1 | 2 |"));
  assert.equal(shortDelim.tableTotal, 1, "分隔行不足 2 单元格 → 报");
  assert.deepEqual(shortDelim.tables[0]!.mismatches, [
    { line: 2, role: "delim", actual: 1 },
  ]);
});

test("表格位于回复首行（前面无空行）→ 照常识别, 表头行号为 1", () => {
  const result = checkTables(lines("| a | b |", "| --- | --- |", "| 1 |"));
  assert.equal(result.tableTotal, 1);
  assert.equal(result.tables[0]!.headerLine, 1);
});

test("不报口径（钉住已裁定结论）：表头与分隔行间空行 / 引用块内表", () => {
  assert.equal(
    checkTables(lines("| a | b |", "", "| --- | --- |", "| 1 | 2 | 3 |"))
      .tableTotal,
    0,
    "表头与分隔行之间有空行 → 不报（与 TUI 同判, 已登记条目）",
  );
  assert.equal(
    checkTables(lines("> | a | b |", "> | --- | --- |", "> | 1 | 2 | 3 |"))
      .tableTotal,
    0,
    "引用块内表格 → 不报（TUI 引用分支走行内解析, 口径一致）",
  );
});

test("列表项内缩进表格 → 报出", () => {
  const result = checkTables(
    lines("- 项:", "  | a | b |", "  | --- | --- |", "  | 1 | 2 | 3 |"),
  );
  assert.equal(result.tableTotal, 1);
  assert.deepEqual(result.tables[0]!.mismatches, [
    { line: 4, role: "row", actual: 3 },
  ]);
});

// ---------------- 零散补钉: 围栏边界 / 裸反斜杠 / 转义竖线行 / 上限为 0（2026-10-16） ----------------

test("围栏混用标记（``` 开 / ~~~ 闭）→ 栅栏行无条件翻转, 闭栅后的内容照常检查", () => {
  // 开栅 ``` / 闭栅 ~~~: 与 TUI `build-box.ts:702-708` 同口径（不要求闭栅同前缀）
  const mixed = lines(
    "```",
    "| a | b |",
    "| --- |",
    "~~~",
    "| a | b |",
    "| --- |",
  );
  const result = checkTables(mixed);
  assert.equal(result.tableTotal, 1, "混用标记的闭栅之后, 真表格要照常报");
  assert.equal(result.tables[0]!.headerLine, 5);
  assert.deepEqual(result.tables[0]!.mismatches, [
    { line: 6, role: "delim", actual: 1 },
  ]);
  // 围栏内（同样混用标记）的坏表仍不报
  assert.equal(
    checkTables(lines("```", "| a | b |", "| --- |", "~~~")).tableTotal,
    0,
    "围栏内的表不报",
  );
  // 反方向混用（~~~ 开 / ``` 闭）同判
  assert.equal(
    checkTables(
      lines("~~~", "| a | b |", "| --- |", "```", "| a | b |", "| --- |"),
    ).tableTotal,
    1,
    "~~~ 开 / ``` 闭 同样能闭合",
  );
  // 闭栅行本身不再开新围栏: 闭栅后紧跟的表照常检查
  assert.equal(
    checkTables(lines("```", "```", "| a | b |", "| --- |")).tableTotal,
    1,
  );
});

test("围栏变体（info string / 1-3 空格缩进 / 四反引号）→ 围栏内不报、闭栅后照常报", () => {
  const variants: [string, string][] = [
    ["```js", "```"],
    [" ~~~", " ~~~"],
    ["  ```", "  ```"],
    ["   ```ts", "   ```"],
    ["````", "````"],
    ["~~~~", "~~~~"],
  ];
  for (const [open, close] of variants) {
    const inside = lines(open, "| a | b |", "| --- |", close);
    assert.equal(
      checkTables(inside).tableTotal,
      0,
      `围栏内坏表不报: ${JSON.stringify(open)}`,
    );
    const after = checkTables(
      lines(open, "| a | b |", "| --- |", close, "| a | b |", "| --- |"),
    );
    assert.equal(after.tableTotal, 1, `闭栅后照常报: ${JSON.stringify(open)}`);
    assert.equal(after.tables[0]!.headerLine, 5, `表头行号: ${open}`);
  }
  // 4 空格缩进不算围栏（两侧 FENCE_RE 都只认 0-3 空格）→ 该行按普通文本走, 表被检查
  const indented = checkTables(
    lines("    ```", "| a | b |", "| --- |", "    ```"),
  );
  assert.equal(
    indented.tableTotal,
    1,
    "4 空格缩进的「围栏」不是围栏（FENCE_RE 只认 0-3 空格）",
  );
});

test("行尾裸反斜杠（转义吞字符的 next === undefined 分支）→ 不抛、与 TUI 同形", () => {
  assert.equal(splitCells("a\\"), null, "无未转义竖线 → null");
  assert.equal(hasCellPipe("a\\"), false, "行尾裸 `\\` 不构成竖线");
  assert.deepEqual(
    splitCells("| a\\"),
    ["a\\"],
    "行尾裸 `\\` 原样留在单元格里",
  );
  assert.deepEqual(splitCells("\\"), null);
  // 表格里的行尾裸反斜杠: 不抛、列数照常（2 列 → 不报）
  const text = lines("| a | b |", "| --- | --- |", "| 1 | 2\\");
  assert.equal(checkTables(text).tableTotal, 0, "行尾裸 `\\` 不影响列数判定");
});

test("转义竖线 `\\|` 出现在数据行 / 分隔行 → 列数按实际格数判, 不误报", () => {
  // 数据行 `1 \| 2` 只算 1 格 → 仍 2 列 → 不报
  assert.equal(
    checkTables(lines("| a | b |", "| --- | --- |", "| 1 \\| 2 | 3 |"))
      .tableTotal,
    0,
    "数据行里的 `\\|` 不切分 → 仍 2 列",
  );
  // 数据行 `1 \| 2` 单独成格 → 1 列 vs 期望 2 列 → 报（转义被正确尊重）
  const short = checkTables(lines("| a | b |", "| --- | --- |", "| 1 \\| 2 |"));
  assert.equal(short.tableTotal, 1);
  assert.deepEqual(short.tables[0]!.mismatches, [
    { line: 3, role: "row", actual: 1 },
  ]);
  // 分隔行含 `\|` → 该格不是分隔格形状（`^:?-+:?$`）→ 整块不算表 → 不误报
  assert.equal(
    checkTables(lines("| a | b |", "| --- \\| --- |", "| 1 | 2 |")).tableTotal,
    0,
    "分隔行含转义竖线 → 整块不算表",
  );
  // 分隔行 `| --- | --- \| --- |` 同理: 第二格非分隔格形状
  assert.equal(
    checkTables(lines("| a | b |", "| --- | --- \\| --- |", "| 1 | 2 |"))
      .tableTotal,
    0,
  );
});

test("上限为 0 = 不设上限（三个上限参数统一; 缺省与非法值仍回退）", () => {
  const text = lines("| a | b |", "| --- |");
  // maxTables: 0 —— 列出全部问题表格（不再出现「列表恒空 → 提示为 null」的静默）
  const zeroTables = checkTables(text, { maxTables: 0 });
  assert.equal(zeroTables.tableTotal, 1, "计数仍全量");
  assert.equal(zeroTables.lineTotal, 1);
  assert.equal(zeroTables.tables.length, 1, "0 = 不设上限 → 全部列出");
  assert.notEqual(renderFeedback(text, { maxTables: 0 }), null, "0 不再静默");
  // 多张表（空行分隔, 每张 1 处不一致）: 0 → 全列; 未设 → 缺省 5; 显式 2 → 2
  const many = lines(
    ...[0, 1, 2, 3, 4, 5, 6].flatMap((i) => [
      `| h${i} | x |`,
      "| --- | --- |",
      "| r |",
      "",
    ]),
  );
  assert.equal(
    checkTables(many, { maxTables: 0 }).tables.length,
    7,
    "0 → 全部 7 张",
  );
  assert.equal(checkTables(many).tables.length, 5, "未设 → 缺省 5");
  assert.equal(
    checkTables(many, { maxTables: 2 }).tables.length,
    2,
    "显式上限",
  );
  // maxRowsPerTable: 0 —— 每张表列出全部不一致行（不再切到 0 行）
  const rows4 = lines(
    "| a | b |",
    "| --- | --- |",
    "| 1 |",
    "| 2 |",
    "| 3 |",
    "| 4 |",
  );
  const all = checkTables(rows4, { maxRowsPerTable: 0 });
  assert.equal(all.tables[0]!.mismatches.length, 4, "0 → 全部 4 行");
  assert.equal(all.tables[0]!.mismatchTotal, 4);
  assert.deepEqual(all.tables[0]!.mismatches[0], {
    line: 3,
    role: "row",
    actual: 1,
  });
  assert.equal(
    checkTables(rows4).tables[0]!.mismatches.length,
    3,
    "未设 → 缺省 3",
  );
  // headerExcerptLimit: 0 —— 摘录不截断（表头原文, 不再只剩 `…`）
  const zeroExcerpt = renderFeedback(text, {
    maxTables: 1,
    headerExcerptLimit: 0,
  });
  assert.notEqual(zeroExcerpt, null);
  assert.match(zeroExcerpt!.text, /：`\| a \| b \|` 期望 2 列/);
  // 非法值（负数 / NaN）仍回退缺省
  assert.equal(checkTables(many, { maxTables: -1 }).tables.length, 5);
  assert.equal(checkTables(many, { maxTables: Number.NaN }).tables.length, 5);
  assert.equal(
    checkTables(rows4, { maxRowsPerTable: -1 }).tables[0]!.mismatches.length,
    3,
  );
  assert.match(
    renderFeedback(text, { maxTables: 1, headerExcerptLimit: -1 })!.text,
    /：`\| a \| b \|` 期望 2 列/,
  );
});
