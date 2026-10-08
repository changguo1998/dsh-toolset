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
  promoteCandidates,
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
