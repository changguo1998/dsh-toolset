// tests/p5-blank-chunk.test.ts — P5：宿主补发的空白文本块被丢弃
//
// 回归点：宿主每个 step 末尾会补发一个只有换行的文本块（实测 190 个文本分片里
// 154 个就是 "\n\n"）。若不丢，会在思考/工具行之后留下成片空行。
// 判据：整段仅空白 **且** 末项来源与本分片不同（或尚无内容）→ 丢；同来源内部的空白分片保留
// （软换行与段落空行语义不变）。
//
// 条目 16 段 C2：内容不再有缓冲行形态，该规则随之从 state 侧（`appendStream`）搬进
// **交付入口**（`App.ingestDelivery`），故本文件改为经 App 的 sink 投交付、断言节缓存。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";

/** App + sink 直投（与生产同路径：main.ts 亦注册 pipelineSink） */
function makeApp(): {
  app: App;
  deliver: (d: BlockDelivery) => void;
  dump: () => string;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const sink: { current?: (delivery: BlockDelivery) => void } = {};
  const app = new App({
    renderer,
    adapter,
    notify: { enabled: false },
    pipelineSink: sink,
  });
  app.start();
  const dump = (): string =>
    JSON.stringify((app as unknown as { sections: unknown }).sections ?? null);
  return { app, deliver: (d) => sink.current?.(d), dump };
}

const text = (
  t: string,
  source: "assistant" | "reasoning" = "assistant",
): BlockDelivery => ({
  kind: "text",
  turn: 1,
  step: 1,
  index: 0,
  source,
  text: t,
});

test("P5：尚无内容时的空白分片被丢弃", () => {
  const { app, deliver, dump } = makeApp();
  deliver(text("\n\n"));
  assert.ok(
    !dump().includes("\\n\\n"),
    "空节 + 空白分片 → 不产生条目: " + dump().slice(0, 200),
  );
  app.dispose();
});

test("P5：异来源之间的空白分片被丢弃（思考 → 空白 → 思考）", () => {
  const { app, deliver, dump } = makeApp();
  deliver(text("先看文档", "reasoning"));
  deliver(text("\n\n")); // 与末项异来源 → 丢
  deliver(text("再改链接", "reasoning"));
  const d = dump();
  assert.ok(!d.includes("\\n\\n"), "空白分片不应进节: " + d.slice(0, 300));
  assert.ok(d.includes("先看文档") && d.includes("再改链接"), "两段思考都在");
  app.dispose();
});

test("P5：工具行之后的空白分片被丢弃", () => {
  const { app, deliver, dump } = makeApp();
  deliver({
    kind: "tool-call",
    turn: 1,
    step: 1,
    callId: "c1",
    name: "bash",
    args: "ls",
  });
  const before = dump();
  deliver(text(" \n\n "));
  assert.equal(dump(), before, "异来源空白分片不落节");
  app.dispose();
});

test("P5：同来源内部的空白分片保留（段落空行语义不变）", () => {
  const { app, deliver, dump } = makeApp();
  deliver(text("第一段"));
  deliver(text("\n\n"));
  deliver(text("第二段"));
  assert.ok(
    dump().includes("\\n\\n"),
    "同来源内部的空白分片应保留: " + dump().slice(0, 300),
  );
  app.dispose();
});

test("P5：非 text 交付不受该规则影响（user 空白行维持现状）", () => {
  const { app, deliver, dump } = makeApp();
  deliver({ kind: "user", turn: 1, step: 1, text: " " });
  assert.ok(
    dump().includes(" "),
    "user 空白行维持现状: " + dump().slice(0, 200),
  );
  app.dispose();
});
