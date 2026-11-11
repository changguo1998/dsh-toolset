// tool-consult/tests/revealed-hold.test.ts — 被揭示工具用法的动态保持（T9 / pinNotes.hold）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { assemble } from "./assemble.ts";

/** hold 登记记录。 */
interface HoldRecord {
  key: string;
  provider: (context: { sessionId: string }) => string | undefined;
}

/** 造一个记录 hold 的假 pinNotes 面。 */
function pinNotesFace(holds: HoldRecord[]): {
  hold(key: string, provider: HoldRecord["provider"]): () => void;
} {
  return {
    hold(key, provider) {
      holds.push({ key, provider });
      return () => {};
    },
  };
}

test("revealed-tools hold：未揭示不投，揭示后给出一行用法，同集合同字节", async () => {
  const holds: HoldRecord[] = [];
  const a = assemble({ serviceValues: { pinNotes: pinNotesFace(holds) } });
  a.apply();
  a.addAgent({ id: "s1" });

  assert.equal(holds.length, 1);
  assert.equal(holds[0]!.key, "revealed-tools");
  assert.equal(holds[0]!.provider({ sessionId: "s1" }), undefined);

  await a.execute({ names: ["rule_add"] });
  const text = holds[0]!.provider({ sessionId: "s1" });
  assert.ok(text !== undefined);
  assert.match(text, /已揭示工具/);
  assert.match(text, /rule_add/);
  assert.equal(
    holds[0]!.provider({ sessionId: "s1" }),
    text,
    "集合不变时文本同字节",
  );

  await a.execute({ names: ["session_channel"] });
  const two = holds[0]!.provider({ sessionId: "s1" });
  assert.ok(two !== undefined);
  assert.match(two, /session_channel/);
  assert.notEqual(two, text, "集合变化后文本变化");
  a.dispose();
});

test("revealed-tools hold：pinNotes 缺席时只告警，揭示与遮罩照常", async () => {
  const a = assemble();
  a.apply();
  a.addAgent({ id: "s2" });
  await a.execute({ names: ["rule_add"] });
  assert.ok(
    a.logs().some((line) => line.includes("ctx.pinNotes 不可用")),
    "应告警一次",
  );
  a.dispose();
});
