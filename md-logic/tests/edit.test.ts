// tests/edit.test.ts — 按节改写：漂移即拒、整批原子、风格保留、工具面。
//
// 安全语义：`heading`（标题文本）+ `startLine` / `endLine`（来自 structure）必须与**当前**解析一致；
// 任一条不符 → 整体拒绝且不落盘；写盘走临时文件 + rename。

import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  apply,
  flattenSections,
  parseMarkdownDocument,
  replaceSections,
  replaceSectionsFile,
} from "../src/index.ts";
import { withTempDir, writeFixture } from "./helpers.ts";

const DOC = [
  "# 标题",
  "",
  "前言段落。",
  "",
  "## 甲节",
  "",
  "甲的正文。",
  "",
  "## 乙节",
  "",
  "乙的第一行。",
  "乙的第二行。",
  "",
].join("\n");

/** 取某标题的行范围（模拟模型从 `structure` 拿到的 `L{start}-{end}`）。 */
function rangeOf(
  text: string,
  heading: string,
): { startLine: number; endLine: number } {
  const doc = parseMarkdownDocument(text);
  const node = flattenSections(doc.sections).find(
    (item) => item.title === heading,
  );
  assert.ok(node, `节「${heading}」应在结构中`);
  return { startLine: node.line, endLine: node.endLine };
}

test("replaceSections：替换节体（其它节与尾空行不动）", () => {
  const range = rangeOf(DOC, "乙节");
  const out = replaceSections(DOC, [
    { heading: "乙节", ...range, content: "## 乙节\n\n乙已改写。" },
  ]);
  assert.equal(out.ok, true, JSON.stringify(out));
  if (!out.ok) return;
  assert.match(out.text, /## 乙节\n\n乙已改写。\n$/);
  assert.match(out.text, /## 甲节\n\n甲的正文。/);
  assert.equal(out.applied, 1);
});

test("replaceSections：漂移即拒（范围变了 / 标题没了 / 参数非法）", () => {
  const range = rangeOf(DOC, "乙节");
  const drifted = replaceSections(DOC, [
    {
      heading: "乙节",
      startLine: range.startLine - 1,
      endLine: range.endLine,
      content: "x",
    },
  ]);
  assert.equal(drifted.ok, false);
  if (!drifted.ok) {
    assert.equal(drifted.code, "section_drift");
    assert.match(drifted.error, /重新 structure/);
    assert.ok(Array.isArray(drifted.details));
  }
  const missing = replaceSections(DOC, [
    { heading: "丙节", startLine: 1, endLine: 1, content: "x" },
  ]);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "section_missing");

  assert.equal(replaceSections(DOC, []).ok, false);
  const bad = replaceSections(DOC, [
    { heading: "乙节", startLine: 0, endLine: 3, content: "x" },
  ]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "edits_invalid");
});

test("replaceSections：重叠区间拒绝（父节 + 子节 / 同一节两条）", () => {
  const parent = rangeOf(DOC, "标题");
  const child = rangeOf(DOC, "甲节");
  const out = replaceSections(DOC, [
    { heading: "标题", ...parent, content: "# 标题\n\n新前言。" },
    { heading: "甲节", ...child, content: "## 甲节\n\n新甲。" },
  ]);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.code, "overlap");
});

test("replaceSections：内容为空串 = 删除该节", () => {
  const range = rangeOf(DOC, "甲节");
  const out = replaceSections(DOC, [
    { heading: "甲节", ...range, content: "" },
  ]);
  assert.equal(out.ok, true, JSON.stringify(out));
  if (!out.ok) return;
  assert.ok(!out.text.includes("甲节"), "节应被删除");
  assert.ok(!out.text.includes("甲的正文。"));
  // 删除节保留原分隔空行（本实现不做空行折叠）：`前言段落。\n\n` + 被删节留下的空行 + `## 乙节`
  assert.match(out.text, /前言段落。\n\n\n## 乙节/);
});

test("replaceSections：BOM 与 CRLF 风格保留（除目标节外字节不动）", () => {
  const crlf = "\uFEFF" + DOC.replace(/\n/g, "\r\n");
  const range = rangeOf(crlf, "乙节");
  const out = replaceSections(crlf, [
    { heading: "乙节", ...range, content: "## 乙节\n\n乙已改写。" },
  ]);
  assert.equal(out.ok, true, JSON.stringify(out));
  if (!out.ok) return;
  assert.ok(out.text.startsWith("\uFEFF"), "BOM 保留");
  assert.ok(out.text.includes("\r\n"), "换行风格保留");
  // 目标节之前的**原始字节**（含 BOM 与 CRLF）必须完全一致
  assert.ok(
    out.text.startsWith(
      "\uFEFF# 标题\r\n\r\n前言段落。\r\n\r\n## 甲节\r\n\r\n甲的正文。\r\n\r\n",
    ),
    "目标节之前的字节应完全一致",
  );
  assert.match(out.text, /## 乙节\r\n\r\n乙已改写。\r\n$/);
});

test("replaceSectionsFile：失败不落盘（文件字节不变）/ 成功原子写", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "a.md", DOC);
    const before = readFileSync(file, "utf8");
    const drifted = await replaceSectionsFile(file, [
      { heading: "乙节", startLine: 1, endLine: 2, content: "x" },
    ]);
    assert.equal(drifted.ok, false);
    assert.equal(readFileSync(file, "utf8"), before, "校验失败必须不落盘");

    const range = rangeOf(before, "乙节");
    const ok = await replaceSectionsFile(file, [
      { heading: "乙节", ...range, content: "## 乙节\n\n已改写。" },
    ]);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const after = readFileSync(file, "utf8");
    assert.match(after, /已改写。/);
    assert.notEqual(after, before);
  } finally {
    cleanup();
  }
});

test("工具面：md_logic replace（参数校验先于 IO / 成功写盘 + 渲染）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "a.md", DOC);
    const registered: unknown[] = [];
    apply({ tools: { register: (def) => registered.push(def) } }, {});
    const tool = registered[0] as {
      execute(
        args: Record<string, unknown>,
        exec?: unknown,
      ): Promise<Record<string, unknown>>;
      output: {
        render(args: unknown, value: unknown): Array<{ text: string }>;
      };
    };
    const exec = { agent: { session: { header: { cwd: dir } } } };

    // ① 参数非法：不触盘
    const bad = await tool.execute(
      { action: "replace", path: "a.md", edits: [] },
      exec,
    );
    assert.match(String(bad["error"]), /edits 非法/);
    assert.equal(readFileSync(file, "utf8"), DOC, "参数非法不得写盘");

    // ② 漂移：拒绝且给出下一步
    const drift = await tool.execute(
      {
        action: "replace",
        path: "a.md",
        edits: [{ heading: "乙节", start_line: 1, end_line: 2, content: "x" }],
      },
      exec,
    );
    const driftText = tool.output.render({}, drift)[0]?.text ?? "";
    assert.match(driftText, /replace 失败（section_drift）/);
    assert.match(driftText, /重新 structure/);
    assert.equal(readFileSync(file, "utf8"), DOC);

    // ③ 成功：写盘 + 渲染处数
    const range = rangeOf(DOC, "乙节");
    const ok = await tool.execute(
      {
        action: "replace",
        path: "a.md",
        edits: [
          {
            heading: "乙节",
            start_line: range.startLine,
            end_line: range.endLine,
            content: "## 乙节\n\n工具面已改写。",
          },
        ],
      },
      exec,
    );
    const text = tool.output.render({}, ok)[0]?.text ?? "";
    assert.match(text, /已按节替换：.+a\.md（1 处/);
    assert.match(readFileSync(file, "utf8"), /工具面已改写。/);
  } finally {
    cleanup();
  }
});

test("写盘：权限位保留（0600 不被放宽）/ 非 UTF-8 拒写且字节不变", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "a.md", DOC);
    chmodSync(file, 0o600);
    const range = rangeOf(DOC, "乙节");
    const ok = await replaceSectionsFile(file, [
      { heading: "乙节", ...range, content: "## 乙节\n\n权限保留。" },
    ]);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(statSync(file).mode & 0o777, 0o600, "权限位必须保留");

    // 非 UTF-8（0xFF 0xFE）：拒写且原字节不变
    const bad = join(dir, "bad.md");
    const original = Buffer.from([0x23, 0x20, 0x54, 0x0a, 0xff, 0xfe, 0x0a]);
    writeFileSync(bad, original);
    const refused = await replaceSectionsFile(bad, [
      { heading: "T", startLine: 1, endLine: 1, content: "# T\n\n新。" },
    ]);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "not_utf8");
    assert.deepEqual(readFileSync(bad), original, "非 UTF-8 必须不落盘");
  } finally {
    cleanup();
  }
});

test("写盘：maxBytes 守卫覆盖写路径（超限拒绝且不落盘）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "a.md", DOC);
    const before = readFileSync(file);
    const out = await replaceSectionsFile(
      file,
      [
        {
          heading: "乙节",
          startLine: 9,
          endLine: 11,
          content: "## 乙节\n\n新。",
        },
      ],
      dir,
      32,
    );
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /超过上限 32B/);
    assert.deepEqual(readFileSync(file), before);
  } finally {
    cleanup();
  }
});

test("批量原子：第 2 条失败 → 第 1 条也不落盘；越界给 range_out_of_bounds", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "a.md", DOC);
    const before = readFileSync(file);
    const jia = rangeOf(DOC, "甲节");
    const out = await replaceSectionsFile(file, [
      { heading: "甲节", ...jia, content: "## 甲节\n\n已改。" },
      { heading: "乙节", startLine: 99, endLine: 100, content: "x" },
    ]);
    assert.equal(out.ok, false);
    assert.deepEqual(readFileSync(file), before, "第二条失败时第一条不得落盘");

    const oob = replaceSections(DOC, [
      { heading: "乙节", startLine: 9, endLine: 999, content: "x" },
    ]);
    assert.equal(oob.ok, false);
    if (!oob.ok) assert.equal(oob.code, "range_out_of_bounds");
  } finally {
    cleanup();
  }
});

test("重复标题按「同标题 + 精确范围」唯一匹配；错范围列出候选；尾随换行不累积空行", () => {
  const dup = "# T\n\n## S\n\n甲\n\n## S\n\n乙\n";
  const target = replaceSections(dup, [
    { heading: "S", startLine: 7, endLine: 9, content: "## S\n\n乙已改。" },
  ]);
  assert.equal(target.ok, true, JSON.stringify(target));
  if (target.ok) {
    assert.match(target.text, /## S\n\n甲\n/);
    assert.match(target.text, /## S\n\n乙已改。/);
  }
  const wrong = replaceSections(dup, [
    { heading: "S", startLine: 1, endLine: 2, content: "x" },
  ]);
  assert.equal(wrong.ok, false);
  if (!wrong.ok) {
    assert.equal(wrong.code, "section_drift");
    assert.equal((wrong.details as unknown[]).length, 2, "应列出两个候选范围");
  }

  // content 以换行结尾 = 行终止符，不产生额外空行
  const range = rangeOf(DOC, "乙节");
  const tail = replaceSections(DOC, [
    { heading: "乙节", ...range, content: "## 乙节\n\n乙已改写。\n" },
  ]);
  assert.equal(tail.ok, true);
  if (tail.ok) assert.match(tail.text, /乙已改写。\n$/);
});
