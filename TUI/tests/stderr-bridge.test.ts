/**
 * stderr 桥单测（项目级 BACKLOG #61 方案 A）：行缓冲 / tone 判定 / 防递归 / 多参透传 /
 * restore 残行透传。用假流，不动真实 `process.stderr`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  externalLogTone,
  installStderrBridge,
  type ExternalLogTone,
} from "../src/app/stderr-bridge.ts";

/** 假 stderr：记录「原始流」收到的写入。 */
function fakeStream() {
  const raw: string[] = [];
  return {
    raw,
    stream: {
      write: (chunk: unknown, ..._rest: unknown[]): boolean => {
        raw.push(String(chunk));
        return true;
      },
    },
  };
}

test("stderr-bridge：按行交付 + 跨 chunk 缓冲 + tone 判定", () => {
  const { raw, stream } = fakeStream();
  const got: Array<[string, ExternalLogTone]> = [];
  const bridge = installStderrBridge(
    (line, tone) => got.push([line, tone]),
    stream,
  );
  stream.write("[rule-engine] warn: a");
  stream.write("bc\n[tui] 普通日志\nthird");
  assert.deepEqual(got, [
    ["[rule-engine] warn: abc", "warn"],
    ["[tui] 普通日志", "log"],
  ]);
  bridge.restore();
  assert.deepEqual(raw, ["third"], "未成行残行在 restore 时透传原始流");
});

test("stderr-bridge：tone 判定（error / warn 变体 / 默认 log）", () => {
  assert.equal(externalLogTone("[x] error: boom"), "error");
  assert.equal(externalLogTone("[x] fatal: boom"), "error");
  assert.equal(externalLogTone("[TUI] WARN: …"), "warn");
  assert.equal(externalLogTone("[tui] config warning: …"), "warn");
  assert.equal(externalLogTone("[x] 警告：…"), "warn");
  assert.equal(externalLogTone("[command-template] 已禁用"), "log");
});

test("stderr-bridge：交付期再写 stderr 直通原始流（防递归）", () => {
  const { raw, stream } = fakeStream();
  const seen: string[] = [];
  const bridge = installStderrBridge((line) => {
    seen.push(line);
    stream.write("[recursive] " + line + "\n");
  }, stream);
  stream.write("[rule-engine] warn: x\n");
  assert.deepEqual(seen, ["[rule-engine] warn: x"]);
  assert.deepEqual(raw, ["[recursive] [rule-engine] warn: x\n"]);
  bridge.restore();
});

test("stderr-bridge：多参调用（encoding / callback）透传原始流", () => {
  const { raw, stream } = fakeStream();
  const got: string[] = [];
  const bridge = installStderrBridge((line) => got.push(line), stream);
  stream.write("chunk", "utf8", () => {});
  assert.deepEqual(got, []);
  assert.deepEqual(raw, ["chunk"]);
  bridge.restore();
});

test("stderr-bridge：restore 后恢复原始 write", () => {
  const { raw, stream } = fakeStream();
  const bridge = installStderrBridge(() => {}, stream);
  bridge.restore();
  stream.write("after\n");
  assert.deepEqual(raw, ["after\n"]);
});
