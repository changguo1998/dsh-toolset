// tests/edit.test.ts — 按节改写：漂移即拒、整批原子、风格保留、工具面。
//
// 安全语义：`heading`（标题文本）+ `startLine` / `endLine`（来自 structure）必须与**当前**解析一致；
// 任一条不符 → 整体拒绝且不落盘；写盘走临时文件 + rename。
//
// 注意：多处用例以 `content: "x"`（非标题）作填充——它们同时是**校验优先级承重测试**
// （漂移 / 缺失 / 越界必须先于 content_invalid 返回），勿改成标题文本。

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
  sameSignature,
  sectionHash,
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

test("sectionHash：风格无关、空白敏感、覆盖子节（锚点口径）", () => {
  const range = rangeOf(DOC, "甲节");
  const hash = sectionHash(DOC, range.startLine, range.endLine);
  assert.match(hash, /^[0-9a-f]{8}$/);
  // 风格无关：BOM / CRLF 不参与（与 parse 同归一）
  const crlf = "\uFEFF" + DOC.replace(/\n/g, "\r\n");
  assert.equal(sectionHash(crlf, range.startLine, range.endLine), hash);
  // 空白敏感（不 trim）：行首缩进是真实内容改动
  const indented = DOC.replace("甲的正文。", "  甲的正文。");
  assert.notEqual(sectionHash(indented, range.startLine, range.endLine), hash);
  // 覆盖子节：改子节 → 祖先节 hash 变（fail-safe，需重取）
  const childChanged = DOC.replace("乙的第一行。", "乙已改写。");
  assert.notEqual(sectionHash(childChanged, 1, 12), sectionHash(DOC, 1, 12));
});

test("replaceSections：section_hash 拒「同标题同范围但内容已改」（漂移盲区四例）", () => {
  const range = rangeOf(DOC, "甲节");
  const hash = sectionHash(DOC, range.startLine, range.endLine);
  const edit = (value: string | undefined) => [
    {
      heading: "甲节",
      startLine: range.startLine,
      endLine: range.endLine,
      content: "## 甲节\n\n新正文。",
      ...(value === undefined ? {} : { sectionHash: value }),
    },
  ];
  // 正向：hash 正确 → 放行；不带 hash → 既有语义（放行）
  assert.equal(replaceSections(DOC, edit(hash)).ok, true);
  assert.equal(replaceSections(DOC, edit(undefined)).ok, true);

  // 反例 1：节体改写（标题与行范围不变）
  const bodyChanged = DOC.replace("甲的正文。", "甲已改写。");
  const stale1 = replaceSections(bodyChanged, edit(hash));
  assert.equal(stale1.ok, false);
  if (!stale1.ok) {
    assert.equal(stale1.code, "section_stale");
    assert.match(stale1.error, /内容已被外部改动/);
    assert.ok(Array.isArray(stale1.details));
  }
  // 反例 2：行首空白改动（锁「不 trim」契约）
  const indentChanged = DOC.replace("甲的正文。", "  甲的正文。");
  assert.equal(replaceSections(indentChanged, edit(hash)).ok, false);
  // 反例 3：标题级别变化（文本与行范围都不变）
  const levelChanged = DOC.replace("## 甲节", "### 甲节");
  assert.equal(replaceSections(levelChanged, edit(hash)).ok, false);
  // 反例 4：只动子节 → 祖先节旧 hash 失效；子节自己的新 hash 放行
  const childChanged = DOC.replace("乙的第一行。", "乙已改写。");
  const rootStale = replaceSections(childChanged, [
    {
      heading: "标题",
      startLine: 1,
      endLine: 12,
      content: "# 标题\n\n新前言。",
      sectionHash: sectionHash(DOC, 1, 12),
    },
  ]);
  assert.equal(rootStale.ok, false);
  const childRange = rangeOf(childChanged, "乙节");
  const childOk = replaceSections(childChanged, [
    {
      heading: "乙节",
      startLine: childRange.startLine,
      endLine: childRange.endLine,
      content: "## 乙节\n\n新乙节。",
      sectionHash: sectionHash(
        childChanged,
        childRange.startLine,
        childRange.endLine,
      ),
    },
  ]);
  assert.equal(childOk.ok, true, JSON.stringify(childOk));
});

test("sameSignature：纯函数正反例（TOCTOU 复核口径）", () => {
  const base = { ino: 1, size: 10, mtimeMs: 1000 };
  assert.equal(sameSignature(base, { ...base }), true);
  assert.equal(sameSignature(base, { ...base, ino: 2 }), false);
  assert.equal(sameSignature(base, { ...base, size: 11 }), false);
  assert.equal(sameSignature(base, { ...base, mtimeMs: 1001 }), false);
});

test("replaceSectionsFile：连续两次写不误报 file_changed（复核只挡外部改动）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "t.md", DOC);
    const first = await replaceSectionsFile(file, [
      {
        heading: "甲节",
        startLine: 5,
        endLine: 7,
        content: "## 甲节\n\n第一次。",
      },
    ]);
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await replaceSectionsFile(file, [
      {
        heading: "甲节",
        startLine: 5,
        endLine: 7,
        content: "## 甲节\n\n第二次。",
      },
    ]);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.match(readFileSync(file, "utf8"), /第二次/);
  } finally {
    cleanup();
  }
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

test("replaceSections：content 非空必须以标题行开头（防静默并入父节）", () => {
  const range = rangeOf(DOC, "乙节");
  // ① 正文开头 → content_invalid（原先会被静默并入父节）
  const plain = replaceSections(DOC, [
    { heading: "乙节", ...range, content: "乙已改写。\n" },
  ]);
  assert.equal(plain.ok, false);
  if (!plain.ok) {
    assert.equal(plain.code, "content_invalid");
    assert.match(plain.error, /标题行/);
  }
  // ② 「#foo」不是标题（挡 `startsWith("#")` 式的错误实现）
  const hashOnly = replaceSections(DOC, [
    { heading: "乙节", ...range, content: "#foo\n" },
  ]);
  assert.equal(hashOnly.ok, false);
  if (!hashOnly.ok) assert.equal(hashOnly.code, "content_invalid");
  // ③ 前导空行 → 标题不在第 1 行 → 拒
  const leadingBlank = replaceSections(DOC, [
    { heading: "乙节", ...range, content: "\n## 乙节\n" },
  ]);
  assert.equal(leadingBlank.ok, false);
  if (!leadingBlank.ok) assert.equal(leadingBlank.code, "content_invalid");
  // ④ 空标题节（`#` 无文本）→ 拒：该节此后无法用 heading 定位
  const emptyTitle = replaceSections(DOC, [
    { heading: "乙节", ...range, content: "#\n" },
  ]);
  assert.equal(emptyTitle.ok, false);
  if (!emptyTitle.ok) assert.equal(emptyTitle.code, "content_invalid");
  // ⑤ setext 且目标节前一行是空行 → 放行（既有 ATX / setext 双风格支持）
  const setextOk = replaceSections(DOC, [
    { heading: "乙节", ...range, content: "乙节\n---\n\n乙已改写。" },
  ]);
  assert.equal(setextOk.ok, true, JSON.stringify(setextOk));
  // ⑥ 优先级：坏 content + 漂移范围 → 先报 section_drift（既有优先级不回归）
  const driftFirst = replaceSections(DOC, [
    {
      heading: "乙节",
      startLine: range.startLine - 1,
      endLine: range.endLine,
      content: "x",
    },
  ]);
  assert.equal(driftFirst.ok, false);
  if (!driftFirst.ok) assert.equal(driftFirst.code, "section_drift");
});

test("replaceSections：content 首行标题层级须与目标节一致（改层级拒绝，改标题文本放行）", () => {
  const range = rangeOf(DOC, "乙节"); // `## 乙节` = h2
  // ① 降级 h2 → h3：拒（其后同级 / 更低级别节会被吞成该节的子节）
  const demote = replaceSections(DOC, [
    { heading: "乙节", ...range, content: "### 乙节\n\n乙已改写。" },
  ]);
  assert.equal(demote.ok, false);
  if (!demote.ok) {
    assert.equal(demote.code, "content_invalid");
    assert.match(demote.error, /层级/);
  }
  // ② 升级 h2 → h1：同样拒（会把父节挤出）
  const promote = replaceSections(DOC, [
    { heading: "乙节", ...range, content: "# 乙节\n\n乙已改写。" },
  ]);
  assert.equal(promote.ok, false);
  if (!promote.ok) assert.equal(promote.code, "content_invalid");
  // ③ setext h1（`===`）与目标 h2 不等价 → 拒（风格可换，层级不可）
  const setextH1 = replaceSections(DOC, [
    { heading: "乙节", ...range, content: "乙节\n===\n\n乙已改写。" },
  ]);
  assert.equal(setextH1.ok, false);
  if (!setextH1.ok) assert.equal(setextH1.code, "content_invalid");
  // ④ 同层级改标题文本（合法重命名）→ 放行
  const rename = replaceSections(DOC, [
    { heading: "乙节", ...range, content: "## 乙节（改名）\n\n乙已改写。" },
  ]);
  assert.equal(rename.ok, true, JSON.stringify(rename));
  if (rename.ok) {
    assert.match(rename.text, /## 乙节（改名）/);
    assert.ok(!rename.text.includes("### 乙节"), "改层级不得落盘");
  }
  // ⑤ 同一批「一条合法 + 一条改层级」→ 整批拒绝（原子）
  const mixed = replaceSections(DOC, [
    {
      heading: "甲节",
      ...rangeOf(DOC, "甲节"),
      content: "## 甲节\n\n甲已改写。",
    },
    { heading: "乙节", ...range, content: "### 乙节\n\n乙已改写。" },
  ]);
  assert.equal(mixed.ok, false);
  if (!mixed.ok) assert.equal(mixed.code, "content_invalid");
  // ⑥ 首行之外内嵌更高级标题（`# 偷渡`）→ 拒（该节被提前收束，后续同级节被吞进新顶层节）
  const stray = replaceSections(DOC, [
    {
      heading: "乙节",
      ...range,
      content: "## 乙节\n\n乙已改写。\n\n# 偷渡\n\n新的顶层节。",
    },
  ]);
  assert.equal(stray.ok, false);
  if (!stray.ok) {
    assert.equal(stray.code, "content_invalid");
    assert.match(stray.error, /更深/);
  }
  // ⑦ 首行之外内嵌更深层级标题（子节）→ 放行（节树内的合法扩展）
  const deeper = replaceSections(DOC, [
    {
      heading: "乙节",
      ...range,
      content: "## 乙节\n\n乙已改写。\n\n### 子节\n\n子节正文。",
    },
  ]);
  assert.equal(deeper.ok, true, JSON.stringify(deeper));
  if (deeper.ok) assert.match(deeper.text, /### 子节/);
});

test("replaceSections：setext 首行 + 目标节前一行非空 → 拒（会吞并上一段）", () => {
  // 反例：替换 B 后「body A + T2 + ---」被解析为同一个 setext 标题，前节正文丢失
  const doc = "# H\n\n## A\n\nbody A\n## B\n\nbody B\n";
  const range = rangeOf(doc, "B");
  const out = replaceSections(doc, [
    { heading: "B", ...range, content: "T2\n---\n\nbody B2" },
  ]);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.code, "content_invalid");
    assert.match(out.error, /吞并/);
  }
  // 同一内容改用 ATX → 放行
  const atx = replaceSections(doc, [
    { heading: "B", ...range, content: "## T2\n\nbody B2" },
  ]);
  assert.equal(atx.ok, true, JSON.stringify(atx));
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

    // ①.5 section_hash 格式非法：edits_invalid（不触盘；避免抄错位数被误报 section_stale）
    const badHash = await tool.execute(
      {
        action: "replace",
        path: "a.md",
        edits: [
          {
            heading: "乙节",
            start_line: 1,
            end_line: 2,
            content: "x",
            section_hash: "a1b2c3d",
          },
        ],
      },
      exec,
    );
    assert.match(String(badHash["error"]), /8 位 hex/);
    assert.equal(readFileSync(file, "utf8"), DOC, "非法 hash 不得写盘");

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

    // ②.5 content 非法：content_invalid 透传 + 下一步提示补标题行 + 不落盘
    const rB = rangeOf(DOC, "乙节");
    const badContent = await tool.execute(
      {
        action: "replace",
        path: "a.md",
        edits: [
          {
            heading: "乙节",
            start_line: rB.startLine,
            end_line: rB.endLine,
            content: "没有标题开头。",
          },
        ],
      },
      exec,
    );
    const badText = tool.output.render({}, badContent)[0]?.text ?? "";
    assert.match(badText, /replace 失败（content_invalid）/);
    assert.match(badText, /补首行标题/);
    assert.equal(readFileSync(file, "utf8"), DOC, "content 非法不得写盘");

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
    assert.match(text, /重新 action=structure 取范围/, "成功渲染带结构提示");
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

test("混合 EOL：未改动行保留原行尾，替换行用主导风格（修「整文件行尾翻转」）", () => {
  // CRLF 主导 + 中间两行 LF（未改动）；被替换的丙节在末尾
  const text =
    "# 标题\r\n## 甲节\r\n内容甲。\r\n## 乙节\n内容乙\n## 丙节\r\n内容丙\r\n";
  const out = replaceSections(text, [
    {
      heading: "丙节",
      startLine: 6,
      endLine: 7,
      content: "## 丙节\n新内容丙。\n",
    },
  ]);
  assert.equal(out.ok, true, out.ok ? "" : out.error);
  if (!out.ok) return;
  assert.ok(
    out.text.startsWith("# 标题\r\n## 甲节\r\n内容甲。\r\n"),
    "前缀逐字节不变",
  );
  assert.ok(
    out.text.includes("## 乙节\n内容乙\n"),
    "未改动的 LF 行不得被翻成 CRLF",
  );
  assert.ok(
    out.text.includes("## 丙节\r\n新内容丙。\r\n"),
    "替换行用主导 EOL（CRLF）",
  );
});

test("混合 EOL：LF 主导时新增行用 LF；纯风格文件行为与旧版逐字节一致", () => {
  // LF 主导（3 LF vs 2 CRLF），替换末尾节 → 新行用 LF，未改动的 CRLF 行保持
  const mixed =
    "# 标题\n## 甲节\r\n内容甲。\r\n## 乙节\n内容乙\n## 丙节\n内容丙\n";
  const out = replaceSections(mixed, [
    {
      heading: "丙节",
      startLine: 6,
      endLine: 7,
      content: "## 丙节\n新内容丙。\n",
    },
  ]);
  assert.equal(out.ok, true, out.ok ? "" : out.error);
  if (!out.ok) return;
  assert.ok(
    out.text.includes("## 甲节\r\n内容甲。\r\n"),
    "未改动的 CRLF 行保持 CRLF",
  );
  assert.ok(out.text.includes("## 丙节\n新内容丙。\n"), "LF 主导时新行用 LF");

  // 纯 LF：与旧版（全文件 LF）逐字节一致
  const lf = replaceSections("# 标题\n## 甲节\n内容甲。\n## 乙节\n内容乙\n", [
    {
      heading: "乙节",
      startLine: 4,
      endLine: 5,
      content: "## 乙节\n新内容乙。\n",
    },
  ]);
  assert.equal(lf.ok, true);
  if (lf.ok)
    assert.equal(lf.text, "# 标题\n## 甲节\n内容甲。\n## 乙节\n新内容乙。\n");

  // 纯 CRLF：与旧版（全文件 CRLF）逐字节一致
  const crlf = replaceSections(
    "# 标题\r\n## 甲节\r\n内容甲。\r\n## 乙节\r\n内容乙\r\n",
    [
      {
        heading: "乙节",
        startLine: 4,
        endLine: 5,
        content: "## 乙节\n新内容乙。\n",
      },
    ],
  );
  assert.equal(crlf.ok, true);
  if (crlf.ok) {
    assert.equal(
      crlf.text,
      "# 标题\r\n## 甲节\r\n内容甲。\r\n## 乙节\r\n新内容乙。\r\n",
    );
  }
});

test("混合 EOL + 末行无换行：替换后不得粘连行（审阅 P1 回归）", () => {
  // 原文末行无 EOL（混合：CRLF + LF）
  const input = "# H\r\n## S\nbody";
  const out = replaceSections(input, [
    { heading: "S", startLine: 2, endLine: 3, content: "## S\nbody\nmore" },
  ]);
  assert.equal(out.ok, true, out.ok ? "" : out.error);
  if (!out.ok) return;
  assert.ok(
    !out.text.includes("bodymore"),
    "不得把两行粘连（原末行无 EOL 被复用到非末行）",
  );
  assert.equal(
    out.text,
    "# H\r\n## S\nbody\nmore",
    "未改动首行保 CRLF，新行用主导风格且行结构完整",
  );
});

test("replaceSections：content 内未闭合围栏 / 注释 → 拒（会吞掉其后全部节）", () => {
  // 反例来源：条目「content 内未闭合代码围栏 / HTML 注释会静默吞掉其后全部节」——
  // CommonMark 里两者都直到文件结尾才结束，写入后其后节从节树消失（层级 / fenced 守卫都不拦）
  const doc = "# H\n\n## 甲节\n\n甲正文\n\n## 乙节\n\n乙正文\n";
  const range = rangeOf(doc, "乙节");
  // 用「目标节之后还有节」的文档：判据是「其后节是否从节树消失」（解析器裁决）
  const docTail =
    "# H\n\n## 甲节\n\n甲正文\n\n## 乙节\n\n乙正文\n\n## 丙节\n\n丙\n";
  const rangeTail = rangeOf(docTail, "乙节");
  const unclosedFence = replaceSections(docTail, [
    {
      heading: "乙节",
      ...rangeTail,
      content: "## 乙节\n\n```sh\npwd\n",
    },
  ]);
  assert.equal(unclosedFence.ok, false);
  if (!unclosedFence.ok) {
    assert.equal(unclosedFence.code, "content_invalid");
    assert.match(unclosedFence.error, /代码围栏未闭合/);
  }
  // 目标节是**最后一节**时，未闭合围栏只会吞掉它自己的后续正文（没有别的节会消失）→ 放行
  const lastSectionFence = replaceSections(doc, [
    {
      heading: "乙节",
      ...range,
      content: "## 乙节\n\n```sh\npwd\n",
    },
  ]);
  assert.equal(
    lastSectionFence.ok,
    true,
    "目标节之后无其它节 → 不存在「丢节」，不做结构拦截",
  );
  const unclosedComment = replaceSections(docTail, [
    {
      heading: "乙节",
      ...rangeTail,
      content: "## 乙节\n\n<!-- 注释没关\n\n正文\n",
    },
  ]);
  assert.equal(unclosedComment.ok, false);
  if (!unclosedComment.ok) {
    assert.equal(unclosedComment.code, "content_invalid");
    assert.match(unclosedComment.error, /注释未闭合/);
  }
  // 漏拦面（审阅实测）：反引号围栏的 info 串含反引号时**不是开栏**（CommonMark）——
  // 若误当开栏，会把后面真正的开栏当闭行 → 真吞节却被放行
  const leaked = replaceSections(docTail, [
    {
      heading: "乙节",
      ...rangeTail,
      content: "## 乙节\n\n```a`b\nx\n```\n",
    },
  ]);
  assert.equal(
    leaked.ok,
    false,
    "info 含反引号不是开栏，后续 ``` 才是真开栏（未闭合）",
  );
  if (!leaked.ok) assert.match(leaked.error, /代码围栏未闭合/);
  // 容器化（2026-10-05）：列表项 / 引用块内的围栏与注释按**剥离容器前缀后的相位**判定。
  // 用带后续节的文档，断言「配对容器围栏不吞其后节」（重解析节数不变）
  const doc3 = "# H\n\n## 甲节\n\n甲\n\n## 乙节\n\n乙\n\n## 丙节\n\n丙\n";
  const range3 = rangeOf(doc3, "乙节");
  const containerFence = replaceSections(doc3, [
    {
      heading: "乙节",
      ...range3,
      content: "## 乙节\n\n- ```sh\n  pwd\n  ```\n",
    },
  ]);
  assert.equal(
    containerFence.ok,
    true,
    "容器内配对围栏应放行: " + JSON.stringify(containerFence),
  );
  if (containerFence.ok) {
    assert.deepEqual(
      flattenSections(parseMarkdownDocument(containerFence.text).sections).map(
        (section) => section.title,
      ),
      ["H", "甲节", "乙节", "丙节"],
      "容器内配对围栏不得吞掉其后节（H / 甲 / 乙 / 丙 四节仍在）",
    );
  }
  // 容器内围栏 + 一行散围栏 = 散围栏成开栏且无闭行 → 真吞其后节，必须拒
  const containerLeak = replaceSections(doc3, [
    {
      heading: "乙节",
      ...range3,
      content: "## 乙节\n\n- ```sh\n  pwd\n  ```\n```\n",
    },
  ]);
  assert.equal(
    containerLeak.ok,
    false,
    "容器内围栏后的散围栏是未闭合开栏，必须拒",
  );
  if (!containerLeak.ok) assert.match(containerLeak.error, /代码围栏未闭合/);
  // 引用块 / 嵌套（引用块内列表项）/ 列表内注释：配对 → 放行
  for (const content of [
    "## 乙节\n\n> ```sh\n> pwd\n> ```\n",
    "## 乙节\n\n> - ```sh\n>   pwd\n>   ```\n",
    "## 乙节\n\n- <!-- 注释\n  -->\n",
    "## 乙节\n\n1. ```sh\n   pwd\n   ```\n",
  ]) {
    const ok = replaceSections(doc3, [{ heading: "乙节", ...range3, content }]);
    assert.equal(
      ok.ok,
      true,
      "容器内配对写法应放行: " +
        JSON.stringify(content) +
        " → " +
        JSON.stringify(ok),
    );
  }
  // 判据文本 ≡ 落盘文本（审阅实测的漏拦形态）：content 以**空行终止的 HTML 块**结尾、且目标节
  // 之后的第一个节标题**紧贴**时，落盘会因 ③ 剥掉单个尾随换行而真吞其后节 → 必须拒
  const tightHtmlTail = replaceSections(
    "## 乙\n乙正文\n## 丙\n丙正文\n",
    [
      {
        heading: "乙",
        ...rangeOf("## 乙\n乙正文\n## 丙\n丙正文\n", "乙"),
        content: "## 乙\n\n<div>\n",
      },
    ],
  );
  assert.equal(
    tightHtmlTail.ok,
    false,
    "空行终止的 HTML 块 + 紧贴后节标题：判据须与落盘同口径（真吞其后节）→ 拒",
  );
  // 子树收缩（content 丢弃原有子节）是**合法**重写，不算丢节
  const shrinkSubtree = replaceSections(
    "# H\n\n## 甲\n\n甲\n\n## 乙\n\n乙\n\n### 乙.1\n\n子\n\n## 丙\n\n丙\n",
    [
      {
        heading: "乙",
        ...rangeOf(
          "# H\n\n## 甲\n\n甲\n\n## 乙\n\n乙\n\n### 乙.1\n\n子\n\n## 丙\n\n丙\n",
          "乙",
        ),
        content: "## 乙\n\n改写后只剩本节（子节被移除）\n",
      },
    ],
  );
  assert.equal(
    shrinkSubtree.ok,
    true,
    "子树收缩不算丢节: " + JSON.stringify(shrinkSubtree),
  );
  // 相位族（审阅实测的真实语义）：容器内围栏**只能被同相位族的闭行**闭合——
  // 顶层散围栏不闭合它，自己反而成了未闭合的顶层围栏（真吞其后节）→ 必须拒；
  const strayTopFence = replaceSections(doc3, [
    {
      heading: "乙节",
      ...range3,
      content: "## 乙节\n\n- ```sh\n  pwd\n```\n",
    },
  ]);
  assert.equal(
    strayTopFence.ok,
    false,
    "容器内围栏不被顶层散围栏闭合 → 散围栏自身未闭合，必须拒",
  );
  if (!strayTopFence.ok) assert.match(strayTopFence.error, /代码围栏未闭合/);
  // 容器内未闭合（容器结束即截断，**不吞**其后节）→ 放行（不是结构破坏）
  for (const content of [
    "## 乙节\n\n- ```sh\n  pwd\n",
    "## 乙节\n\n> ```sh\n> pwd\n",
    "## 乙节\n\n- <!-- 没关的注释\n",
  ]) {
    const ok = replaceSections(doc3, [{ heading: "乙节", ...range3, content }]);
    assert.equal(
      ok.ok,
      true,
      "容器内未闭合块在容器结束处截断、不吞其后节，应放行: " +
        JSON.stringify(content) +
        " → " +
        JSON.stringify(ok),
    );
  }
  // 顶层围栏正文里演示列表围栏（`- ``` `）：不得被当闭行 → 外层围栏仍未闭合，拒
  const documentedFence = replaceSections(doc3, [
    {
      heading: "乙节",
      ...range3,
      content: "## 乙节\n\n```markdown\n- ```sh\n- ```\n",
    },
  ]);
  assert.equal(
    documentedFence.ok,
    false,
    "顶层围栏正文里的 `- ``` ` 不是闭行 → 外层围栏未闭合，必须拒",
  );
  // 顶层围栏**正文里**的容器记号是字面内容：`- ``` ` 不得被当作闭行（否则外层围栏会「提前闭合」
  // → 漏拦真吞节）。故闭行剥离只在「开栏本身在容器内」时生效。
  const innerMarker = replaceSections(doc3, [
    {
      heading: "乙节",
      ...range3,
      content: "## 乙节\n\n```\n- ```\n\n仍在围栏内\n",
    },
  ]);
  assert.equal(
    innerMarker.ok,
    false,
    "顶层围栏内的 `- ``` ` 不是闭行 → 外层围栏仍未闭合，必须拒",
  );
  if (!innerMarker.ok) assert.match(innerMarker.error, /代码围栏未闭合/);
  // 主题分隔线（`---` / `***`）不是列表记号，不触发容器剥离：不产围栏/注释 → 放行
  for (const content of ["## 乙节\n\n---\n", "## 乙节\n\n***\n"]) {
    const ok = replaceSections(doc3, [{ heading: "乙节", ...range3, content }]);
    assert.equal(ok.ok, true, "主题分隔线应放行: " + JSON.stringify(content));
  }
  // 放行面（不误伤）：配对围栏（含波浪号 / 更长闭合行 / info 含反引号的「普通文本行」）、
  // 跨行注释、行内代码里的 `<!--`、段中 / 列表 / 缩进代码块里的 `<!--`、注释块内的围栏符号
  const allowed = [
    "## 乙节\n\n```sh\npwd\n```\n\n事后正文\n",
    "## 乙节\n\n````md\n```\n````\n",
    "## 乙节\n\n~~~\ntilde fence\n~~~\n",
    "## 乙节\n\n```a`b\nx\n",
    "## 乙节\n\n<!-- 注释\n跨行也合法 -->\n\n正文\n",
    "## 乙节\n\n行内代码 `<!--` 照写\n",
    "## 乙节\n\n正文里 <!-- 没关也不算注释块\n\n后续段落\n",
    "## 乙节\n\n    <!-- 缩进 4 空格 = 代码块\n",
    "## 乙节\n\n<!-- 起\n```\n还在注释里 -->\n\n正文\n",
  ];
  for (const content of allowed) {
    const ok = replaceSections(doc, [{ heading: "乙节", ...range, content }]);
    assert.equal(
      ok.ok,
      true,
      "应放行: " + JSON.stringify(content) + " → " + JSON.stringify(ok),
    );
  }
});
