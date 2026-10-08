/**
 * 提升链数据层测试（设计 §6 / 决策 D49-D54）：
 * 候选表三库齐备、幂等入队（精确 + 子串合并）、rejected 墓碑、闸门、
 * 审阅权限与转换闸、origin 留痕、冲突裁定双路径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openTierDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";
import { fallbackSpec, KindRegistry } from "../src/router.ts";
import {
  approveCandidate,
  editCandidate,
  listCandidates,
  markConflict,
  markSourcesPromoted,
  promoteCandidates,
  promoteProjectToUser,
  promoteSessionToProject,
  pruneCandidates,
  rejectCandidate,
  resolveConflict,
} from "../src/promote.ts";

async function makeHarness(tier: "project" | "user" = "project") {
  const db = await openTierDatabase(":memory:", tier);
  const registry = new KindRegistry();
  registry.register(fallbackSpec(registry.fallbackKind));
  const kb = new KnowledgeService(db, { registry });
  return { db, registry, kb };
}

const noopLlm = async (prompt: string): Promise<string> =>
  `概括：${prompt.slice(-40)}`;

test("候选表：三库都有且幂等；promote 幂等入队（精确合并 projects / sources 并集）", async (t) => {
  for (const tier of ["session", "project", "user"] as const) {
    const db = await openTierDatabase(":memory:", tier);
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'candidates'",
        )
        .all() as unknown[]
    ).length;
    assert.equal(tables, 1, `${tier} 库应有 candidates 表`);
    db.close();
  }

  const { db, registry } = await makeHarness();
  const first = await promoteCandidates(db, registry, [
    {
      targetTier: "project",
      kind: "default",
      content: "本项目用 npm run check 校验",
      sources: ["default:1"],
      projects: ["proj-a"],
    },
  ]);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.status, "queued");
  const id = first[0]?.id ?? 0;

  // 同内容重推：projects / sources 并集，行数不变。
  const second = await promoteCandidates(db, registry, [
    {
      targetTier: "project",
      kind: "default",
      content: "本项目用 npm run check 校验",
      sources: ["default:2"],
      projects: ["proj-b"],
    },
  ]);
  assert.equal(second[0]?.status, "merged");
  const [row] = listCandidates(db, { tier: "project" });
  assert.deepEqual(row?.projects, ["proj-a", "proj-b"]);
  assert.deepEqual(row?.sources, ["default:1", "default:2"]);
  assert.equal(id, row?.id);

  // 子串合并：不同措辞但占比 ≥ 0.8 → 并入同一条（P→U ≥2 判据的前提）。
  const third = await promoteCandidates(db, registry, [
    {
      targetTier: "project",
      kind: "default",
      content: "本项目用 npm run check 校验代码",
      projects: ["proj-c"],
    },
  ]);
  assert.equal(third[0]?.status, "merged");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM candidates").get() as { n: number })
      .n,
    1,
  );
  void t;
});

test("闸门与墓碑：隐私拒收、未注册 kind 拒收；reject 后同 fact_key 重推计 rejected-duplicate", async () => {
  const { db, registry } = await makeHarness();
  const gated = await promoteCandidates(db, registry, [
    {
      targetTier: "project",
      kind: "default",
      content: "password: supersecretvalue",
    },
    { targetTier: "project", kind: "nope", content: "未注册分类" },
  ]);
  assert.equal(gated[0]?.status, "rejected-gate");
  assert.equal(gated[0]?.reason, "pattern");
  assert.equal(gated[1]?.status, "rejected-gate");
  assert.equal(gated[1]?.reason, "kind-unregistered");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM candidates").get() as { n: number })
      .n,
    0,
  );

  const queued = await promoteCandidates(db, registry, [
    { targetTier: "project", kind: "default", content: "待驳回的事实" },
  ]);
  const outcome = queued[0];
  assert.ok(outcome !== undefined && outcome.status === "queued");
  const id = outcome.id;
  const rejected = rejectCandidate(db, id, {
    reviewer: "agent",
    reason: "不够格",
  });
  assert.ok(rejected.ok);
  assert.deepEqual(listCandidates(db, { tier: "project" }), []);

  const again = await promoteCandidates(db, registry, [
    { targetTier: "project", kind: "default", content: "待驳回的事实" },
  ]);
  assert.equal(again[0]?.status, "rejected-duplicate");
});

test("approve：U 候选 agent 无效；无 caller 未概括拒转换；有 caller 落正式行并留痕", async () => {
  const { db, registry, kb } = await makeHarness("user");
  const queued = await promoteCandidates(db, registry, [
    {
      targetTier: "user",
      kind: "default",
      content: "回答保持简洁",
      sources: ["kind_note:7"],
      projects: ["proj-a"],
    },
  ]);
  const firstOutcome = queued[0];
  assert.ok(firstOutcome !== undefined && firstOutcome.status === "queued");
  const id = firstOutcome.id;

  // U 候选：agent 的 approve 无效。
  const agentAttempt = await approveCandidate(db, kb, registry, id, {
    reviewer: "agent",
    project: "",
  });
  assert.deepEqual(agentAttempt, { ok: false, reason: "forbidden" });

  // 无 caller 且未概括：转换被拒（失败不提升、不降级），候选保持 pending。
  const noLlm = await approveCandidate(db, kb, registry, id, {
    reviewer: "user",
    project: "",
  });
  assert.deepEqual(noLlm, { ok: false, reason: "llm-unavailable" });
  assert.equal(listCandidates(db, { tier: "user" }).length, 1);

  // 带 caller：概括 → 落正式行 + 留痕 + 候选删除。
  const approved = await approveCandidate(db, kb, registry, id, {
    reviewer: "user",
    project: "",
    llm: noopLlm,
  });
  assert.ok(approved.ok);
  const hit = kb.search({ query: "回答保持简洁", kind: "default" });
  assert.equal(hit.length, 1);
  const formal = db
    .prepare(
      "SELECT promoted_from, reviewer, projects, origin FROM chunks WHERE id = ?",
    )
    .get(approved.id) as {
    promoted_from: string;
    reviewer: string;
    projects: string;
    origin: string;
  };
  assert.equal(formal.reviewer, "user");
  assert.equal(formal.origin, "auto");
  assert.deepEqual(JSON.parse(formal.projects), ["proj-a"]);
  assert.deepEqual(JSON.parse(formal.promoted_from), ["kind_note:7"]);
  assert.equal(listCandidates(db, { tier: "user" }).length, 0);
});

test("edit：重算 fact_key；撞行并入；markConflict + resolveConflict 双路径（user-only）", async () => {
  const { db, registry, kb } = await makeHarness("project");
  const queued = await promoteCandidates(db, registry, [
    {
      targetTier: "project",
      kind: "default",
      content: "原始结论甲",
      sources: ["default:1"],
    },
  ]);
  const firstOutcome = queued[0];
  assert.ok(firstOutcome !== undefined && firstOutcome.status === "queued");
  const id = firstOutcome.id;

  const edited = editCandidate(db, id, "修正后的结论乙");
  assert.ok(edited.ok);
  const [row] = listCandidates(db, { tier: "project" });
  assert.equal(row?.content, "修正后的结论乙");

  // 标记冲突 → agent 裁定无效 → user accept-new 更新目标行 + 候选删除。
  kb.put({ project: "proj-a", content: "既有矛盾结论" });
  const marked = markConflict(db, id, {
    conflictWith: { kind: "default", id: 1 },
  });
  assert.ok(marked.ok);
  const agentResolve = await resolveConflict(
    db,
    kb,
    registry,
    id,
    "accept-new",
    { reviewer: "agent" },
  );
  assert.deepEqual(agentResolve, { ok: false, reason: "forbidden" });
  const resolved = await resolveConflict(db, kb, registry, id, "accept-new", {
    reviewer: "user",
  });
  assert.ok(resolved.ok);
  const target = db
    .prepare("SELECT content FROM chunks WHERE id = 1")
    .get() as { content: string };
  assert.equal(target.content, "修正后的结论乙");
  assert.equal(listCandidates(db, { tier: "project" }).length, 0);

  // keep-old：候选删除、目标行不动。
  const queued2 = await promoteCandidates(db, registry, [
    { targetTier: "project", kind: "default", content: "另一个新结论" },
  ]);
  const outcome2 = queued2[0];
  assert.ok(outcome2 !== undefined && outcome2.status === "queued");
  const id2 = outcome2.id;
  markConflict(db, id2, { conflictWith: { kind: "default", id: 1 } });
  const kept = await resolveConflict(db, kb, registry, id2, "keep-old", {
    reviewer: "user",
  });
  assert.ok(kept.ok);
  assert.equal(
    (
      db.prepare("SELECT content FROM chunks WHERE id = 1").get() as {
        content: string;
      }
    ).content,
    "修正后的结论乙",
  );
  assert.equal(listCandidates(db, { tier: "project" }).length, 0);
});

test("origin 留痕：kb.put 显式 origin user 落列；缺省 auto", async () => {
  const { db, kb } = await makeHarness();
  kb.put({ project: "p", content: "用户指令内容" });
  kb.put({ project: "p", content: "自动内容", origin: "user" });
  const rows = db
    .prepare("SELECT origin FROM chunks ORDER BY id")
    .all() as Array<{ origin: string }>;
  assert.deepEqual(
    rows.map((row) => row.origin),
    ["auto", "user"],
  );
});

test("S→P / P→U 生产：判据过滤、跨库写目标库、跨项目累积、来源标记、容量兜底", async () => {
  const sDb = await openTierDatabase(":memory:", "session");
  const pDb = await openTierDatabase(":memory:", "project");
  const uDb = await openTierDatabase(":memory:", "user");
  const registry = new KindRegistry();
  registry.register(fallbackSpec(registry.fallbackKind));
  const sKb = new KnowledgeService(sDb, { registry });
  try {
    // S 库三行：命中过（A）、决策类（B）、都不沾（C）。
    sKb.put({ project: "p", content: "被检索命中的要点", sessionId: "s1" });
    sKb.put({
      project: "p",
      content: "决策类要点",
      sessionId: "s1",
      category: "plan/mode",
    });
    sKb.put({ project: "p", content: "普通流水行", sessionId: "s1" });
    // 回拨 created_at 保证「命中过」（touch 用同一毫秒的 now，严格大于不成立）。
    sDb
      .prepare("UPDATE chunks SET created_at = created_at - 1000 WHERE id = 1")
      .run();
    sKb.touch(1);
    const sStats = await promoteSessionToProject(sDb, pDb, registry, {
      sessionId: "s1",
      limit: 20,
    });
    assert.equal(sStats.queued, 2);
    assert.equal(
      (
        pDb.prepare("SELECT COUNT(*) AS n FROM candidates").get() as {
          n: number;
        }
      ).n,
      2,
    );

    // P→U：两个不同 P 库各推一票，U 候选行 projects 累积到 2（≥2 = 跨项目事实）。
    const pKb = new KnowledgeService(pDb, { registry });
    pKb.put({ project: "proj-a", content: "跨项目成立的事实" });
    const uStats1 = await promoteProjectToUser(pDb, uDb, registry, {
      project: "proj-a",
    });
    assert.equal(uStats1.queued, 1);
    const pDb2 = await openTierDatabase(":memory:", "project");
    const pKb2 = new KnowledgeService(pDb2, { registry });
    pKb2.put({ project: "proj-b", content: "跨项目成立的事实" });
    const uStats2 = await promoteProjectToUser(pDb2, uDb, registry, {
      project: "proj-b",
    });
    assert.equal(uStats2.merged, 1);
    const [uRow] = listCandidates(uDb, { tier: "user" });
    assert.deepEqual(uRow?.projects, ["proj-a", "proj-b"]);
    pDb2.close();

    // 来源标记：session:default:1 → S 库该行 promoted_to 写入。
    const marked = markSourcesPromoted(
      {
        get: (tier: "session" | "project" | "user") =>
          tier === "session" ? { db: sDb } : undefined,
      },
      ["session:default:1"],
      { kind: "default", id: 9 },
      registry,
    );
    assert.equal(marked, 1);
    const promotedTo = sDb
      .prepare("SELECT promoted_to FROM chunks WHERE id = 1")
      .get() as { promoted_to: string };
    assert.deepEqual(JSON.parse(promotedTo.promoted_to), {
      kind: "default",
      id: 9,
    });

    // 容量兜底：超限清最旧。
    for (let i = 0; i < 30; i += 1) {
      uDb
        .prepare(
          "INSERT INTO candidates (target_tier, kind, fact_key, content_hash, content, created_at, updated_at) VALUES ('user', 'default', ?, ?, ?, ?, ?)",
        )
        .run(`fk-${i}`, `h-${i}`, "x".repeat(4096), 1000 + i, 1000 + i);
    }
    const pruned = pruneCandidates(uDb, 64 * 1024);
    assert.ok(pruned > 0);
  } finally {
    sDb.close();
    pDb.close();
    uDb.close();
  }
});

test("merge 后 summarized 重算（D63-a 回归）：已概括锚行被重推合并不回退原文落上层", async () => {
  const { db, registry, kb } = await makeHarness("project");
  // 首推（带 caller）：概括落行。
  await promoteCandidates(
    db,
    registry,
    [{ targetTier: "project", kind: "default", content: "原始素材内容甲" }],
    { llm: async () => "概括结论甲" },
  );
  const [row1] = listCandidates(db, { tier: "project" });
  assert.equal(row1?.summarized, true);
  // 同源重推（无 caller）：合并 → summarized 重算为 0（不沿用旧标志），内容 = 推送原文。
  const merged = await promoteCandidates(
    db,
    registry,
    [{ targetTier: "project", kind: "default", content: "原始素材内容甲" }],
    {},
  );
  assert.equal(merged[0]?.status, "merged");
  const [row2] = listCandidates(db, { tier: "project" });
  assert.equal(row2?.summarized, false);
  // 有 caller 再推：重概括成功 → summarized 回到 1。
  await promoteCandidates(
    db,
    registry,
    [{ targetTier: "project", kind: "default", content: "原始素材内容甲" }],
    { llm: async () => "重新概括结论" },
  );
  const [row3] = listCandidates(db, { tier: "project" });
  assert.equal(row3?.summarized, true);
  assert.equal(row3?.content, "重新概括结论");
  void kb;
});
