// tests/main.config.test.ts — 展示类配置归一化（main.ts 配置边界）
//
// 覆盖：默认值；合法值透传；非法值（非有限数/越界/小数）回退默认并告警；
// streamTypewriter 显式 false 生效。normalizeTuiDisplayConfig 为纯函数，
// 真实链路在 apply() 一次性归一化，app 内不再判断合法性。

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTuiDisplayConfig } from "../src/main.ts";

function collect(): { warns: string[]; warn: (m: string) => void } {
  const warns: string[] = [];
  return { warns, warn: (m) => warns.push(m) };
}

test("归一化默认值：streamTypewriter=true, 流速 120, thinking 4, gutter 4", () => {
  const c = normalizeTuiDisplayConfig(undefined);
  assert.deepEqual(c, {
    streamTypewriter: true,
    streamCharsPerSecond: 120,
    thinkingMaxLines: 4,
    messageGutter: 4,
  });
});

test("归一化合法值透传：可关打字机、自定义流速/行数/gutter", () => {
  const c = normalizeTuiDisplayConfig({
    streamTypewriter: false,
    streamCharsPerSecond: 2000,
    thinkingMaxLines: 50,
    messageGutter: 20,
  });
  assert.deepEqual(c, {
    streamTypewriter: false,
    streamCharsPerSecond: 2000,
    thinkingMaxLines: 50,
    messageGutter: 20,
  });
});

test("归一化非法值回退默认并告警", () => {
  const { warns, warn } = collect();
  const c = normalizeTuiDisplayConfig(
    {
      streamCharsPerSecond: -5,
      thinkingMaxLines: 0,
    },
    warn,
  );
  assert.equal(c.streamCharsPerSecond, 120);
  assert.equal(c.thinkingMaxLines, 4);
  assert.ok(warns.length >= 2, "每项非法值各告警一次，实际:" + warns.length);
  assert.ok(warns.every((w) => w.includes("回退默认")));
});

test("归一化越界/非有限数同样回退", () => {
  const { warns, warn } = collect();
  const c = normalizeTuiDisplayConfig(
    {
      streamCharsPerSecond: 2001,
      thinkingMaxLines: 51,
      messageGutter: 21,
      // @ts-expect-error 运行时可能注入非法类型
      streamTypewriter: "yes",
    },
    warn,
  );
  assert.equal(c.streamCharsPerSecond, 120);
  assert.equal(c.thinkingMaxLines, 4);
  assert.equal(c.messageGutter, 4, "越界回退默认");
  assert.ok(warns.length >= 3);
  // streamTypewriter 不做类型校验：truthy 字符串视为开启（布尔宽松）
  assert.equal(c.streamTypewriter, true);
});

test("归一化小数四舍五入并在界内", () => {
  const c = normalizeTuiDisplayConfig({ streamCharsPerSecond: 99.6 });
  assert.equal(c.streamCharsPerSecond, 100);
  const c2 = normalizeTuiDisplayConfig({ thinkingMaxLines: 2.4 });
  assert.equal(c2.thinkingMaxLines, 2);
  const c3 = normalizeTuiDisplayConfig({ messageGutter: 3.6 });
  assert.equal(c3.messageGutter, 4);
});
