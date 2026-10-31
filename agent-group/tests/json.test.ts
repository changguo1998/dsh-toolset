/**
 * lossless JSON 归一的单测：递归删掉 `undefined`（对象键与数组项）、保留其它值原样、
 * 不动非平凡原型对象（类实例 / `Date` 等由宿主自行判定），并按引用去重防环。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pruneUndefined } from "../src/json.ts";

test("归一去 undefined: 对象键与数组项都删掉，其它值原样", () => {
  assert.deepEqual(
    pruneUndefined({
      ok: true,
      group: "team",
      dropped: undefined,
      nested: { a: 1, b: undefined },
      list: [1, undefined, 2, undefined],
    }),
    { ok: true, group: "team", nested: { a: 1 }, list: [1, 2] },
  );
});

test("归一去 undefined: 原始值与空值原样返回", () => {
  assert.equal(pruneUndefined(undefined), undefined);
  assert.equal(pruneUndefined(null), null);
  assert.equal(pruneUndefined(0), 0);
  assert.equal(pruneUndefined(false), false);
  assert.equal(pruneUndefined("文本"), "文本");
});

test("归一: 非平凡原型对象原样返回（类实例不展开成普通对象）", () => {
  class Box {
    readonly value = 1;
    readonly missing = undefined;
  }
  const box = new Box();
  assert.equal(pruneUndefined(box), box);
  assert.equal(pruneUndefined(new Date(0)) instanceof Date, true);
});

test("归一: 同一引用出现两次不重复展开（按引用去重），环引用不栈溢出", () => {
  const shared = { a: 1, dropped: undefined };
  const pruned = pruneUndefined({ left: shared, right: shared });
  assert.deepEqual(
    pruned,
    { left: { a: 1 }, right: shared },
    "第二次出现按原引用返回",
  );

  const cyclic: Record<string, unknown> = { ok: true };
  cyclic["self"] = cyclic;
  cyclic["dropped"] = undefined;
  const result = pruneUndefined(cyclic) as Record<string, unknown>;
  assert.equal(result["ok"], true);
  assert.equal(result["self"], cyclic);
  assert.equal("dropped" in result, false);
});

test("归一: 无原型对象（Object.create(null)）按对象处理", () => {
  const bare = Object.create(null) as Record<string, unknown>;
  bare["a"] = 1;
  bare["dropped"] = undefined;
  assert.deepEqual(pruneUndefined(bare), { a: 1 });
});
