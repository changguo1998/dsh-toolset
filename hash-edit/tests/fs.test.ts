/**
 * fs 测试：文件级读取/编辑、stale 后文件字节不变、原子写无残留、
 * 权限保留、相对路径 root 解析、非 UTF-8 拒绝、窗口读取。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnchoredEditError } from "../src/edit.ts";
import { hashLine, hashlines } from "../src/hashline.ts";
import {
  FileEditError,
  applyAnchoredEditsFile,
  listDir,
  readHashlines,
} from "../src/fs.ts";

const CONTENT = ["alpha", "beta", "", "delta", "epsilon"].join("\n") + "\n";

async function makeTmp(
  content: string,
): Promise<{ dir: string; path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "hash-edit-test-"));
  const path = join(dir, "sample.txt");
  await writeFile(path, content, "utf8");
  return {
    dir,
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function anchorAt(content: string, line: number): string {
  const row = hashlines(content)[line - 1];
  assert.ok(row);
  return `${row.line}:${row.hash}`;
}

test("全流程：readHashlines → applyAnchoredEditsFile → 回读核对", async () => {
  const t = await makeTmp(CONTENT);
  try {
    const read = await readHashlines(t.path);
    assert.equal(read.line_count, 5);
    assert.match(read.file_hash, /^[0-9a-f]{64}$/);
    assert.equal(read.hashlines[1]?.text, "beta");

    const res = await applyAnchoredEditsFile(t.path, [
      { set_line: { anchor: anchorAt(CONTENT, 2), new_text: "BETA2" } },
      { insert_after: { anchor: anchorAt(CONTENT, 3), new_text: "mid" } },
    ]);
    assert.equal(res.ok, true);
    assert.equal(res.content, "alpha\nBETA2\n\nmid\ndelta\nepsilon\n");
    assert.equal(res.path, t.path);

    const back = await readFile(t.path, "utf8");
    assert.equal(back, res.content);
    // 结果哈希与文件内容自洽
    const fresh = await readHashlines(t.path);
    assert.equal(fresh.file_hash, res.file_hash);
    assert.equal(fresh.line_count, 6);
  } finally {
    await t.cleanup();
  }
});

test("stale：外部修改后旧锚点整批拒绝，文件字节不变", async () => {
  const t = await makeTmp(CONTENT);
  try {
    // 读取锚点（基于 CONTENT）
    const a1 = anchorAt(CONTENT, 1);
    const a3 = anchorAt(CONTENT, 3);
    // 外部修改：第 1 行内容变了
    await writeFile(t.path, "ALPHA'\nbeta\n\ndelta\nepsilon\n", "utf8");

    await assert.rejects(
      applyAnchoredEditsFile(t.path, [
        { set_line: { anchor: a1, new_text: "X" } },
        { set_line: { anchor: a3, new_text: "Y" } },
      ]),
      (err: unknown) => {
        assert.ok(err instanceof AnchoredEditError);
        assert.equal(err.code, "stale_anchors");
        // 只有第 1 行 stale，第 3 行（空行）仍匹配 → details 只列第 1 行
        assert.equal(err.details.length, 1);
        assert.equal(err.details[0]?.line, 1);
        return true;
      },
    );
    // 文件保持外部修改后的内容，未被半写
    assert.equal(
      await readFile(t.path, "utf8"),
      "ALPHA'\nbeta\n\ndelta\nepsilon\n",
    );
  } finally {
    await t.cleanup();
  }
});

test("文件不存在 → not_found", async () => {
  const t = await makeTmp(CONTENT);
  try {
    await assert.rejects(
      readHashlines(join(t.dir, "missing.txt")),
      (err: unknown) => {
        assert.ok(err instanceof FileEditError);
        assert.equal(err.code, "not_found");
        return true;
      },
    );
    await assert.rejects(
      applyAnchoredEditsFile(join(t.dir, "missing.txt"), [
        { set_line: { anchor: `1:${hashLine("")}`, new_text: "x" } },
      ]),
      (err: unknown) =>
        err instanceof FileEditError &&
        (err as FileEditError).code === "not_found",
    );
  } finally {
    await t.cleanup();
  }
});

test("非 UTF-8 文件 → not_utf8", async () => {
  const t = await makeTmp(CONTENT);
  try {
    const binPath = join(t.dir, "binary.bin");
    await writeFile(binPath, Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]));
    await assert.rejects(
      readHashlines(binPath),
      (err: unknown) =>
        err instanceof FileEditError &&
        (err as FileEditError).code === "not_utf8",
    );
    await assert.rejects(
      applyAnchoredEditsFile(binPath, [
        { set_line: { anchor: `1:${hashLine("")}`, new_text: "x" } },
      ]),
      (err: unknown) =>
        err instanceof FileEditError &&
        (err as FileEditError).code === "not_utf8",
    );
  } finally {
    await t.cleanup();
  }
});

test("原子写：权限位保留，目录无临时文件残留", async () => {
  const t = await makeTmp(CONTENT);
  try {
    await chmod(t.path, 0o604);
    await applyAnchoredEditsFile(t.path, [
      { set_line: { anchor: anchorAt(CONTENT, 2), new_text: "BETA2" } },
    ]);
    const mode = (await stat(t.path)).mode & 0o7777;
    assert.equal(mode, 0o604);
    const entries = await listDir(t.dir);
    assert.deepEqual(entries, ["sample.txt"]);
  } finally {
    await t.cleanup();
  }
});

test("相对路径按 root 解析", async () => {
  const t = await makeTmp(CONTENT);
  try {
    const res = await applyAnchoredEditsFile(
      "sample.txt",
      [{ set_line: { anchor: anchorAt(CONTENT, 1), new_text: "A1" } }],
      t.dir,
    );
    assert.equal(res.path, t.path);
    assert.equal((await readFile(t.path, "utf8")).startsWith("A1\n"), true);
  } finally {
    await t.cleanup();
  }
});

test("readHashlines：offset/limit 窗口（1 基）", async () => {
  const t = await makeTmp(CONTENT);
  try {
    const win = await readHashlines(t.path, undefined, 2, 2);
    assert.equal(win.line_count, 5);
    assert.equal(win.hashlines.length, 2);
    assert.deepEqual(
      win.hashlines.map((r) => r.line),
      [2, 3],
    );
    // 超出窗口的 offset 返回空列表（不报错）
    const over = await readHashlines(t.path, undefined, 9, 3);
    assert.equal(over.hashlines.length, 0);
  } finally {
    await t.cleanup();
  }
});

test("CRLF 文件编辑后仍为 CRLF", async () => {
  const crlf = "abc\r\ndef\r\n";
  const t = await makeTmp(crlf);
  try {
    await applyAnchoredEditsFile(t.path, [
      { set_line: { anchor: anchorAt(crlf, 2), new_text: "DEF" } },
    ]);
    assert.equal(await readFile(t.path, "utf8"), "abc\r\nDEF\r\n");
  } finally {
    await t.cleanup();
  }
});

test("空文件编辑：set 唯一空行 / delete 后仍为空", async () => {
  const t = await makeTmp("");
  try {
    const emptyAnchor = `1:${hashLine("")}`;
    const res1 = await applyAnchoredEditsFile(t.path, [
      { set_line: { anchor: emptyAnchor, new_text: "born" } },
    ]);
    assert.equal(res1.content, "born");

    const res2 = await applyAnchoredEditsFile(t.path, [
      { delete_line: { anchor: `1:${hashLine("born")}` } },
    ]);
    assert.equal(res2.content, "");
    assert.equal(await readFile(t.path, "utf8"), "");
  } finally {
    await t.cleanup();
  }
});
