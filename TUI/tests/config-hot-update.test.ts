// tests/config-hot-update.test.ts — profile 配置热更新（cordis `internal/update` 钩子）
//
// 背景：宿主 profile 的 cordis.patch.yml 被改写（`colortheme dark|light` 改 tui 行的
// config.theme）时，cordis 默认重启该行 fiber = 卸载插件 → disposeApp() → renderer.close()
// → process.exit()，整个 dsh 进程随之退出。修法：只含可热应用键（theme）的更新就地生效并
// **否决重启**；其余更新交回默认路径。两条 happy-path 与「不可热应用」各档由本文件覆盖。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLiveConfigUpdate,
  makeConfigHotUpdateHandler,
  type DshTuiConfig,
} from "../src/main.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

/** 造一对「当前/新」配置 + 记录 applyTheme/nextStep 调用的钩子 */
function harness(current: DshTuiConfig | undefined) {
  const themed: ThemeId[] = [];
  let nextCalls = 0;
  const handler = makeConfigHotUpdateHandler(current, (id) => themed.push(id));
  const run = (next: DshTuiConfig | undefined): unknown =>
    handler(next, true, () => {
      nextCalls++;
      return "restarted";
    });
  return {
    run,
    themed,
    nextCalls: () => nextCalls,
  };
}

test("只改 theme：否决重启（不调 next）并就地切主题", () => {
  const h = harness({ theme: "dark", messageGutter: 6, cwd: "/w" });
  assert.equal(
    h.run({ theme: "light", messageGutter: 6, cwd: "/w" }),
    undefined,
  );
  assert.deepEqual(h.themed, ["light"], "applyTheme 收到新主题");
  assert.equal(h.nextCalls(), 0, "未走默认重启路径");
});

test("theme 值不变：仍否决重启（配置无实质变更，不必重建）", () => {
  const h = harness({ theme: "light" });
  assert.equal(h.run({ theme: "light" }), undefined);
  assert.equal(h.nextCalls(), 0);
  assert.deepEqual(
    h.themed,
    ["light"],
    "幂等应用（App.applyTheme 同值即返回）",
  );
});

test("theme 非法值：按默认归一化（dark），仍否决重启", () => {
  const h = harness({ theme: "light" });
  h.run({ theme: "solarized" as ThemeId });
  assert.deepEqual(h.themed, ["dark"]);
  assert.equal(h.nextCalls(), 0);
});

test("theme 之外还有变更：交回默认重启路径（不抢改）", () => {
  const h = harness({ theme: "dark", messageGutter: 4 });
  assert.equal(h.run({ theme: "light", messageGutter: 8 }), "restarted");
  assert.deepEqual(h.themed, [], "不可热应用时不半途切主题");
  assert.equal(h.nextCalls(), 1);
});

test("只改非 theme 键：交回默认重启路径", () => {
  const h = harness({ theme: "dark", messageGutter: 4 });
  assert.equal(h.run({ theme: "dark", messageGutter: 10 }), "restarted");
  assert.equal(h.nextCalls(), 1);
});

test("新增键 / 删除键：均判为不可热应用", () => {
  const added = harness({ theme: "dark" });
  assert.equal(added.run({ theme: "dark", model: "m" }), "restarted");
  const removed = harness({ theme: "dark", model: "m" });
  assert.equal(removed.run({ theme: "dark" }), "restarted");
  assert.equal(added.nextCalls(), 1);
  assert.equal(removed.nextCalls(), 1);
});

test("next 为 undefined（无配置）：交回默认重启路径", () => {
  const h = harness({ theme: "dark" });
  assert.equal(h.run(undefined), "restarted");
  assert.equal(h.nextCalls(), 1);
});

test("嵌套对象键序不同不算变更（键序无关比较）", () => {
  const a = { theme: "dark", extra: { x: 1, y: 2 } } as unknown as DshTuiConfig;
  const b = {
    theme: "light",
    extra: { y: 2, x: 1 },
  } as unknown as DshTuiConfig;
  const h = harness(a);
  assert.equal(h.run(b), undefined, "只有 theme 变 → 可热应用");
  assert.equal(h.nextCalls(), 0);
});

test("isLiveConfigUpdate：值类型差异（数字 vs 字符串）判为变更", () => {
  const a = { messageGutter: 4 } as unknown as DshTuiConfig;
  const b = { messageGutter: "4" } as unknown as DshTuiConfig;
  assert.equal(isLiveConfigUpdate(a, b), false);
  assert.equal(isLiveConfigUpdate({ theme: "dark" }, { theme: "light" }), true);
  assert.equal(isLiveConfigUpdate(undefined, { theme: "light" }), true);
  assert.equal(isLiveConfigUpdate({ theme: "dark" }, undefined), false);
});
