/**
 * edit 测试：四类指令、多锚点串行编辑、stale 整体拒绝（列出全部失效锚点）、
 * 越界/重叠/形状错误、空文件、空行锚点、CRLF 口径、超长行。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnchoredEditError,
  applyAnchoredEdits,
  type EditOp,
} from "../src/edit.ts";
import { hashLine, hashlines } from "../src/hashline.ts";

// 测试基线内容：5 行（尾随 \n 不产生第 6 行）
const CONTENT = ["alpha", "beta", "", "delta", "epsilon"].join("\n") + "\n";

/** 取内容第 line 行（1 基）的 LINE:HASH 锚点。 */
function anchorAt(content: string, line: number): string {
  const row = hashlines(content)[line - 1];
  assert.ok(row, `line ${line} exists`);
  return `${row.line}:${row.hash}`;
}

/** 构造一个哈希指向其它文本的假锚点（模拟文件已变 → stale）。 */
function staleAnchorAt(content: string, line: number): string {
  const row = hashlines(content)[line - 1];
  assert.ok(row, `line ${line} exists`);
  const fake = hashLine(`changed line ${line}`);
  assert.notEqual(fake, row.hash, "fake hash must differ");
  return `${row.line}:${fake}`;
}

function expectRejected(
  content: string,
  edits: EditOp[],
  code: AnchoredEditError["code"],
  detailCount?: number,
): AnchoredEditError {
  try {
    applyAnchoredEdits(content, edits);
  } catch (err) {
    assert.ok(
      err instanceof AnchoredEditError,
      `expected AnchoredEditError, got ${err}`,
    );
    assert.equal(err.code, code);
    if (detailCount !== undefined)
      assert.equal(err.details.length, detailCount);
    return err;
  }
  assert.fail("expected AnchoredEditError but apply succeeded");
  throw new Error("unreachable");
}

test("set_line: 替换单行", () => {
  const res = applyAnchoredEdits(CONTENT, [
    { set_line: { anchor: anchorAt(CONTENT, 2), new_text: "BETA2" } },
  ]);
  assert.equal(res.content, "alpha\nBETA2\n\ndelta\nepsilon\n");
  assert.equal(res.line_count, 5);
  assert.deepEqual(res.applied, [{ op: "set", line: 2, new_line_count: 1 }]);
  // 结果自带新锚点，可直接用于下一轮编辑
  assert.equal(res.hashlines[1]?.hash, hashLine("BETA2"));
});

test("set_line: new_text 含换行展开为多行", () => {
  const res = applyAnchoredEdits(CONTENT, [
    { set_line: { anchor: anchorAt(CONTENT, 2), new_text: "x\ny" } },
  ]);
  assert.equal(res.content, "alpha\nx\ny\n\ndelta\nepsilon\n");
  assert.equal(res.line_count, 6);
});

test("set_line: 空 new_text 使该行变空行（不删除）", () => {
  const res = applyAnchoredEdits(CONTENT, [
    { set_line: { anchor: anchorAt(CONTENT, 2), new_text: "" } },
  ]);
  assert.equal(res.content, "alpha\n\n\ndelta\nepsilon\n");
  assert.equal(res.line_count, 5);
});

test("set_line: new_text 尾随换行显式产生尾随空行", () => {
  const res = applyAnchoredEdits(CONTENT, [
    { set_line: { anchor: anchorAt(CONTENT, 2), new_text: "x\n" } },
  ]);
  assert.equal(res.content, "alpha\nx\n\n\ndelta\nepsilon\n");
  assert.equal(res.line_count, 6);
});

test("replace_lines: 替换闭区间", () => {
  const res = applyAnchoredEdits(CONTENT, [
    {
      replace_lines: {
        start_anchor: anchorAt(CONTENT, 2),
        end_anchor: anchorAt(CONTENT, 4),
        new_text: "R",
      },
    },
  ]);
  assert.equal(res.content, "alpha\nR\nepsilon\n");
  assert.equal(res.line_count, 3);
  assert.deepEqual(res.applied, [
    { op: "replace", line: 2, new_line_count: 1 },
  ]);
});

test("replace_lines: 空 new_text 为纯删除（不留空行）", () => {
  const res = applyAnchoredEdits(CONTENT, [
    {
      replace_lines: {
        start_anchor: anchorAt(CONTENT, 2),
        end_anchor: anchorAt(CONTENT, 3),
        new_text: "",
      },
    },
  ]);
  assert.equal(res.content, "alpha\ndelta\nepsilon\n");
  assert.equal(res.line_count, 3);
});

test("insert_after: 锚点行后插入（多行）", () => {
  const res = applyAnchoredEdits(CONTENT, [
    { insert_after: { anchor: anchorAt(CONTENT, 2), new_text: "I1\nI2" } },
  ]);
  assert.equal(res.content, "alpha\nbeta\nI1\nI2\n\ndelta\nepsilon\n");
  assert.equal(res.line_count, 7);
});

test("insert_after: 锚末行 = 追加到文件尾", () => {
  const res = applyAnchoredEdits(CONTENT, [
    { insert_after: { anchor: anchorAt(CONTENT, 5), new_text: "tail" } },
  ]);
  assert.equal(res.content, "alpha\nbeta\n\ndelta\nepsilon\ntail\n");
  assert.equal(res.line_count, 6);
});

test("insert_after: 空 new_text 为 no-op", () => {
  const res = applyAnchoredEdits(CONTENT, [
    { insert_after: { anchor: anchorAt(CONTENT, 2), new_text: "" } },
  ]);
  assert.equal(res.content, CONTENT);
  assert.deepEqual(res.applied, [{ op: "insert", line: 2, new_line_count: 0 }]);
});

test("delete_line: 删除单行", () => {
  const res = applyAnchoredEdits(CONTENT, [
    { delete_line: { anchor: anchorAt(CONTENT, 3) } },
  ]);
  assert.equal(res.content, "alpha\nbeta\ndelta\nepsilon\n");
  assert.equal(res.line_count, 4);
  assert.deepEqual(res.applied, [{ op: "delete", line: 3, new_line_count: 0 }]);
});

test("多锚点一次提交：全部针对原始内容校验，按行升序应用", () => {
  const res = applyAnchoredEdits(CONTENT, [
    // 故意乱序提交，验证按锚点行升序应用
    { delete_line: { anchor: anchorAt(CONTENT, 5) } },
    { set_line: { anchor: anchorAt(CONTENT, 1), new_text: "A1" } },
    {
      replace_lines: {
        start_anchor: anchorAt(CONTENT, 3),
        end_anchor: anchorAt(CONTENT, 4),
        new_text: "R",
      },
    },
    { insert_after: { anchor: anchorAt(CONTENT, 2), new_text: "I1" } },
  ]);
  assert.equal(res.content, "A1\nbeta\nI1\nR\n");
  assert.equal(res.line_count, 4);
  assert.deepEqual(
    res.applied.map((a) => a.line),
    [1, 2, 3, 5],
  );
});

test("stale: 任一锚点哈希不符 → 整体拒绝，details 列出全部 stale 锚点（含 expected/actual）", () => {
  const err = expectRejected(
    CONTENT,
    [
      // 第 1 行锚点有效，第 2/4 行锚点指向旧内容
      { set_line: { anchor: anchorAt(CONTENT, 1), new_text: "A1" } },
      { set_line: { anchor: staleAnchorAt(CONTENT, 2), new_text: "B1" } },
      { delete_line: { anchor: staleAnchorAt(CONTENT, 4) } },
    ],
    "stale_anchors",
    2,
  );
  const anchors = err.details.map((d) => d.anchor).sort();
  assert.deepEqual(
    anchors,
    [staleAnchorAt(CONTENT, 2), staleAnchorAt(CONTENT, 4)].sort(),
  );
  for (const d of err.details) {
    assert.ok(d.expected, "stale detail carries expected hash");
    assert.ok(d.actual, "stale detail carries actual hash");
    assert.notEqual(d.expected, d.actual);
  }
});

test("stale: replace_lines 的 start/end 锚点分别校验", () => {
  const err = expectRejected(
    CONTENT,
    [
      {
        replace_lines: {
          start_anchor: staleAnchorAt(CONTENT, 2),
          end_anchor: anchorAt(CONTENT, 3),
          new_text: "R",
        },
      },
    ],
    "stale_anchors",
    1,
  );
  assert.equal(err.details[0]?.line, 2);
});

test("out_of_range: 锚点行号超出文件行数", () => {
  const err = expectRejected(
    CONTENT,
    [{ set_line: { anchor: `6:${hashLine("epsilon")}`, new_text: "X" } }],
    "out_of_range",
    1,
  );
  assert.equal(err.details[0]?.line, 6);
  assert.match(err.details[0]?.reason ?? "", /outside the file/);
});

test("malformed: 锚点语法非法（长度/字符集/行号 0）", () => {
  expectRejected(
    CONTENT,
    [{ set_line: { anchor: "1:e3b0c44", new_text: "x" } }],
    "malformed",
    1,
  );
  expectRejected(
    CONTENT,
    [{ set_line: { anchor: "1:zzzzzzzz", new_text: "x" } }],
    "malformed",
    1,
  );
  expectRejected(
    CONTENT,
    [{ set_line: { anchor: "0:e3b0c442", new_text: "x" } }],
    "malformed",
    1,
  );
});

test("malformed: 指令形状非法（双变体键 / 空 edits）", () => {
  expectRejected(
    CONTENT,
    [
      {
        set_line: { anchor: anchorAt(CONTENT, 1), new_text: "x" },
        delete_line: { anchor: anchorAt(CONTENT, 1) },
      } as unknown as EditOp,
    ],
    "malformed",
  );
  expectRejected(CONTENT, [], "malformed");
});

test("malformed: replace_lines end 先于 start", () => {
  const err = expectRejected(
    CONTENT,
    [
      {
        replace_lines: {
          start_anchor: anchorAt(CONTENT, 3),
          end_anchor: anchorAt(CONTENT, 2),
          new_text: "R",
        },
      },
    ],
    "malformed",
    1,
  );
  assert.match(err.details[0]?.reason ?? "", /precede/);
});

test("overlapping: 同一行被两条指令占用（set+set / replace 区间含 set / insert+insert）", () => {
  expectRejected(
    CONTENT,
    [
      { set_line: { anchor: anchorAt(CONTENT, 2), new_text: "X" } },
      { set_line: { anchor: anchorAt(CONTENT, 2), new_text: "Y" } },
    ],
    "overlapping_edits",
    2,
  );
  expectRejected(
    CONTENT,
    [
      {
        replace_lines: {
          start_anchor: anchorAt(CONTENT, 2),
          end_anchor: anchorAt(CONTENT, 3),
          new_text: "R",
        },
      },
      { set_line: { anchor: anchorAt(CONTENT, 2), new_text: "X" } },
    ],
    "overlapping_edits",
  );
  expectRejected(
    CONTENT,
    [
      { insert_after: { anchor: anchorAt(CONTENT, 2), new_text: "I" } },
      { insert_after: { anchor: anchorAt(CONTENT, 2), new_text: "J" } },
    ],
    "overlapping_edits",
    2,
  );
});

test("空文件：唯一空行可 set / delete", () => {
  const emptyAnchor = `1:${hashLine("")}`;
  const set = applyAnchoredEdits("", [
    { set_line: { anchor: emptyAnchor, new_text: "born" } },
  ]);
  assert.equal(set.content, "born");
  const del = applyAnchoredEdits("", [
    { delete_line: { anchor: emptyAnchor } },
  ]);
  assert.equal(del.content, "");
  assert.equal(del.line_count, 1);
});

test("空行锚点：可锚定空行并编辑", () => {
  const res = applyAnchoredEdits(CONTENT, [
    { set_line: { anchor: anchorAt(CONTENT, 3), new_text: "filled" } },
  ]);
  assert.equal(res.content, "alpha\nbeta\nfilled\ndelta\nepsilon\n");
  // 空行锚点哈希固定为 sha256("") 前缀
  assert.equal(anchorAt(CONTENT, 3), `3:e3b0c442`);
});

test("CRLF 文件：行内容哈希不含 \\r，写回保留 CRLF 口径与尾随换行", () => {
  const crlf = "abc\r\ndef\r\n";
  const rows = hashlines(crlf);
  assert.equal(rows[0]?.hash, hashLine("abc"));
  const res = applyAnchoredEdits(crlf, [
    { set_line: { anchor: anchorAt(crlf, 2), new_text: "DEF" } },
  ]);
  assert.equal(res.content, "abc\r\nDEF\r\n");
});

test("超长行：200KB 单行文件可锚定并编辑", () => {
  const longLine = "x".repeat(200_000);
  const content = `header\n${longLine}\ntailer\n`;
  const res = applyAnchoredEdits(content, [
    { set_line: { anchor: anchorAt(content, 2), new_text: "short" } },
  ]);
  assert.equal(res.content, "header\nshort\ntailer\n");
});

test("大写 hex 锚点被归一化接受", () => {
  const row = hashlines(CONTENT)[1];
  assert.ok(row);
  const upper = `2:${row.hash.toUpperCase()}`;
  const res = applyAnchoredEdits(CONTENT, [
    { set_line: { anchor: upper, new_text: "UPPER" } },
  ]);
  assert.equal(res.content, "alpha\nUPPER\n\ndelta\nepsilon\n");
});

test("拒绝后内容不变（纯函数，无副作用）", () => {
  const before = CONTENT;
  expectRejected(
    before,
    [{ set_line: { anchor: staleAnchorAt(before, 1), new_text: "X" } }],
    "stale_anchors",
  );
  assert.equal(
    before,
    ["alpha", "beta", "", "delta", "epsilon"].join("\n") + "\n",
  );
});
