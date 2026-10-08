/**
 * 存量回扫测试（设计 §5 / §10）：默认只报告、`apply` 才删、自定义模式叠加、报告不回显内容。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openKnowledgeDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";
import { compileRules } from "../src/rules.ts";

type Db = Awaited<ReturnType<typeof openKnowledgeDatabase>>;

/** 直接写表（不过库核心闸门）——模拟闸门上线前就已存在的存量行。 */
function seed(
  db: Db,
  content: string,
  category: string,
  project = "default",
): void {
  const hash = createHash("sha256").update(content).digest("hex");
  const sourceId = Number(
    db
      .prepare(
        "INSERT INTO sources (kind, label, content_hash, chunk_count, created_at) VALUES ('manual', 'seed', ?, 1, ?)",
      )
      .run(hash, Date.now()).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO chunks (source_id, project, category, content, content_hash, importance, last_referenced, created_at) VALUES (?, ?, ?, ?, ?, 3, 0, ?)",
  ).run(sourceId, project, category, content, hash, Date.now());
}

test("rescanDenied：默认只报告（条数 + 分类），不删数据、不回显正文", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    seed(db, "token = abcdef123456", "tool/result");
    seed(db, "sk-abcdefghijklmnopqrst", "tool/result");
    seed(db, "本项目用 npm run check", "convention");
    const kb = new KnowledgeService(db);

    const report = kb.rescanDenied();
    assert.equal(report.scanned, 3);
    assert.equal(report.matched, 2);
    assert.equal(report.applied, false);
    assert.equal(report.removed, 0);
    assert.deepEqual(report.byCategory, { "tool/result": 2 });
    // 报告只给模式源串与元数据，不含正文。
    for (const hit of report.hits) {
      assert.equal("content" in hit, false);
      assert.ok(hit.pattern.length > 0);
    }
    // 未 apply：行仍在。
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n,
      3,
    );
  } finally {
    db.close();
  }
});

test("rescanDenied：apply 才删，且联动清理 sources", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    seed(db, "password = hunter2000", "tool/result");
    seed(db, "无关内容", "note");
    const kb = new KnowledgeService(db);

    const report = kb.rescanDenied({ apply: true });
    assert.equal(report.applied, true);
    assert.equal(report.removed, 1);
    const left = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {
      n: number;
    };
    assert.equal(left.n, 1);
    const sources = db.prepare("SELECT COUNT(*) AS n FROM sources").get() as {
      n: number;
    };
    assert.equal(sources.n, 1, "归零的 source 应被清理");
  } finally {
    db.close();
  }
});

test("rescanDenied：自定义模式叠加生效，project 可收窄", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    seed(db, "内部代号 ZEBRA-42", "note", "proj-a");
    seed(db, "内部代号 ZEBRA-77", "note", "proj-b");
    const rules = compileRules({ denyPatterns: ["ZEBRA-\\d+"] }, null);
    const kb = new KnowledgeService(db);

    const scoped = kb.rescanDenied({ project: "proj-a", rules });
    assert.equal(scoped.matched, 1);
    assert.equal(scoped.hits[0]?.project, "proj-a");
    assert.equal(scoped.hits[0]?.pattern, "ZEBRA-\\d+");

    const all = kb.rescanDenied({ rules });
    assert.equal(all.matched, 2);
  } finally {
    db.close();
  }
});

test("库核心闸门（设计 §5）：绕过 hooks 直接 put 凭据形态被拒，不写库", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    const kb = new KnowledgeService(db);
    const result = kb.put({
      content: "api_key = abcdef1234567890",
      project: "default",
      source: { kind: "manual" },
    });
    assert.deepEqual(result.ids, []);
    assert.equal(result.created, 0);
    assert.equal(result.skipped, "pattern");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n,
      0,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number })
        .n,
      0,
    );
  } finally {
    db.close();
  }
});
