import { test } from "node:test";
import assert from "node:assert/strict";
import { name, inject, provide, resolveConfig, apply } from "../src/index.ts";

test("导出名与硬依赖/服务面声明", () => {
  assert.equal(name, "cache-hit-monitor");
  assert.deepEqual(inject, []);
  assert.deepEqual(provide, ["cacheHitMonitor"]);
});

test("resolveConfig: 缺省与非法值回退", () => {
  assert.deepEqual(resolveConfig(), {
    enabled: true,
    tolerance: 0.3,
    firstStepOnly: false,
  });
  assert.deepEqual(resolveConfig({ tolerance: 0.1 }), {
    enabled: true,
    tolerance: 0.1,
    firstStepOnly: false,
  });
  assert.deepEqual(resolveConfig({ tolerance: -1 }), {
    enabled: true,
    tolerance: 0.3,
    firstStepOnly: false,
  });
  assert.deepEqual(resolveConfig({ tolerance: 2 }), {
    enabled: true,
    tolerance: 0.3,
    firstStepOnly: false,
  });
  assert.deepEqual(resolveConfig({ enabled: false, firstStepOnly: true }), {
    enabled: false,
    tolerance: 0.3,
    firstStepOnly: true,
  });
});

test("apply: 骨架可装配并返回 dispose", () => {
  let disposedCount = 0;
  const ctx = {
    on: () => {
      return () => {
        disposedCount += 1;
      };
    },
    provide: () => {},
  };
  const off = apply(ctx);
  assert.equal(typeof off, "function");
  off();
  assert.equal(disposedCount, 3); // A4 起订阅 agent/pre-step / session/event / session/disposed
});
