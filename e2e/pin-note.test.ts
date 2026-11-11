import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("pin_note 登记后能在 note_list 与服务面 pinNotes 里读到", async (t) => {
  const host = await bootPackage("pin-note", {
    extraPackages: ["memory-base", "session-paths"],
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-pin-note");
  t.after(async () => agent.dispose());

  const content = "端到端保持项：这一条在压缩之后依然要出现在上下文里。";
  const added = await host.callTool(
    "pin_note",
    { content, title: "e2e" },
    { agent: agent.agent },
  );
  assert.equal(added.isError, false, textOf(added));

  const listed = await host.callTool("note_list", {}, { agent: agent.agent });
  assert.equal(listed.isError, false, textOf(listed));
  assert.match(textOf(listed), /端到端保持项/);

  const notes = host.ctx.get("pinNotes") as {
    summary(sessionId: string): Promise<{
      count: number;
      chars: number;
      titles: readonly string[];
    }>;
  };
  const summary = await notes.summary("e2e-pin-note");
  assert.equal(summary.count, 1);
  assert.equal(summary.chars, content.length);
  assert.deepEqual(summary.titles, ["e2e"]);
});
