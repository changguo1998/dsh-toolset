/**
 * 镜像单测：memory-base 写句柄的获取与缓存（`registerKind` 只取一次）、写入正文的字段口径
 * （`tier` / `sessionId` / `project` / `title` / `source.ref`）、`project` 回落，以及三档失效
 * （句柄不可写 / 被拒收 / 抛错）都转成异常交给动作层计数。
 *
 * 用结构面假服务，不连 memory-base。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createGroup, groupView } from "../src/model.ts";
import { MemoryBaseMirror, isMemoryFace, MIRROR_KIND } from "../src/mirror.ts";
import type { MemoryFace, MemoryScopeFace } from "../src/mirror.ts";
import type { AgentGroupState, GroupView } from "../src/types.ts";

const MANAGER = "sess-manager";

/** 造一份真实形状的组状态与只读视图（不经过动作层）。 */
function sampleGroup(): { group: AgentGroupState; view: GroupView } {
  const created = createGroup(
    { version: 1, managerSessionId: MANAGER, groups: {} },
    { name: "team", managerSessionId: MANAGER, now: 10, id: "g-1" },
  );
  assert.ok(!("ok" in created));
  return { group: created.group, view: groupView(created.group) };
}

/** 假 memory-base：记录 `registerKind` 与 `put` 的调用。 */
function fakeMemory(
  options: {
    /** 替换 `registerKind` 返回的句柄（缺省给一个可写句柄）。 */
    scope?: MemoryScopeFace;
    /** 句柄 `put` 的返回体（缺省 `{ids, created}`）。 */
    result?: Awaited<ReturnType<MemoryScopeFace["put"]>> | undefined;
    registerThrows?: Error;
  } = {},
) {
  const registrations: Array<{ kind: string }> = [];
  const puts: Array<Record<string, unknown>> = [];
  const scope: MemoryScopeFace = options.scope ?? {
    async put(input) {
      puts.push(input);
      return options.result ?? { ids: [1], created: 1 };
    },
  };
  const face: MemoryFace = {
    registerKind(spec) {
      if (options.registerThrows !== undefined) throw options.registerThrows;
      registrations.push(spec);
      return scope;
    },
  };
  return { face, registrations, puts };
}

test("判据: isMemoryFace 只认 registerKind（remember 不在服务面上）", () => {
  const { face } = fakeMemory();
  assert.equal(isMemoryFace(face), true);
  assert.equal(isMemoryFace({ remember: () => {} }), false);
  assert.equal(isMemoryFace(null), false);
  assert.equal(isMemoryFace("memory"), false);
  assert.equal(MIRROR_KIND, "agent_group");
});

test("写入: 分类只注册一次，正文带层级 / 会话 / 项目 / 来源 ref", async () => {
  const { group, view } = sampleGroup();
  const { face, registrations, puts } = fakeMemory();
  const mirror = new MemoryBaseMirror(face, () => "/work/project");

  await mirror.put({ managerSessionId: MANAGER, group, view });
  await mirror.put({ managerSessionId: MANAGER, group, view });

  assert.deepEqual(registrations, [{ kind: "agent_group" }], "句柄只取一次");
  assert.equal(puts.length, 2);
  const first = puts[0]!;
  assert.equal(first["tier"], "session");
  assert.equal(first["sessionId"], MANAGER);
  assert.equal(first["project"], "/work/project");
  assert.equal(first["title"], "agent-group team");
  assert.deepEqual(JSON.parse(String(first["content"])), view);
  assert.deepEqual(first["source"], {
    kind: "manual",
    label: "agent_group",
    ref: "g-1",
  });
});

test("写入: 取不到项目路径时回落 agent-group:<组名>", async () => {
  const { group, view } = sampleGroup();
  const { face, puts } = fakeMemory();
  const mirror = new MemoryBaseMirror(face, () => undefined);
  await mirror.put({ managerSessionId: MANAGER, group, view });
  assert.equal(puts[0]?.["project"], "agent-group:team");
});

test("写入: registerKind 返回不可写句柄 → 抛错（不缓存，下次重试）", async () => {
  const { group, view } = sampleGroup();
  const { face, registrations } = fakeMemory({ scope: {} as MemoryScopeFace });
  const mirror = new MemoryBaseMirror(face, () => undefined);

  await assert.rejects(
    () => mirror.put({ managerSessionId: MANAGER, group, view }),
    /未返回可写的分类句柄/,
  );
  await assert.rejects(
    () => mirror.put({ managerSessionId: MANAGER, group, view }),
    /未返回可写的分类句柄/,
  );
  assert.equal(registrations.length, 2, "失败不缓存句柄");
});

test("写入: registerKind 抛错原样冒泡（上层只计数 + 一次日志）", async () => {
  const { group, view } = sampleGroup();
  const { face } = fakeMemory({ registerThrows: new Error("同名重复注册") });
  const mirror = new MemoryBaseMirror(face, () => undefined);
  await assert.rejects(
    () => mirror.put({ managerSessionId: MANAGER, group, view }),
    /同名重复注册/,
  );
});

test("写入: 被 memory-base 拒收（skipped）→ 抛错并带原因", async () => {
  const { group, view } = sampleGroup();
  const { face } = fakeMemory({ result: { skipped: "preWrite 拒绝" } });
  const mirror = new MemoryBaseMirror(face, () => undefined);
  await assert.rejects(
    () => mirror.put({ managerSessionId: MANAGER, group, view }),
    /memory-base 拒收（preWrite 拒绝）/,
  );
});

test("写入: skipped 为空串或返回体缺失都按成功处理", async () => {
  const { group, view } = sampleGroup();
  const empty = fakeMemory({ result: { skipped: "" } });
  await new MemoryBaseMirror(empty.face, () => undefined).put({
    managerSessionId: MANAGER,
    group,
    view,
  });

  const missing = fakeMemory({ result: undefined });
  await new MemoryBaseMirror(missing.face, () => undefined).put({
    managerSessionId: MANAGER,
    group,
    view,
  });
  assert.equal(missing.puts.length, 1);
});
