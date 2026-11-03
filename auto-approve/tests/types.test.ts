import assert from "node:assert/strict";
import { test } from "node:test";

import { readService } from "../src/types.ts";

test("readService 对 cordis 未注入属性的抛错返回 undefined", () => {
  const hostile = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "get") return () => undefined;
        throw new Error(`cannot get property "${String(key)}" without inject`);
      },
    },
  ) as unknown;

  assert.equal(readService(hostile, "sessionPaths"), undefined);
  assert.equal(readService(hostile, "memory"), undefined);
});

test("readService 仍优先 ctx.get 并支持普通属性", () => {
  const value = { sessionDirFor: () => "/tmp/x" };
  const viaGet = {
    get: (name: string) => (name === "sessionPaths" ? value : undefined),
  };
  assert.deepEqual(readService(viaGet, "sessionPaths"), value);

  const plain = { sessionPaths: value };
  assert.deepEqual(readService(plain, "sessionPaths"), value);
});
