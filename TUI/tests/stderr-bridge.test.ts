/**
 * stderr 桥单测（项目级 BACKLOG #61 方案 A）：行缓冲 / tone 判定 / 防递归 / 多参形态 /
 * restore 残行透传。用假流，不动真实 `process.stderr`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  externalLogTone,
  installStderrBridge,
  isSuppressedHostLog,
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

test("stderr-bridge：纯噪声行判定（模型目录成功日志丢弃，失败行保留）", () => {
  assert.equal(
    isSuppressedHostLog(
      "[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)",
    ),
    true,
  );
  assert.equal(
    isSuppressedHostLog(
      "[llm-deepseek-api-key] model listing from https://api.deepseek.com/models failed (TIMEOUT); keeping the previous catalog",
    ),
    false,
    "失败行必须仍能显示",
  );
  assert.equal(isSuppressedHostLog("[rule-engine] warn: a"), false);
});

test("stderr-bridge：噪声行不进 sink，其余行照常交付", () => {
  const { raw, stream } = fakeStream();
  const got: string[] = [];
  const bridge = installStderrBridge((line) => got.push(line), stream);
  stream.write(
    "[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)\n",
  );
  stream.write("[tui] 普通日志\n");
  assert.deepEqual(got, ["[tui] 普通日志"]);
  bridge.restore();
  assert.deepEqual(raw, [], "丢弃行不落到原始流");
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

test("stderr-bridge：仅 encoding 的多参调用仍透传原始流", () => {
  const { raw, stream } = fakeStream();
  const got: string[] = [];
  const bridge = installStderrBridge((line) => got.push(line), stream);
  stream.write("chunk", "utf8");
  assert.deepEqual(got, []);
  assert.deepEqual(raw, ["chunk"]);
  bridge.restore();
});

test("stderr-bridge：回调形态（console.* 的 write(text, cb)）照样过滤与交付", async () => {
  const { raw, stream } = fakeStream();
  const got: string[] = [];
  const calls: string[] = [];
  const bridge = installStderrBridge((line) => got.push(line), stream);
  const onWrite = (error?: unknown): void => {
    calls.push(error === undefined ? "ok" : String(error));
  };
  stream.write(
    "[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)\n",
    onWrite,
  );
  stream.write("[rule-engine] warn: a\n", "utf8", onWrite);
  assert.deepEqual(got, ["[rule-engine] warn: a"], "噪声行丢弃, 其余行进 sink");
  assert.deepEqual(raw, [], "回调形态不再落原始流");
  assert.deepEqual(calls, [], "回调异步触发, 写入当场尚未调用");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(calls, ["ok", "ok"]);
  bridge.restore();
});

test("stderr-bridge：回调形态下 sink 异常交给回调, 不向调用方抛", async () => {
  const { raw, stream } = fakeStream();
  const calls: unknown[] = [];
  const bridge = installStderrBridge(() => {
    throw new Error("boom");
  }, stream);
  assert.equal(
    stream.write("x\n", (error?: unknown) => calls.push(error)),
    true,
  );
  assert.deepEqual(raw, []);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal((calls[0] as Error).message, "boom");
  bridge.restore();
});

test("stderr-bridge：restore 后恢复原始 write", () => {
  const { raw, stream } = fakeStream();
  const bridge = installStderrBridge(() => {}, stream);
  bridge.restore();
  stream.write("after\n");
  assert.deepEqual(raw, ["after\n"]);
});
