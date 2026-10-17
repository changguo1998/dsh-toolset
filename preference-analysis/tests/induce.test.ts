import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MARKERS,
  CORRECTION_WEIGHT,
  DAY_MS,
  entryId,
  evaluate,
  extractConstraint,
  findEntry,
  hasCorrectionMarker,
  isSuppressed,
  mergeEvidence,
  normalizeKey,
  similarityOf,
  splitSentences,
  trigramJaccard,
  trigrams,
  type EvidenceInput,
} from "../src/induce.ts";
import { addSuppressed, emptyLedger, type LedgerFile } from "../src/ledger.ts";

const THRESHOLDS = { evidence: 3, sessions: 2, recentDays: 30 };

function evidence(
  text: string,
  sessionId: string,
  at: number,
  overrides: Partial<EvidenceInput> = {},
): EvidenceInput {
  return {
    text,
    weight: 1,
    sessionId,
    at,
    origin: "user",
    project: "/p",
    ...overrides,
  };
}

function replay(
  ledger: LedgerFile,
  texts: Array<[string, string]>,
  start = 1_000,
  gap = DAY_MS,
): void {
  texts.forEach(([text, sessionId], index) => {
    mergeEvidence(ledger, evidence(text, sessionId, start + index * gap));
  });
}

test("splitSentences：按句末标点与换行切句，去列表前缀与空串", () => {
  assert.deepEqual(splitSentences("第一句。第二句！第三句？\n第四句；第五句"), [
    "第一句",
    "第二句",
    "第三句",
    "第四句",
    "第五句",
  ]);
  assert.deepEqual(splitSentences("- 不要用 emoji\n- 记住用全角标点"), [
    "不要用 emoji",
    "记住用全角标点",
  ]);
  assert.deepEqual(splitSentences("   "), []);
});

test("extractConstraint：取承载标记的最短句；超长句与无标记句不算", () => {
  const text =
    "这个表看起来还行。以后不要用 emoji，请记住这一点。统一用英文标点。";
  // 多句都带标记时取最短句（设计口径：一条消息最多产出一条证据）
  assert.equal(extractConstraint(text), "统一用英文标点");
  assert.equal(
    extractConstraint("统一用英文标点，这也是必须的。不要用 emoji。"),
    "不要用 emoji",
  );
  // 标记在，但句长超过上限 -> null
  const long = `不要${"很".repeat(130)}`;
  assert.equal(extractConstraint(long), null);
  // 无标记 -> null
  assert.equal(extractConstraint("把这段代码格式化一下"), null);
  // 自定义标记与上限
  assert.equal(extractConstraint("请用 tab 缩进", ["请用"]), "请用 tab 缩进");
  assert.equal(
    extractConstraint("请用 tab 缩进", ["请用"], 3),
    null,
    "上限按字（码点）算",
  );
  assert.equal(DEFAULT_MARKERS.length, 12);
});

test("hasCorrectionMarker：纠正词命中（S2）", () => {
  assert.equal(hasCorrectionMarker("不对，我说的是不要用 emoji"), true);
  assert.equal(hasCorrectionMarker("把这段代码格式化一下"), false);
  assert.equal(CORRECTION_WEIGHT, 1.5);
});

test("normalizeKey：去空白与标点、大小写折叠", () => {
  assert.equal(normalizeKey("不要用 Emoji！"), "不要用emoji");
  assert.equal(normalizeKey("  Don't   use ,。； "), "dontuse");
  assert.equal(normalizeKey("不要用 emoji"), normalizeKey("不要用emoji"));
});

test("3-gram：短串整串成 gram，Jaccard 自反 / 无交集 / 近似", () => {
  assert.deepEqual([...trigrams("ab")], ["ab"]);
  assert.deepEqual([...trigrams("")], []);
  assert.equal(trigramJaccard("abc", "abc"), 1);
  assert.equal(trigramJaccard("abc", "xyz"), 0);
  assert.equal(trigramJaccard("", "abc"), 0);
  // 前缀相同时 6/7 ≈ 0.857 >= 0.8
  const base = normalizeKey("不要用 emoji");
  const variant = normalizeKey("不要用emoji啊");
  assert.ok(similarityOf(base, variant) >= 0.8);
  assert.ok(similarityOf(base, normalizeKey("以后别用 emoji 表情")) < 0.8);
});

test("mergeEvidence：同一句与近似措辞合并为一条（验收 1）", () => {
  const ledger = emptyLedger();
  replay(ledger, [
    ["不要用 emoji", "s1"],
    ["不要用 emoji!", "s2"],
    ["不要用emoji啊", "s3"],
  ]);
  assert.equal(ledger.entries.length, 1, "相似措辞应合并到同一条");
  const entry = ledger.entries[0]!;
  assert.equal(entry.evidence, 3);
  assert.deepEqual(entry.sessions, ["s1", "s2", "s3"]);
  assert.equal(entry.status, "observe");
  assert.equal(entry.id, entryId(entry.key));
  // 证据足够且跨 3 会话、最近证据在窗口内 -> 高置信
  const verdict = evaluate(entry, THRESHOLDS, 1_000 + 2 * DAY_MS);
  assert.equal(verdict.tier, "confident");
  assert.equal(verdict.importance, 4);
});

test("低置信不产出（验收 2）：2 次证据或只 1 个会话都停在 observe", () => {
  const two = emptyLedger();
  replay(two, [
    ["不要用 emoji", "s1"],
    ["不要用 emoji", "s2"],
  ]);
  assert.equal(two.entries.length, 1);
  assert.equal(two.entries[0]!.evidence, 2);
  assert.equal(
    evaluate(two.entries[0]!, THRESHOLDS, 3 * DAY_MS).tier,
    "observe",
  );

  const oneSession = emptyLedger();
  replay(oneSession, [
    ["不要用 emoji", "s1"],
    ["不要用 emoji", "s1"],
    ["不要用 emoji", "s1"],
  ]);
  assert.equal(oneSession.entries[0]!.sessions.length, 1);
  assert.equal(
    evaluate(oneSession.entries[0]!, THRESHOLDS, DAY_MS).tier,
    "observe",
  );

  // 证据够但最近一次证据超窗口 -> 候选（不可自动应用）
  const stale = emptyLedger();
  replay(stale, [["不要用 emoji", "s1"]], 1_000);
  mergeEvidence(stale, evidence("不要用 emoji", "s2", 1_000 + DAY_MS));
  mergeEvidence(stale, evidence("不要用 emoji", "s2", 1_000 + 2 * DAY_MS));
  const old = evaluate(stale.entries[0]!, THRESHOLDS, 1_000 + 60 * DAY_MS);
  assert.equal(old.tier, "candidate");
  assert.equal(old.importance, 3);
});

test("加权证据：S2 纠正语境 x1.5 计入 evidence", () => {
  const ledger = emptyLedger();
  mergeEvidence(ledger, evidence("不要用 emoji", "s1", 1_000, { weight: 1.5 }));
  mergeEvidence(ledger, evidence("不要用 emoji", "s2", 2_000, { weight: 1.5 }));
  const entry = ledger.entries[0]!;
  assert.equal(entry.evidence, 3);
  assert.equal(evaluate(entry, THRESHOLDS, 2_000).tier, "confident");
});

test("抑制键：相同或相似一律不再产出（验收 4 的纯函数部分）", () => {
  const ledger = emptyLedger();
  addSuppressed(ledger, normalizeKey("不要用 emoji"));
  assert.equal(isSuppressed(ledger, normalizeKey("不要用 emoji")), true);
  assert.equal(isSuppressed(ledger, normalizeKey("不要用emoji啊")), true);
  assert.equal(isSuppressed(ledger, normalizeKey("提交信息用中文")), false);
  const outcome = mergeEvidence(ledger, evidence("不要用 emoji", "s1", 1_000));
  assert.equal(outcome.kind, "suppressed");
  assert.equal(ledger.entries.length, 0);
});

test("显式 key（S3 指纹）与空 key", () => {
  const ledger = emptyLedger();
  const first = mergeEvidence(
    ledger,
    evidence(
      "不要直接 bash rm; 如确需执行, 先说明影响并取得确认",
      "s1",
      1_000,
      {
        key: "bash:rm",
        origin: "approval",
      },
    ),
  );
  assert.equal(first.kind, "created");
  const second = mergeEvidence(
    ledger,
    evidence(
      "不要直接 bash rm; 如确需执行, 先说明影响并取得确认",
      "s2",
      2_000,
      {
        key: "bash:rm",
        origin: "approval",
      },
    ),
  );
  assert.equal(second.kind, "merged");
  assert.equal(ledger.entries.length, 1);
  assert.equal(findEntry(ledger, "bash:rm")?.evidence, 2);
  // 正文只有标点 -> 归一化 key 为空，不建条目
  const invalid = mergeEvidence(ledger, evidence("，。；", "s1", 3_000));
  assert.equal(invalid.kind, "invalid");
  assert.equal(ledger.entries.length, 1);
});

test("历史恢复：已退休条目不再被相似匹配到（靠 suppressed 兜底）", () => {
  const ledger = emptyLedger();
  mergeEvidence(ledger, evidence("不要用 emoji", "s1", 1_000));
  const entry = ledger.entries[0]!;
  entry.status = "retired";
  assert.equal(findEntry(ledger, entry.key), undefined);
  // 退休时调用方会把 key 记入 suppressed -> 不再重新产出
  addSuppressed(ledger, entry.key);
  assert.equal(
    mergeEvidence(ledger, evidence("不要用 emoji", "s2", 2_000)).kind,
    "suppressed",
  );
});
