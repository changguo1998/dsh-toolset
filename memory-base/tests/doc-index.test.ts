/**
 * 文档索引测试（设计 §7.2 / §12 #12，决策 D44-D48）：
 * P / U 建表且 S 不建、扫描切节入库、判变跳过、missing 三态、读失败保留旧行。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTierDatabase } from "../src/schema.ts";
import { scanDocs } from "../src/doc-index.ts";
import { KnowledgeService } from "../src/knowledge.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kb-docidx-"));
}

async function listTables(
  db: Parameters<typeof scanDocs>[0],
): Promise<string[]> {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '*fts*'",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

test("建表：P / U 库有 doc_index，S 库没有；open 幂等", async () => {
  const session = await openTierDatabase(":memory:", "session");
  const project = await openTierDatabase(":memory:", "project");
  const user = await openTierDatabase(":memory:", "user");
  try {
    assert.ok(!(await listTables(session)).includes("doc_index"));
    for (const db of [project, user]) {
      assert.ok((await listTables(db)).includes("doc_index"));
      assert.ok(
        (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'doc_index_fts'",
            )
            .all() as unknown[]
        ).length === 1,
      );
    }
  } finally {
    session.close();
    project.close();
    user.close();
  }
});

test("扫描：切节入库（标题 / 行范围 / 摘要行 / 文件 hash），重扫跳过未变", async () => {
  const dir = await makeTempDir();
  const db = await openTierDatabase(":memory:", "project");
  try {
    await writeFile(
      join(dir, "guide.md"),
      [
        "# 指南",
        "",
        "指南首段摘要行。",
        "",
        "## 构建",
        "",
        "构建命令是 npm run build。",
        "",
        "## 测试",
        "",
        "- 列表行也算摘要",
      ].join("\n"),
      "utf8",
    );
    const first = await scanDocs(db, {
      include: ["**/*.md"],
      root: dir,
      project: "proj-a",
    });
    assert.equal(first.scanned, 1);
    assert.equal(first.changed, 1);
    assert.equal(first.unchanged, 0);
    const rows = db
      .prepare(
        "SELECT section_title, line_start, line_end, summary, project, status FROM doc_index ORDER BY line_start",
      )
      .all() as Array<{
      section_title: string;
      line_start: number;
      line_end: number;
      summary: string | null;
      project: string;
      status: string;
    }>;
    // 三节：# 指南（含子节到文末）、## 构建、## 测试。
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.section_title),
      ["指南", "构建", "测试"],
    );
    assert.equal(rows[0]?.summary, "指南首段摘要行。");
    assert.equal(rows[1]?.summary, "构建命令是 npm run build。");
    assert.equal(rows[2]?.summary, "列表行也算摘要");
    assert.ok(rows.every((row) => row.project === "proj-a"));
    assert.ok(rows.every((row) => row.status === "present"));

    // 重扫：mtime/size/hash 均未变 → unchanged，行数不变。
    const second = await scanDocs(db, {
      include: ["**/*.md"],
      root: dir,
      project: "proj-a",
    });
    assert.equal(second.unchanged, 1);
    assert.equal(second.changed, 0);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM doc_index").get() as { n: number })
        .n,
      3,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("判变：内容变化重建行；文件消失标 missing；文件回来恢复 present", async () => {
  const dir = await makeTempDir();
  const db = await openTierDatabase(":memory:", "project");
  const file = join(dir, "notes.md");
  try {
    await writeFile(file, "# 笔记\n\n第一版正文。\n", "utf8");
    await scanDocs(db, { include: ["**/*.md"], root: dir });
    assert.equal(
      (
        db
          .prepare("SELECT summary FROM doc_index WHERE line_start = 1")
          .get() as { summary: string }
      ).summary,
      "第一版正文。",
    );

    await writeFile(file, "# 笔记\n\n第二版正文。\n", "utf8");
    const changed = await scanDocs(db, { include: ["**/*.md"], root: dir });
    assert.equal(changed.changed, 1);
    assert.equal(
      (
        db
          .prepare("SELECT summary FROM doc_index WHERE line_start = 1")
          .get() as { summary: string }
      ).summary,
      "第二版正文。",
    );

    await rm(file);
    const gone = await scanDocs(db, { include: ["**/*.md"], root: dir });
    assert.equal(gone.missing, 1);
    assert.equal(gone.changed, 0);
    assert.deepEqual(
      (
        db.prepare("SELECT DISTINCT status FROM doc_index").all() as Array<{
          status: string;
        }>
      ).map((row) => row.status),
      ["missing"],
    );

    // 回归默认过滤 missing 的前提：行还在（不自动删）。
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM doc_index").get() as { n: number })
        .n,
      1,
    );

    await writeFile(file, "# 笔记\n\n第三版正文。\n", "utf8");
    await scanDocs(db, { include: ["**/*.md"], root: dir });
    assert.deepEqual(
      (
        db.prepare("SELECT DISTINCT status FROM doc_index").all() as Array<{
          status: string;
        }>
      ).map((row) => row.status),
      ["present"],
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("读失败保留旧行不标 missing；空 include 不扫描", async () => {
  const dir = await makeTempDir();
  const db = await openTierDatabase(":memory:", "user");
  try {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "ok.md"), "# 正常\n\n内容。\n", "utf8");
    // 一个目录型路径让 stat 成功但 readFile 失败 → errors 记录、旧行保留。
    await writeFile(join(dir, "ok.md"), "# 顶层\n\n顶层内容。\n", "utf8");
    const first = await scanDocs(db, {
      include: ["**/*.md"],
      root: dir,
      project: "",
    });
    assert.equal(first.errors.length, 0);
    assert.equal(first.changed, 2);

    // 文件变成目录（readFile 报 EISDIR）→ errors，不标 missing。
    await rm(join(dir, "ok.md"));
    await mkdir(join(dir, "ok.md"));
    const broken = await scanDocs(db, {
      include: ["**/*.md"],
      root: dir,
      project: "",
    });
    assert.equal(broken.errors.length, 1);
    assert.equal(broken.missing, 0);
    assert.equal(
      (
        db
          .prepare("SELECT status FROM doc_index WHERE doc_ref LIKE '%/ok.md'")
          .get() as { status: string }
      ).status,
      "present",
    );

    // 空 include = 不扫描：不动现有行、也不产生 missing。
    const none = await scanDocs(db, { include: [], root: dir });
    assert.equal(none.scanned, 0);
    assert.equal(none.missing, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("检索并集：doc 命中带回指；kind: doc 独查；missing 被过滤；与分类命中共存", async () => {
  const dir = await makeTempDir();
  const db = await openTierDatabase(":memory:", "project");
  try {
    await writeFile(
      join(dir, "guide.md"),
      [
        "# 指南",
        "",
        "构建命令是 npm run build。",
        "",
        "## 部署",
        "",
        "部署用 docker。",
      ].join("\n"),
      "utf8",
    );
    await scanDocs(db, {
      include: ["**/*.md"],
      root: dir,
      project: "proj-a",
    });
    const kb = new KnowledgeService(db);
    kb.put({
      project: "proj-a",
      content: "记忆里的构建命令 npm run build 备忘",
    });

    // 未给 kind：doc 命中与分类命中共存，doc 命中带回指与摘要行。
    const union = kb.search({ query: "构建", project: "proj-a" });
    const docHits = union.filter((hit) => hit.kind === "doc");
    assert.ok(docHits.length >= 1);
    assert.equal(docHits[0]?.title, "指南");
    assert.equal(docHits[0]?.doc?.ref, join(dir, "guide.md"));
    assert.equal(docHits[0]?.doc?.lineStart, 1);
    assert.ok(union.some((hit) => hit.kind === "default"));

    // kind: "doc" 独查文档索引；kind 给其他值时 doc 不参与。
    const onlyDoc = kb.search({ query: "构建", kind: "doc" });
    assert.ok(onlyDoc.length >= 1);
    assert.ok(onlyDoc.every((hit) => hit.kind === "doc"));
    const onlyDefault = kb.search({ query: "构建", kind: "default" });
    assert.ok(onlyDefault.length >= 1);
    assert.ok(onlyDefault.every((hit) => hit.kind !== "doc"));

    // 文件消失 → missing → 检索默认不返回。
    await rm(join(dir, "guide.md"));
    await scanDocs(db, { include: ["**/*.md"], root: dir, project: "proj-a" });
    const after = kb.search({ query: "构建", kind: "doc" });
    assert.equal(after.length, 0);

    // CJK 短词走 LIKE 兜底同样覆盖 doc_index（部署 两字 porter/trigram 召回受限）。
    await writeFile(join(dir, "ops.md"), "# 运维\n\n部署用 docker。\n", "utf8");
    await scanDocs(db, { include: ["**/*.md"], root: dir, project: "proj-a" });
    const cjk = kb.search({ query: "部署", kind: "doc" });
    assert.equal(cjk.length, 1);
    assert.equal(cjk[0]?.title, "运维");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
