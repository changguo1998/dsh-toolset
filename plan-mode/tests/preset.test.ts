import { test } from "node:test";
import assert from "node:assert/strict";

import {
  enterPlanPreset,
  restorePreset,
  switchToReadonly,
} from "../src/preset.ts";
import type { PresetsService } from "../src/preset.ts";

/** 假预设服务：可调 names / current / 抛错点, 并记录 set 调用。 */
function makeService(
  options: {
    names?: readonly string[];
    current?: string;
    throws?: { current?: boolean; set?: boolean };
  } = {},
): { service: PresetsService; calls: string[] } {
  const calls: string[] = [];
  const service: PresetsService = {
    names: options.names ?? ["workspace-write", "read-only"],
    current: (_session) => {
      calls.push("current");
      if (options.throws?.current) throw new Error("current boom");
      return options.current ?? "workspace-write";
    },
    set: (_session, name) => {
      calls.push(`set:${name}`);
      if (options.throws?.set) throw new Error("set boom");
    },
  };
  return { service, calls };
}

const SESSION = { id: "sess-1" };

test("进入时切只读并记住原预设", () => {
  const { service, calls } = makeService();
  const result = switchToReadonly(service, SESSION);
  assert.equal(result.presetSwitched, true);
  assert.equal(result.originalPreset, "workspace-write");
  assert.ok(calls.includes("set:read-only"));
});

test("二次进入沿用原预设并重新切只读", () => {
  const { service, calls } = makeService();
  const result = enterPlanPreset(service, SESSION, {
    originalPreset: "workspace-write",
    restored: true,
  });
  assert.equal(result.presetSwitched, true);
  assert.match(result.presetNote ?? "", /沿用原预设并重新切只读/);
  assert.ok(calls.includes("set:read-only"));
});

test("二次进入且上棵未恢复: 不动预设", () => {
  const { service, calls } = makeService();
  const result = enterPlanPreset(service, SESSION, {
    originalPreset: "workspace-write",
    restored: false,
  });
  assert.equal(result.presetSwitched, false);
  assert.ok(!calls.includes("set:read-only"));
});

test("预设名不含 read-only 时降级", () => {
  const { service } = makeService({ names: ["workspace-write", "full"] });
  const result = switchToReadonly(service, SESSION);
  assert.equal(result.presetSwitched, false);
  assert.match(result.presetNote ?? "", /预设名不含 read-only/);
  assert.equal(result.originalPreset, undefined);
});

test("原预设为 custom 时降级", () => {
  const { service } = makeService({ current: "custom" });
  const result = switchToReadonly(service, SESSION);
  assert.equal(result.presetSwitched, false);
  assert.match(result.presetNote ?? "", /custom/);
});

test("服务缺席时降级", () => {
  const result = switchToReadonly(undefined, SESSION);
  assert.equal(result.presetSwitched, false);
  assert.match(result.presetNote ?? "", /缺席/);
});

test("计划段完成时恢复原预设", () => {
  const { service, calls } = makeService({ current: "read-only" });
  const result = restorePreset(service, SESSION, "workspace-write", false);
  assert.equal(result.applied, true);
  assert.ok(calls.includes("set:workspace-write"));
});

test("计划段失败时也恢复", () => {
  // 完成与失败都走同一个恢复函数（触发判定在 stage.planTerminal）, 失败不区分
  const { service } = makeService({ current: "read-only" });
  const result = restorePreset(service, SESSION, "workspace-write", false);
  assert.equal(result.applied, true);
});

test("用户手改过则不覆盖", () => {
  const { service, calls } = makeService({ current: "workspace-write" });
  const result = restorePreset(service, SESSION, "read-only", false);
  assert.equal(result.applied, false);
  assert.match(result.note ?? "", /手动改过/);
  assert.ok(!calls.some((call) => call.startsWith("set:")), "不应调 set");
});

test("已恢复过则不重复恢复", () => {
  const { service, calls } = makeService({ current: "read-only" });
  const result = restorePreset(service, SESSION, "workspace-write", true);
  assert.equal(result.applied, false);
  assert.ok(!calls.some((call) => call.startsWith("set:")), "不应调 set");
});

test("记录里没原预设（进入时降级）: 恢复只清理不告警", () => {
  const { service, calls } = makeService({ current: "read-only" });
  const result = restorePreset(service, SESSION, undefined, false);
  assert.equal(result.applied, false);
  assert.equal(result.note, undefined, "不重复告警");
  assert.ok(!calls.some((call) => call.startsWith("set:")), "不应调 set");
});
