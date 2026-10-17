import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INJECTION_HEADER,
  INJECTION_SUMMARY,
  applyEntry,
  applyExplicit,
  createMemoryPort,
  renderInjection,
  retireEntry,
  sensitiveReason,
  type KindSpec,
  type MemoryFace,
  type PutResult,
  type ScopePutInput,
  type StoreRow,
} from "../src/apply.ts";
import type { LedgerEntry } from "../src/ledger.ts";

interface FakeScopePut {
  kind: string;
  input: ScopePutInput;
}

interface FakeForget {
  kind: string;
  refs: readonly { tier: string; ids: readonly number[] }[];
}

interface FakeMemory {
  face: MemoryFace;
  puts: FakeScopePut[];
  forgets: FakeForget[];
  rows: StoreRow[];
  specs: KindSpec[];
}

function fakeMemory(
  options: {
    memoryPrivacy?: (text: string) => string | null;
  } = {},
): FakeMemory {
  const puts: FakeScopePut[] = [];
  const forgets: FakeForget[] = [];
  const rows: StoreRow[] = [];
  const specs: KindSpec[] = [];
  let nextId = 1;
  const face: MemoryFace = {
    registerKind(spec: KindSpec) {
      specs.push(spec);
      const writable = spec.writableTiers ?? ["session"];
      return {
        kind: spec.kind,
        writableTiers: writable,
        async put(input: ScopePutInput): Promise<PutResult> {
          const tier = input.tier ?? "session";
          if (!writable.includes(tier)) {
            throw new Error(`kind ${spec.kind} 不可写 ${tier} 层`);
          }
          const verdict = await spec.preWrite?.({
            content: input.content,
            project: input.project ?? "",
            kind: spec.kind,
            ...(input.title === undefined ? {} : { title: input.title }),
          });
          if (verdict !== undefined && !verdict.accept) {
            return {
              ids: [],
              sourceId: 0,
              created: 0,
              skipped: { reason: verdict.reason ?? "hook" },
            };
          }
          const id = nextId++;
          puts.push({ kind: spec.kind, input });
          rows.push({
            id,
            kind: spec.kind,
            tier,
            project: input.project ?? "",
            title: input.title ?? null,
            content: input.content,
            importance: input.importance ?? 3,
            sessionId: input.sessionId ?? null,
            createdAt: 0,
          });
          return { ids: [id], sourceId: 1, created: 1 };
        },
        async forget(refs) {
          forgets.push({ kind: spec.kind, refs });
          return refs.reduce((total, ref) => total + ref.ids.length, 0);
        },
      };
    },
    checkPrivacy(text: string) {
      return options.memoryPrivacy?.(text) ?? null;
    },
    async list() {
      return [...rows];
    },
  };
  return { face, puts, forgets, rows, specs };
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "pref_x",
    key: "不要用emoji",
    text: "不要用 emoji",
    status: "active",
    evidence: 3,
    sessions: ["s1", "s2"],
    origin: "user",
    project: "/p",
    importance: 4,
    firstSeen: 0,
    lastSeen: 0,
    ...overrides,
  };
}

test("createMemoryPort：旧形态（registerKind 不返回句柄）明确失败", () => {
  const old = {
    registerKind: () => ({ kind: "preference", table: "kind_preference" }),
    checkPrivacy: () => null,
  };
  const result = createMemoryPort(old);
  assert.equal(result.ok, false);
  assert.ok(
    result.ok === false && result.reason.includes("作用域句柄"),
    "失败原因应点明缺句柄面",
  );
  assert.equal(createMemoryPort(undefined).ok, false);
  assert.equal(createMemoryPort({}).ok, false);
});

test("createMemoryPort：注册两个 kind，写入层能力与注册值一致", () => {
  const memory = fakeMemory();
  const result = createMemoryPort(memory.face);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    memory.specs.map((spec) => [spec.kind, spec.writableTiers]),
    [
      ["preference", ["project"]],
      ["preference_user", ["user"]],
    ],
  );
  assert.equal(result.port.induction.kind, "preference");
  assert.equal(result.port.explicit.kind, "preference_user");
  assert.deepEqual(result.port.induction.writableTiers, ["project"]);
  assert.deepEqual(result.port.explicit.writableTiers, ["user"]);
});

test("隐私双闸：自有敏感模式 + memory-base 闸 + preWrite 纵深", async () => {
  assert.equal(sensitiveReason("改一下 .ssh/config"), "疑似私钥目录");
  assert.equal(sensitiveReason("把 id_rsa 拷走"), "疑似私钥文件名");
  assert.equal(sensitiveReason("读 .env 文件"), "疑似凭据文件");
  assert.equal(sensitiveReason("token 是 sk-abcdefgh1234"), "疑似凭据形态");
  assert.equal(
    sensitiveReason("别动 /home/guochang/foo"),
    "疑似家目录绝对路径",
  );
  assert.equal(sensitiveReason("不要用 emoji"), null);

  const memory = fakeMemory({ memoryPrivacy: () => "内置闸命中" });
  const port = createMemoryPort(memory.face);
  assert.equal(port.ok, true);
  if (!port.ok) return;
  assert.equal(port.port.checkPrivacy("普通偏好"), "内置闸命中");
  // preWrite 纵深：即使绕过 applyEntry 的预检，句柄写入也会被拒
  const result = await port.port.induction.put({
    content: "不要用 emoji",
    tier: "project",
  });
  assert.equal(result.ids.length, 0);
  assert.equal(result.skipped?.reason, "内置闸命中");
});

test("applyEntry：写项目层、带 sessionId 与 importance，带上限内的隐私预检", async () => {
  const memory = fakeMemory();
  const port = createMemoryPort(memory.face);
  assert.equal(port.ok, true);
  if (!port.ok) return;
  const outcome = await applyEntry(port.port, entry());
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ids, [1]);
  assert.equal(memory.puts.length, 1);
  const put = memory.puts[0]!;
  assert.equal(put.kind, "preference");
  assert.equal(put.input.tier, "project");
  assert.equal(put.input.content, "不要用 emoji");
  assert.equal(put.input.importance, 4);
  assert.equal(put.input.project, "/p");
  assert.equal(put.input.sessionId, "s2", "取最近一次证据的会话 id 留痕");
  assert.deepEqual(put.input.source, { kind: "manual" });
});

test("applyEntry 幂等：库内已有同内容副本时复用 id、不重复写行", async () => {
  const memory = fakeMemory();
  const port = createMemoryPort(memory.face);
  assert.equal(port.ok, true);
  if (!port.ok) return;
  await applyEntry(port.port, entry());
  const again = await applyEntry(port.port, entry());
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
  assert.equal(memory.puts.length, 1);
});

test("applyEntry：敏感内容与层越权都不落库", async () => {
  const memory = fakeMemory();
  const port = createMemoryPort(memory.face);
  assert.equal(port.ok, true);
  if (!port.ok) return;
  const blocked = await applyEntry(
    port.port,
    entry({ text: "别看 .ssh/id_rsa" }),
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "疑似私钥目录");
  assert.equal(memory.puts.length, 0);
});

test("retireEntry：按副本引用真删；无副本 no-op", async () => {
  const memory = fakeMemory();
  const port = createMemoryPort(memory.face);
  assert.equal(port.ok, true);
  if (!port.ok) return;
  const applied = await applyEntry(port.port, entry());
  const id = applied.ids[0]!;
  const target = entry({
    memory: { scope: "induction", tier: "project", id },
  });
  const removed = await retireEntry(port.port, target);
  assert.deepEqual(removed, { ok: true, removed: 1 });
  assert.deepEqual(memory.forgets, [
    { kind: "preference", refs: [{ tier: "project", ids: [id] }] },
  ]);
  assert.deepEqual(await retireEntry(port.port, entry()), {
    ok: true,
    removed: 0,
  });
});

test("applyExplicit：只写用户层（不带 sessionId）", async () => {
  const memory = fakeMemory();
  const port = createMemoryPort(memory.face);
  assert.equal(port.ok, true);
  if (!port.ok) return;
  const outcome = await applyExplicit(port.port, entry());
  assert.equal(outcome.ok, true);
  const put = memory.puts[0]!;
  assert.equal(put.kind, "preference_user");
  assert.equal(put.input.tier, "user");
  assert.equal(put.input.sessionId, undefined);
});

test("renderInjection：空集返回 null；按重要度排序；条数 / 字符双上限", () => {
  assert.equal(renderInjection([], { maxItems: 5, maxChars: 600 }), null);
  const active = [
    entry({ id: "a", text: "不要用 emoji", importance: 4, lastSeen: 1 }),
    entry({ id: "b", text: "提交信息用中文", importance: 3, lastSeen: 2 }),
  ];
  const rendered = renderInjection(active, { maxItems: 5, maxChars: 600 });
  assert.ok(rendered !== null);
  assert.equal(rendered.items, 2);
  assert.equal(rendered.dropped, 0);
  assert.ok(rendered.text.startsWith(INJECTION_HEADER));
  assert.ok(rendered.text.includes("- 不要用 emoji"));
  assert.ok(rendered.text.includes("- 提交信息用中文"));
  assert.equal(INJECTION_SUMMARY, "用户偏好提醒");

  const many = Array.from({ length: 8 }, (_, index) =>
    entry({
      id: `e${index}`,
      text: `偏好 ${index}`,
      importance: 4 - (index % 2),
    }),
  );
  const capped = renderInjection(many, { maxItems: 3, maxChars: 600 });
  assert.ok(capped !== null);
  assert.equal(capped.items, 3);
  assert.equal(capped.dropped, 5);
  assert.ok(capped.text.includes("另有 5 条偏好未列出。"));

  const tight = renderInjection(many, { maxItems: 8, maxChars: 80 });
  assert.ok(tight !== null);
  assert.ok(tight.text.length <= 80, `实际长度 ${tight.text.length}`);
  assert.ok(tight.dropped > 0);
});

test("renderInjection：首条超长时整体不注入（不截断偏好正文）", () => {
  const long = entry({ text: "不要".padEnd(700, "啊") });
  assert.equal(renderInjection([long], { maxItems: 5, maxChars: 600 }), null);
});
