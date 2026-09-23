// tests/main.config.test.ts — 展示类配置归一化（main.ts 配置边界）
//
// 覆盖：默认值；合法值透传；非法值（非有限数/越界/小数）回退默认并告警。
// normalizeTuiDisplayConfig 为纯函数，真实链路在 apply() 一次性归一化，
// app 内不再判断合法性。

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTuiDisplayConfig } from "../src/main.ts";

function collect(): { warns: string[]; warn: (m: string) => void } {
  const warns: string[] = [];
  return { warns, warn: (m) => warns.push(m) };
}

test("归一化默认值：gutter 6", () => {
  const c = normalizeTuiDisplayConfig(undefined);
  assert.deepEqual(c, { messageGutter: 6 });
});

test("归一化合法值透传：自定义 gutter", () => {
  const c = normalizeTuiDisplayConfig({ messageGutter: 20 });
  assert.deepEqual(c, { messageGutter: 20 });
});

test("归一化非法值回退默认并告警", () => {
  const { warns, warn } = collect();
  const c = normalizeTuiDisplayConfig(
    {
      messageGutter: -5,
    },
    warn,
  );
  assert.equal(c.messageGutter, 6);
  assert.ok(warns.length >= 1, "每项非法值各告警一次，实际:" + warns.length);
  assert.ok(warns.every((w) => w.includes("回退默认")));
});

test("归一化越界/非有限数同样回退", () => {
  const { warns, warn } = collect();
  const c = normalizeTuiDisplayConfig(
    {
      messageGutter: 21,
    },
    warn,
  );
  assert.equal(c.messageGutter, 6, "越界回退默认");
  assert.ok(warns.length >= 1);
});

test("归一化小数四舍五入并在界内", () => {
  const c = normalizeTuiDisplayConfig({ messageGutter: 3.6 });
  assert.equal(c.messageGutter, 4);
});
