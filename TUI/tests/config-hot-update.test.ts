// tests/config-hot-update.test.ts — profile 配置热更新（cordis `internal/update` 钩子）
//
// 背景：宿主 profile 的 cordis.patch.yml 被改写时，cordis 默认重启本行 fiber = 卸载插件 →
// disposeApp() → renderer.close() → process.exit()，整个 dsh 进程随之退出。修法：钩子对**任何**
// 配置变更都否决重启（不调 next）；可热应用的键（theme）就地生效，其余键提示需重启、会话保留。
// 本文件覆盖分类函数 `planConfigUpdate` 的各档与钩子的落地行为（含「任何变更都不重建」）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeConfigHotUpdateHandler,
  planConfigUpdate,
  type DshTuiConfig,
  type LiveConfigPatch,
} from "../src/main.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

/** 造钩子 + 记录 apply/notice/next 调用 */
function harness(current: DshTuiConfig | undefined) {
  const applied: LiveConfigPatch[] = [];
  const notices: string[] = [];
  let nextCalls = 0;
  const handler = makeConfigHotUpdateHandler(current, {
    apply: (patch) => applied.push(patch),
    notice: (text) => notices.push(text),
  });
  return {
    run: (next: DshTuiConfig | undefined): unknown =>
      handler(next, true, () => {
        nextCalls++;
        return "restarted";
      }),
    applied,
    notices,
    nextCalls: () => nextCalls,
  };
}

test("只改 theme：就地切主题，不重建、无提示", () => {
  const h = harness({ theme: "dark", messageGutter: 6, cwd: "/w" });
  assert.equal(
    h.run({ theme: "light", messageGutter: 6, cwd: "/w" }),
    undefined,
  );
  assert.deepEqual(h.applied, [{ theme: "light" }]);
  assert.deepEqual(h.notices, []);
  assert.equal(h.nextCalls(), 0);
});

test("theme 非法值：按默认归一化（dark）", () => {
  const h = harness({ theme: "light" });
  h.run({ theme: "solarized" as ThemeId });
  assert.deepEqual(h.applied, [{ theme: "dark" }]);
});

test("连续切换：第二次切回启动值仍生效（accepted 基线自持）", () => {
  const h = harness({ theme: "dark" });
  h.run({ theme: "light" });
  h.run({ theme: "dark" });
  assert.deepEqual(
    h.applied,
    [{ theme: "light" }, { theme: "dark" }],
    "每次切换都要相对上次生效值判定，而不是启动值",
  );
  assert.deepEqual(h.notices, []);
  assert.equal(h.nextCalls(), 0);
});

test("只改非热应用键：不重建（不问 next）、提示需重启、会话保留", () => {
  const h = harness({ theme: "dark", messageGutter: 4 });
  assert.equal(h.run({ theme: "dark", messageGutter: 8 }), undefined);
  assert.deepEqual(h.applied, [], "没有可热应用的变更");
  assert.equal(h.nextCalls(), 0, "绝不调 next（重建会把 dsh 进程一起带退出）");
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0]!, /messageGutter/);
  assert.match(h.notices[0]!, /重启/);
});

test("混合变更：theme 当次生效，其余键只提示", () => {
  const h = harness({ theme: "dark", messageGutter: 4, cwd: "/a" });
  h.run({ theme: "light", messageGutter: 8, cwd: "/a" });
  assert.deepEqual(h.applied, [{ theme: "light" }]);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0]!, /messageGutter/);
  assert.doesNotMatch(h.notices[0]!, /theme/, "theme 已生效，不进提示");
  assert.equal(h.nextCalls(), 0);
});

test("新增键 / 删除键：都只提示、不重建", () => {
  const added = harness({ theme: "dark" });
  added.run({ theme: "dark", model: "m" });
  assert.equal(added.nextCalls(), 0);
  assert.match(added.notices[0]!, /model/);
  const removed = harness({ theme: "dark", model: "m" });
  removed.run({ theme: "dark" });
  assert.equal(removed.nextCalls(), 0);
  assert.match(removed.notices[0]!, /model/);
});

test("无实质变更：无动作、无提示、不重建", () => {
  const h = harness({ theme: "dark", messageGutter: 4 });
  h.run({ theme: "dark", messageGutter: 4 });
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.notices, []);
  assert.equal(h.nextCalls(), 0);
});

test("next 为 undefined（配置被清空）：提示、不重建", () => {
  const h = harness({ theme: "dark" });
  assert.equal(h.run(undefined), undefined);
  assert.equal(h.nextCalls(), 0);
  assert.equal(h.notices.length, 1);
});

test("嵌套对象键序不同不算变更（键序无关比较）", () => {
  const a = { theme: "dark", extra: { x: 1, y: 2 } } as unknown as DshTuiConfig;
  const b = {
    theme: "light",
    extra: { y: 2, x: 1 },
  } as unknown as DshTuiConfig;
  const h = harness(a);
  h.run(b);
  assert.deepEqual(h.applied, [{ theme: "light" }]);
  assert.deepEqual(h.notices, [], "键序差异不算变更");
});

test("planConfigUpdate：值类型差异（数字 vs 字符串）判为变更", () => {
  const plan = planConfigUpdate(
    { messageGutter: 4 } as unknown as DshTuiConfig,
    { messageGutter: "4" } as unknown as DshTuiConfig,
  );
  assert.deepEqual(plan.restartKeys, ["messageGutter"]);
  assert.deepEqual(plan.patch, {});
});

test("planConfigUpdate：仅 theme 变更 → patch 有值、restartKeys 空", () => {
  const plan = planConfigUpdate({ theme: "dark" }, { theme: "light" });
  assert.deepEqual(plan.patch, { theme: "light" });
  assert.deepEqual(plan.restartKeys, []);
});
