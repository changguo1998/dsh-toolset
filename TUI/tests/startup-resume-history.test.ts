// tests/startup-resume-history.test.ts — 启动即恢复的历史区渲染（BACKLOG TUI#40）
//
// 覆盖：`resumedAtLaunch`（CLI --resume / -c 成功）时启动补一次 surface 折叠——历史区直接
// 可见既有消息、标题本地兜底、`followBottom` 生效；非恢复启动不读取；空会话保持空历史；
// 读取失败给提示且不抛（不阻塞启动）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { App } from "../src/app/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import type { AppState } from "../src/app/state.ts";

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function makeApp(
  resumed: boolean,
  surfaces: Record<string, { role: "user" | "assistant"; text: string }[]> = {},
): {
  adapter: FakeAdapter;
  renderer: FakeRenderer;
  st: () => AppState;
  app: App;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  adapter.resumedAtLaunch = resumed;
  adapter.sessionSurfaces = surfaces;
  const app = new TrackedApp({
    renderer,
    adapter,
    notify: { enabled: false },
  });
  app.start();
  return {
    adapter,
    renderer,
    app,
    st: () => (app as unknown as { state: AppState }).state,
  };
}

test("启动即恢复：既有消息折叠入 buffer（用户/回复行可见），标题本地兜底", async () => {
  const { adapter, st, app } = makeApp(true, {
    s1: [
      { role: "user", text: "昨天的提问" },
      { role: "assistant", text: "昨天的回答" },
    ],
  });
  try {
    await sleep(0);
    assert.deepEqual(
      adapter.readSurfaceCalls,
      ["s1"],
      "按活跃会话读取 surface",
    );
    const state = st();
    assert.equal(state.activeSessionId, "s1", "活跃会话确立为恢复的会话");
    assert.ok(
      state.buffer.some(
        (l) => l.kind === "user" && l.text.includes("昨天的提问"),
      ),
      "用户消息行折叠入历史: " + JSON.stringify(state.buffer),
    );
    assert.ok(
      state.buffer.some(
        (l) => l.kind === "assistant" && l.text.includes("昨天的回答"),
      ),
      "助手消息行折叠入历史",
    );
    assert.ok(state.sessionTitle !== "", "标题有本地兜底（首条用户消息）");
    assert.equal(state.followBottom, true, "恢复后跟随底部");
  } finally {
    app.dispose();
  }
});

test("非恢复启动（resumedAtLaunch 缺省 false）：不读取 surface，历史区保持空", async () => {
  const { adapter, st, app } = makeApp(false, {
    s1: [{ role: "user", text: "不应被读" }],
  });
  try {
    await sleep(0);
    assert.deepEqual(adapter.readSurfaceCalls, [], "不读取既有消息");
    assert.deepEqual(st().buffer, [], "历史区为空（全新会话）");
  } finally {
    app.dispose();
  }
});

test("启动即恢复但会话为空：保持空历史（不产生空行）", async () => {
  const { st, app } = makeApp(true, { s1: [] });
  try {
    await sleep(0);
    assert.deepEqual(st().buffer, [], "空会话不折叠任何行");
  } finally {
    app.dispose();
  }
});

test("启动即恢复读取失败：给提示且不抛（不阻塞启动）", async () => {
  // 不给 sessionSurfaces → 假 adapter 的 readSessionSurface 会抛
  const { renderer, st, app } = makeApp(true, {});
  try {
    await sleep(0);
    const buf = st().buffer;
    assert.ok(
      buf.some(
        (l) => l.kind === "notice" && l.text === "启动恢复：既有消息读取失败",
      ),
      "失败提示落入 buffer: " + JSON.stringify(buf),
    );
    assert.ok(
      !buf.some((l) => l.kind === "user" || l.kind === "assistant"),
      "无历史消息行（保持空历史）",
    );
    assert.ok(
      renderer.lastRender.join("\n").includes("启动恢复：既有消息读取失败"),
      "提示上屏: " + JSON.stringify(renderer.lastRender.slice(-6)),
    );
  } finally {
    app.dispose();
  }
});

test("启动期外部日志：恢复启动时先挂起，折叠落定后补发（BACKLOG TUI#9）", async () => {
  const { st, app } = makeApp(true, {
    s1: [{ role: "assistant", text: "昨天的回答" }],
  });
  try {
    // start() 已置挂起态：此刻到达的外部日志进队列，不直接落 buffer
    app.appendExternalLog("[rule-engine] warn: 装载期告警", "warn");
    assert.ok(
      !st().buffer.some((l) => l.kind === "notice"),
      "折叠落定前不直接入 buffer: " + JSON.stringify(st().buffer),
    );
    for (
      let i = 0;
      i < 20 && !st().buffer.some((l) => l.kind === "notice");
      i++
    ) {
      await sleep(0);
    }
    const notice = st().buffer.find((l) => l.kind === "notice");
    assert.ok(notice, "折叠落定后补发进活动区: " + JSON.stringify(st().buffer));
    assert.equal(notice?.text, "[rule-engine] warn: 装载期告警");
    assert.equal(notice?.tone, "warn", "tone 保留");
    // 落定后新到的日志直接入 buffer
    app.appendExternalLog("后续日志");
    assert.ok(
      st().buffer.some((l) => l.kind === "notice" && l.text === "后续日志"),
      "落定后直接入 buffer",
    );
  } finally {
    app.dispose();
  }
});
