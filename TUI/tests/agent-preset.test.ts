// tests/agent-preset.test.ts — agent 预设：路由 + reducer 隔离 + DshEvent 归一化
//
// 覆盖：`/preset` 命令已删除（2026-10-02，项目级 BACKLOG「slash 命令命名规范：不用缩写」）
// → routeSlashCommand 落 registry；agent-preset 事件 → reducer presetBySession 按 sessionId
// 隔离（latest-wins）；agent-preset/selected 的 seq 守卫与非法值丢弃。
// 展示侧（标题栏 preset 段、状态列可选项）不受命令删除影响，仍由事件与目录同步驱动。

import { test } from "node:test";
import assert from "node:assert/strict";
import { routeSlashCommand } from "../src/app/commands.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import { createRealDshAdapter } from "../src/app/adapter/dsh.ts";
import type { DshEvent } from "../src/app/adapter/dsh.ts";

test("routeSlashCommand：/preset 已删除（落 registry）；未知名同样落 registry", () => {
  assert.equal(routeSlashCommand("preset"), "registry");
  assert.equal(routeSlashCommand("bogus"), "registry");
});

test("agent-preset 事件 → reducer 按 sessionId 隔离（latest-wins）", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "agent-preset",
    sessionId: "s1",
    preset: "research",
  });
  s = reduceState(s, {
    type: "agent-preset",
    sessionId: "s2",
    preset: "code-review",
  });
  s = reduceState(s, {
    type: "agent-preset",
    sessionId: "s1",
    preset: "default",
  });
  assert.equal(s.presetBySession["s1"], "default");
  assert.equal(s.presetBySession["s2"], "code-review");
});

test("agent-preset/selected 归一化：seq 守卫 + 非活跃会话丢弃（DshEvent 层）", () => {
  const events: DshEvent[] = [];
  const runtime = new FakeAdapterRuntime();
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent: { session: { id: "s1" }, followup() {} },
    approvalTimeoutMs: 50,
  });
  adapter.onEvent((e) => events.push(e));
  const send = (sessionId: string, seq: number, preset: unknown): void => {
    runtime.fireRaw(
      "session/event",
      { id: sessionId },
      {
        type: "agent-preset/selected",
        seq,
        time: Date.now(),
        data: { agentPreset: preset },
      },
    );
  };
  // 递增 seq 正常归一化
  send("s1", 1, "research");
  // 同 seq 重复 → 丢弃（seq 守卫）
  send("s1", 1, "default");
  // 递增 seq 正常 → 更新
  send("s1", 2, "code-review");
  // 非法（非字符串 / 空）→ 丢弃
  send("s1", 3, "");
  send("s1", 4, 42);
  // 非活跃会话 → 丢弃（适配器单活跃会话约束）
  send("s2", 1, "research");
  const presets = events.filter((e) => e.type === "agent-preset");
  assert.deepEqual(presets, [
    { type: "agent-preset", sessionId: "s1", preset: "research" },
    { type: "agent-preset", sessionId: "s1", preset: "code-review" },
  ]);
});

/** 最小 fake runtime：仅需 on + fireRaw（适配器注册/归一化链路）。 */
class FakeAdapterRuntime {
  listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  on(event: string, listener: (...args: unknown[]) => unknown): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
  fireRaw(event: string, ...args: unknown[]): unknown {
    const set = this.listeners.get(event);
    if (!set) return undefined;
    for (const cb of [...set]) cb(...args);
  }
}
