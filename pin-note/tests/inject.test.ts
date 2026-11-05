import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NOTE_CHARS,
  PIN_SOURCE_KIND,
  isPinMessage,
  pinMessage,
  renderText,
  samePinPayload,
} from "../src/inject.ts";
import type { PinRecord } from "../src/store.ts";

const RECORDS: PinRecord[] = [
  { id: 1, content: "用户的风格要求是短句直述。", title: "风格" },
  { id: 2, content: "实现思路：先定接口再补实现。", title: "" },
];

test("零条记录不产出消息", () => {
  assert.equal(renderText([]), undefined);
  assert.equal(pinMessage([]), undefined);
});

test("正文含条数、合计字数、标题与逐条内容", () => {
  const text = renderText(RECORDS);
  assert.ok(text);
  assert.match(text, /^\[pin-note\] 跨压缩保持项（2 条/);
  assert.match(text, /1\. 风格/);
  assert.match(text, /2\. 第 2 条/);
  assert.match(text, /用户的风格要求是短句直述。/);
});

test("超长单条按上限截断", () => {
  const text = renderText([
    { id: 1, content: "x".repeat(MAX_NOTE_CHARS + 10), title: "" },
  ]);
  assert.ok(text);
  assert.ok(text.includes("…"));
  assert.equal(text.includes("x".repeat(MAX_NOTE_CHARS + 10)), false);
});

test("消息形状：user-role + 单段 text + 自定义 source kind", () => {
  const message = pinMessage(RECORDS);
  assert.ok(message);
  assert.equal(message.role, "user");
  assert.equal(message.content.length, 1);
  assert.equal(message.content[0]!.type, "text");
  assert.deepEqual(message.source, { kind: PIN_SOURCE_KIND });
  assert.equal(typeof message.id, "string");
});

test("payload 相等判断：内容相同即相同，内容变化即不同", () => {
  const left = pinMessage(RECORDS);
  const right = pinMessage(RECORDS);
  assert.ok(left && right);
  assert.equal(samePinPayload(left, right), true);
  const changed = pinMessage([RECORDS[0]!]);
  assert.ok(changed);
  assert.equal(samePinPayload(left, changed), false);
});

test("来源识别", () => {
  const message = pinMessage(RECORDS);
  assert.ok(message);
  assert.equal(isPinMessage(message), true);
  assert.equal(isPinMessage({ source: { kind: "other" } }), false);
  assert.equal(isPinMessage(undefined), false);
});
