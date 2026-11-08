// hash-edit 集成层: 经假宿主调 `apply`, 断言两个工具的 canonical 值、`output.render` 投影、
// 落盘结果与失败路径. 装配器见 `hash-edit/tests/assemble.ts`; 落盘一律在 `os.tmpdir()` 的临时目录,
// 用例结束删除.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";

import { hashLine, name, inject } from "../../src/index.ts";
import { assemble, makeWorkspace } from "../assemble.ts";

/** 基线内容 2 行与它的固定向量（sha256 前 8 位, 与 hash-edit/tests/hashline.test.ts 同口径） */
const CONTENT = "alpha\nbeta\n";
const ALPHA_HASH = "8ed3f6ad";
const BETA_HASH = "f44e64e7";
const BETA2_HASH = "9f67bd9c";
const CONTENT_FILE_HASH =
  "e49c81e2d2f84e259d40e2fb8192f3bcd198b355184845d76d8f58807d0d78ee";
const BETA2_FILE_HASH =
  "611214ae0c6bb17d9637f991d503f43aef2a75b7eec3a0f1ee97e60c0ebcf901";

/** `hash_read` 的 canonical 返回形状 */
interface ReadValue {
  ok: true;
  path: string;
  file_hash: string;
  line_count: number;
  hashlines: Array<{ line: number; hash: string; text: string }>;
}

/** `hash_edit` 的 canonical 返回形状 */
interface EditValue {
  ok: true;
  path: string;
  content: string;
  line_count: number;
  file_hash: string;
  hashlines: Array<{ line: number; hash: string; text: string }>;
  applied: Array<{ op: string; line: number; new_line_count: number }>;
}

/** 失败返回的公共形状（工具不抛异常, 以 `code` 区分） */
interface FailureValue {
  ok: false;
  code?: string;
  error: string;
  details?: Array<{
    anchor: string;
    line?: number;
    expected?: string;
    actual?: string;
    reason: string;
  }>;
}

/** 把 render 投影文本还原为 JSON（投影是 `JSON.stringify(value, null, 2)`） */
function parseProjection(
  blocks: Array<{ type: string; text: string }>,
): unknown {
  assert.equal(blocks.length, 1, "投影只出一段文本");
  assert.equal(blocks[0]?.type, "text");
  return JSON.parse(blocks[0]?.text ?? "");
}

// ---------------------------------------------------------------------------
// 装配面
// ---------------------------------------------------------------------------

test("装配: 注册 hash_read / hash_edit, 不订阅事件、不 provide 服务、无告警", async () => {
  const host = await assemble();
  assert.equal(name, "hash-edit");
  assert.deepEqual(inject, ["tools", "fs"]);
  assert.deepEqual(host.tools.names(), ["hash_read", "hash_edit"]);
  assert.equal(host.events.listenerCount(), 0);
  assert.deepEqual(host.services.names(), ["fs", "workingDirectory"]);
  assert.deepEqual(host.stderr, []);
});

test("装配: 参数 schema 编译为顶层 object, 只声明真实必填项", async () => {
  const host = await assemble();
  const expected = [
    {
      name: "hash_read",
      required: ["path"],
      keys: ["path", "offset", "limit"],
    },
    { name: "hash_edit", required: ["path", "edits"], keys: ["path", "edits"] },
  ];
  for (const { name: toolName, required, keys } of expected) {
    const tool = host.tools.require(toolName);
    assert.equal(tool.parameters.type, "object");
    assert.deepEqual(tool.parameters.required, required);
    assert.deepEqual(Object.keys(tool.parameters.properties), keys);
    assert.equal(tool.output.schema.type, "object");
    assert.equal(tool.output.schema.additionalProperties, true);
  }
});

test("装配: 缺 ctx.tools 时只告警, 不抛错也不注册工具", async () => {
  const host = await assemble({ shape: "no-tools" });
  assert.equal(host.stderr.length, 1);
  assert.match(host.stderr[0] ?? "", /ctx\.tools unavailable/);
  assert.deepEqual(host.tools.names(), []);
});

test("装配: 宿主拒绝注册时逐个告警, apply 不抛", async () => {
  const host = await assemble({ registerThrows: true });
  assert.deepEqual(host.tools.names(), []);
  assert.equal(host.stderr.length, 2, "两个工具各一条告警");
  assert.match(host.stderr[0] ?? "", /tool hash_read registration failed/);
  assert.match(host.stderr[1] ?? "", /tool hash_edit registration failed/);
});

test("装配: 显式 config.root 让相对路径落到该目录, render 投影的是结果不是入参", async () => {
  const ws = await makeWorkspace();
  try {
    const host = await assemble({ config: { root: ws.dir } });
    const value = (await host.execute("hash_read", {
      path: "sample.txt",
    })) as ReadValue;
    assert.equal(value.path, ws.path("sample.txt"));
    const text = host.render("hash_read", value, { path: "sample.txt" })[0]
      ?.text;
    assert.ok(text !== undefined);
    assert.ok(!text.includes('"offset"'), "入参字段不进投影");
    assert.deepEqual(parseProjection(host.render("hash_read", value)), value);
  } finally {
    await ws.cleanup();
  }
});

test("装配: config.root 为空串按未配置, 相对路径回落 exec 会话 cwd", async () => {
  const ws = await makeWorkspace();
  try {
    const host = await assemble({ config: { root: "" } });
    const exec = { agent: { session: { header: { cwd: ws.dir } } } };
    const value = (await host.execute(
      "hash_read",
      { path: "sample.txt" },
      exec,
    )) as ReadValue;
    assert.equal(value.path, ws.path("sample.txt"));
  } finally {
    await ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// hash_read canonical 值
// ---------------------------------------------------------------------------

test("hash_read: 返回 1 基行号 + sha256 前 8 位锚点与全文哈希", async () => {
  const ws = await makeWorkspace();
  try {
    const host = await assemble();
    const value = (await host.execute("hash_read", {
      path: ws.path("sample.txt"),
    })) as ReadValue;
    assert.deepEqual(value, {
      ok: true,
      path: ws.path("sample.txt"),
      file_hash: CONTENT_FILE_HASH,
      line_count: 2,
      hashlines: [
        { line: 1, hash: ALPHA_HASH, text: "alpha" },
        { line: 2, hash: BETA_HASH, text: "beta" },
      ],
    });
  } finally {
    await ws.cleanup();
  }
});

test("hash_read: offset / limit 为 1 基窗口, 越窗返回空列表", async () => {
  const ws = await makeWorkspace({ "sample.txt": "a\nb\nc\n" });
  try {
    const host = await assemble();
    const win = (await host.execute("hash_read", {
      path: ws.path("sample.txt"),
      offset: 2,
      limit: 1,
    })) as ReadValue;
    assert.equal(win.line_count, 3);
    assert.deepEqual(
      win.hashlines.map((row) => row.text),
      ["b"],
    );
    const over = (await host.execute("hash_read", {
      path: ws.path("sample.txt"),
      offset: 9,
    })) as ReadValue;
    assert.deepEqual(over.hashlines, [], "越窗不报错, 返回空列表");
  } finally {
    await ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// hash_edit canonical 值 + 落盘
// ---------------------------------------------------------------------------

test("hash_edit: set_line 返回新内容 / 新锚点 / applied, 并原子落盘", async () => {
  const ws = await makeWorkspace();
  try {
    const host = await assemble();
    const value = (await host.execute("hash_edit", {
      path: ws.path("sample.txt"),
      edits: [{ set_line: { anchor: `2:${BETA_HASH}`, new_text: "BETA2" } }],
    })) as EditValue;
    assert.equal(value.ok, true);
    assert.equal(value.content, "alpha\nBETA2\n");
    assert.equal(value.line_count, 2);
    assert.equal(value.file_hash, BETA2_FILE_HASH);
    assert.deepEqual(value.applied, [
      { op: "set", line: 2, new_line_count: 1 },
    ]);
    assert.deepEqual(value.hashlines, [
      { line: 1, hash: ALPHA_HASH, text: "alpha" },
      { line: 2, hash: BETA2_HASH, text: "BETA2" },
    ]);
    // 落盘与返回一致, 且目录无临时文件残留
    assert.equal(await readFile(ws.path("sample.txt"), "utf8"), value.content);
    assert.deepEqual(await ws.list(), ["sample.txt"]);
  } finally {
    await ws.cleanup();
  }
});

test("hash_edit: 结果自带的新锚点可直接用于下一轮编辑", async () => {
  const ws = await makeWorkspace();
  try {
    const host = await assemble();
    const first = (await host.execute("hash_edit", {
      path: ws.path("sample.txt"),
      edits: [{ set_line: { anchor: `2:${BETA_HASH}`, new_text: "BETA2" } }],
    })) as EditValue;
    const next = first.hashlines[1];
    assert.ok(next !== undefined);
    const second = (await host.execute("hash_edit", {
      path: ws.path("sample.txt"),
      edits: [
        {
          set_line: { anchor: `${next.line}:${next.hash}`, new_text: "BETA3" },
        },
      ],
    })) as EditValue;
    assert.equal(second.content, "alpha\nBETA3\n");
    assert.equal(await readFile(ws.path("sample.txt"), "utf8"), second.content);
  } finally {
    await ws.cleanup();
  }
});

test("hash_edit: 多指令一次提交按原始内容校验, 乱序提交仍按行序应用", async () => {
  const ws = await makeWorkspace({ "sample.txt": "one\ntwo\nthree\n" });
  try {
    const host = await assemble();
    const read = (await host.execute("hash_read", {
      path: ws.path("sample.txt"),
    })) as ReadValue;
    const anchor = (line: number): string => {
      const row = read.hashlines[line - 1];
      assert.ok(row !== undefined);
      return `${row.line}:${row.hash}`;
    };
    const value = (await host.execute("hash_edit", {
      path: ws.path("sample.txt"),
      edits: [
        { insert_after: { anchor: anchor(3), new_text: "four" } },
        { delete_line: { anchor: anchor(2) } },
      ],
    })) as EditValue;
    assert.equal(value.content, "one\nthree\nfour\n");
    assert.deepEqual(
      value.applied.map((row) => [row.op, row.line]),
      [
        ["delete", 2],
        ["insert", 3],
      ],
    );
  } finally {
    await ws.cleanup();
  }
});

test("hash_edit: 成功投影与 read 同一形状（经 render 到模型可见的 JSON）", async () => {
  const ws = await makeWorkspace();
  try {
    const host = await assemble();
    const value = (await host.execute("hash_edit", {
      path: ws.path("sample.txt"),
      edits: [{ insert_after: { anchor: `1:${ALPHA_HASH}`, new_text: "mid" } }],
    })) as EditValue;
    const projection = parseProjection(host.render("hash_edit", value));
    assert.deepEqual(projection, value);
    const text = host.render("hash_edit", value)[0]?.text ?? "";
    assert.match(text, /"ok": true/);
    assert.ok(!text.includes('"edits"'), "入参不进投影");
  } finally {
    await ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 失败路径: 一律以 code 返回, 不抛异常, 文件字节不变
// ---------------------------------------------------------------------------

test("失败路径: stale 整批拒绝, details 带 expected/actual, 文件不变", async () => {
  const ws = await makeWorkspace();
  try {
    const host = await assemble();
    // 外部修改第 1 行后再用旧锚点: 第 1 行 stale, 第 2 行仍匹配（只列 stale 的那条）
    const external = "ALPHA\nbeta\n";
    await writeFile(ws.path("sample.txt"), external);
    const value = (await host.execute("hash_edit", {
      path: ws.path("sample.txt"),
      edits: [
        { set_line: { anchor: `1:${ALPHA_HASH}`, new_text: "A1" } },
        { set_line: { anchor: `2:${BETA_HASH}`, new_text: "B1" } },
      ],
    })) as FailureValue;
    assert.equal(value.ok, false);
    assert.equal(value.code, "stale_anchors");
    assert.deepEqual(value.details, [
      {
        anchor: `1:${ALPHA_HASH}`,
        line: 1,
        expected: ALPHA_HASH,
        actual: hashLine("ALPHA"),
        reason: "stale anchor: content hash mismatch",
      },
    ]);
    assert.equal(await readFile(ws.path("sample.txt"), "utf8"), external);
    // 失败投影同样落 JSON, 模型可读到 code 与 details
    const text = host.render("hash_edit", value)[0]?.text ?? "";
    assert.match(text, /"code": "stale_anchors"/);
  } finally {
    await ws.cleanup();
  }
});

test("失败路径: out_of_range 列出越界锚点行号", async () => {
  const ws = await makeWorkspace();
  try {
    const host = await assemble();
    const value = (await host.execute("hash_edit", {
      path: ws.path("sample.txt"),
      edits: [{ delete_line: { anchor: `9:${ALPHA_HASH}` } }],
    })) as FailureValue;
    assert.equal(value.ok, false);
    assert.equal(value.code, "out_of_range");
    assert.deepEqual(
      value.details?.map((row) => [row.anchor, row.line]),
      [[`9:${ALPHA_HASH}`, 9]],
    );
    assert.equal(await readFile(ws.path("sample.txt"), "utf8"), CONTENT);
  } finally {
    await ws.cleanup();
  }
});

test("失败路径: edits 形状非法一律 malformed, 并带出下标", async () => {
  const ws = await makeWorkspace();
  try {
    const host = await assemble();
    const cases: Array<[unknown, RegExp]> = [
      [undefined, /edits must be a non-empty array/],
      [[], /edits must be a non-empty array/],
      ["nope", /edits must be a non-empty array/],
      [[42], /edits\[0\] must be an object/],
      [
        [
          {
            set_line: { anchor: `1:${ALPHA_HASH}`, new_text: "x" },
            delete_line: { anchor: `1:${ALPHA_HASH}` },
          },
        ],
        /edits\[0\] must contain exactly one of/,
      ],
      [
        [{ rename_line: { anchor: `1:${ALPHA_HASH}` } }],
        /edits\[0\] must contain exactly one of/,
      ],
      [[{ set_line: "x" }], /edits\[0\]\.set_line must be an object/],
    ];
    for (const [edits, pattern] of cases) {
      const value = (await host.execute("hash_edit", {
        path: ws.path("sample.txt"),
        edits,
      })) as FailureValue;
      assert.equal(value.ok, false, `应拒绝: ${JSON.stringify(edits)}`);
      assert.equal(value.code, "malformed");
      assert.match(value.error, pattern);
    }
    assert.equal(await readFile(ws.path("sample.txt"), "utf8"), CONTENT);
  } finally {
    await ws.cleanup();
  }
});

test("失败路径: 文件不存在返回 not_found, 两个工具一致", async () => {
  const ws = await makeWorkspace();
  try {
    const host = await assemble();
    const missing = ws.path("missing.txt");
    for (const [tool, args] of [
      ["hash_read", { path: missing }],
      ["hash_edit", { path: missing, edits: [] }],
    ] as const) {
      const value = (await host.execute(tool, args)) as FailureValue;
      assert.equal(value.ok, false, tool);
      if (tool === "hash_edit") {
        assert.equal(value.code, "malformed", "edits 校验先于读文件");
        continue;
      }
      assert.equal(value.code, "not_found");
      assert.match(value.error, /file not found/);
    }
    const editMissing = (await host.execute("hash_edit", {
      path: missing,
      edits: [{ delete_line: { anchor: `1:${ALPHA_HASH}` } }],
    })) as FailureValue;
    assert.equal(editMissing.code, "not_found");
  } finally {
    await ws.cleanup();
  }
});

test("失败路径: 非 UTF-8 文件返回 not_utf8, 不写盘", async () => {
  const buf = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
  const ws = await makeWorkspace({ "binary.bin": buf });
  try {
    const host = await assemble();
    const readValue = (await host.execute("hash_read", {
      path: ws.path("binary.bin"),
    })) as FailureValue;
    assert.equal(readValue.code, "not_utf8");
    const editValue = (await host.execute("hash_edit", {
      path: ws.path("binary.bin"),
      edits: [{ delete_line: { anchor: `1:${ALPHA_HASH}` } }],
    })) as FailureValue;
    assert.equal(editValue.code, "not_utf8");
    assert.deepEqual(await readFile(ws.path("binary.bin")), buf);
  } finally {
    await ws.cleanup();
  }
});

test("失败路径: 入参校验（缺 path / offset 与 limit 非正）", async () => {
  const ws = await makeWorkspace();
  try {
    const host = await assemble();
    for (const args of [{}, { path: "" }, { path: 42 }]) {
      const readValue = (await host.execute("hash_read", args)) as FailureValue;
      assert.equal(readValue.error, "path is required");
      const editValue = (await host.execute("hash_edit", args)) as FailureValue;
      assert.equal(editValue.error, "path is required");
    }
    for (const [offset, limit] of [
      [0, 5],
      [1, 0],
      [-1, 5],
      [2, -3],
    ]) {
      const value = (await host.execute("hash_read", {
        path: ws.path("sample.txt"),
        offset,
        limit,
      })) as FailureValue;
      assert.equal(
        value.error,
        "offset and limit must be positive integers",
        `offset=${offset} limit=${limit}`,
      );
    }
    // 非整数类型按缺省（offset=1 / limit=200）处理, 不报错
    const ok = (await host.execute("hash_read", {
      path: ws.path("sample.txt"),
      offset: "2",
      limit: 1.5,
    })) as ReadValue;
    assert.equal(ok.ok, true);
    assert.equal(ok.hashlines.length, 2);
  } finally {
    await ws.cleanup();
  }
});
