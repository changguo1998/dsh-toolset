/**
 * tests/socket.test.ts — socket 读通道与 stable 判稳
 *
 * 覆盖：`pane.read` 报文拼装（source 下划线映射、format/strip_ansi 联动）、响应解析
 * （含分片到达的 framing、错误信封）、连接层三种失败、stable 判稳三例（revision 收敛 /
 * 文本回退收敛 / 超时兜底）、假时钟下的时长语义。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPaneReader,
  interpretReadResponse,
  nextRequestId,
  toSocketSource,
  waitForStable,
} from "../src/socket.ts";
import {
  fakeClock,
  fakeConnector,
  fakeReader,
  readError,
  readOk,
} from "./helpers.ts";

/** 造一条成功的 pane.read 响应行。 */
function readResponse(read: Record<string, unknown>): string {
  return JSON.stringify({ id: "x", result: { type: "pane_read", read } });
}

test("toSocketSource: 连字符写法映射为下划线，其余不变", () => {
  assert.equal(toSocketSource("recent-unwrapped"), "recent_unwrapped");
  assert.equal(toSocketSource("visible"), "visible");
  assert.equal(toSocketSource("recent"), "recent");
  assert.equal(toSocketSource("detection"), "detection");
});

test("nextRequestId: 单调递增且带随机尾（不引入 uuid 依赖）", () => {
  const a = nextRequestId(1000);
  const b = nextRequestId(1000);
  assert.match(a, /^herdr-pane:1000:\d+:/);
  assert.notEqual(a, b);
  assert.notEqual(a.split(":")[2], b.split(":")[2]);
});

test("readPane: 报文含 method=pane.read、source 下划线、strip_ansi 随 format 联动", async () => {
  const connector = fakeConnector([
    {
      kind: "data",
      text: readResponse({
        pane_id: "wT:p2",
        source: "recent_unwrapped",
        format: "text",
        text: "hello",
        revision: 7,
        truncated: false,
      }),
    },
  ]);
  const reader = createPaneReader(
    { socketPath: "/tmp/herdr.sock", timeoutMs: 2500 },
    connector,
  );
  const outcome = await reader.readPane({
    paneId: "wT:p2",
    source: "recent-unwrapped",
    lines: 80,
    format: "text",
  });
  assert.equal(outcome.ok, true);
  assert.equal(connector.requests.length, 1);
  const request = connector.requests[0];
  assert.equal(request?.socketPath, "/tmp/herdr.sock");
  assert.equal(request?.timeoutMs, 2500);
  assert.ok(
    request?.payload.endsWith("\n"),
    "报文必须以换行结尾（协议按行分帧）",
  );
  const parsed = JSON.parse((request?.payload ?? "").trim()) as {
    id: string;
    method: string;
    params: Record<string, unknown>;
  };
  assert.equal(parsed.method, "pane.read");
  assert.match(parsed.id, /^herdr-pane:/);
  assert.deepEqual(parsed.params, {
    pane_id: "wT:p2",
    source: "recent_unwrapped",
    lines: 80,
    format: "text",
    strip_ansi: true,
  });
  assert.equal(outcome.ok && outcome.read.revision, 7);
  assert.equal(outcome.ok && outcome.read.truncated, false);
});

test("readPane: format=ansi 时 strip_ansi=false（与 CLI --format ansi 对齐）", async () => {
  const connector = fakeConnector([
    { kind: "data", text: readResponse({ text: "x", revision: 1 }) },
  ]);
  const reader = createPaneReader(
    { socketPath: "/tmp/s", timeoutMs: 100 },
    connector,
  );
  await reader.readPane({ paneId: "wT:p2", source: "visible", format: "ansi" });
  const params = JSON.parse((connector.requests[0]?.payload ?? "").trim()) as {
    params: Record<string, unknown>;
  };
  assert.equal(params.params.strip_ansi, false);
  assert.equal(params.params.format, "ansi");
  // 未给 lines 时不下发该字段（服务端按自身缺省取）
  assert.equal("lines" in params.params, false);
});

test("readPane: 连接层超时 / 连接错误 / 坏响应各归一为结构化失败", async () => {
  const timeout = createPaneReader(
    { socketPath: "/tmp/s", timeoutMs: 50 },
    fakeConnector([{ kind: "timeout" }]),
  );
  const t = await timeout.readPane({ paneId: "wT:p2", source: "visible" });
  assert.equal(t.ok, false);
  assert.equal(t.ok === false && t.code, "socket-timeout");
  assert.match(t.ok === false ? t.message : "", /50ms/);

  const broken = createPaneReader(
    { socketPath: "/tmp/s", timeoutMs: 50 },
    fakeConnector([{ kind: "error", message: "ECONNREFUSED" }]),
  );
  const b = await broken.readPane({ paneId: "wT:p2", source: "visible" });
  assert.equal(b.ok === false && b.code, "socket-error");
  assert.match(b.ok === false ? b.message : "", /ECONNREFUSED/);

  const garbage = createPaneReader(
    { socketPath: "/tmp/s", timeoutMs: 50 },
    fakeConnector([{ kind: "data", text: "not json" }]),
  );
  const g = await garbage.readPane({ paneId: "wT:p2", source: "visible" });
  assert.equal(g.ok === false && g.code, "herdr-bad-response");
});

test("interpretReadResponse: 完整 / 缺字段 / 错误信封三态", () => {
  const ok = interpretReadResponse(
    readResponse({
      text: "a\nb",
      revision: 3,
      truncated: true,
      pane_id: "wT:p2",
    }),
  );
  assert.deepEqual(ok, {
    ok: true,
    read: {
      paneId: "wT:p2",
      source: "",
      format: "text",
      text: "a\nb",
      revision: 3,
      truncated: true,
    },
  });
  const noText = interpretReadResponse(readResponse({ revision: 1 }));
  assert.equal(noText.ok === false && noText.code, "herdr-bad-response");
  const error = interpretReadResponse(
    JSON.stringify({
      id: "x",
      error: { code: "pane_not_found", message: "gone" },
    }),
  );
  assert.equal(error.ok === false && error.code, "socket-error");
  assert.match(error.ok === false ? error.message : "", /pane_not_found: gone/);
});

test("interpretReadResponse: 服务端未给 revision / truncated 时不虚构这两项", () => {
  const outcome = interpretReadResponse(readResponse({ text: "x" }));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.read.revision, undefined);
  assert.equal(outcome.ok && outcome.read.truncated, undefined);
});

test("waitForStable: revision 相同即判稳，basis=revision", async () => {
  const reader = fakeReader([
    readOk("line1", { revision: 1 }),
    readOk("line1", { revision: 1 }),
  ]);
  const clock = fakeClock();
  const outcome = await waitForStable(
    reader,
    { paneId: "wT:p2", source: "recent-unwrapped" },
    { settleMs: 400, timeoutMs: 5000 },
    clock,
  );
  assert.equal(outcome.stable, true);
  assert.equal(outcome.basis, "revision");
  assert.equal(outcome.text, "line1");
  assert.equal(outcome.revision, 1);
  assert.equal(clock.elapsed, 400);
  assert.equal(reader.calls.length, 2);
});

test("waitForStable: revision 持续变化不收敛 → 超时兜底 stable=false 且不抛错", async () => {
  let revision = 0;
  const reader = fakeReader(() => {
    revision += 1;
    return readOk(`line${revision}`, { revision });
  });
  const clock = fakeClock();
  const outcome = await waitForStable(
    reader,
    { paneId: "wT:p2", source: "visible" },
    { settleMs: 300, timeoutMs: 1000 },
    clock,
  );
  assert.equal(outcome.stable, false);
  assert.equal(outcome.basis, "revision");
  assert.equal(outcome.changes > 0, true);
  assert.equal(outcome.elapsedMs >= 600, true);
  assert.equal(clock.elapsed >= 600, true);
});

test("waitForStable: 服务端未给 revision 时回退文本比对", async () => {
  const reader = fakeReader([readOk("same"), readOk("same")]);
  const clock = fakeClock();
  const outcome = await waitForStable(
    reader,
    { paneId: "wT:p2", source: "visible" },
    { settleMs: 400, timeoutMs: 5000 },
    clock,
  );
  assert.equal(outcome.stable, true);
  assert.equal(outcome.basis, "text");
});

test("waitForStable: 读失败时返回 error（pane 不存在等），不抛错", async () => {
  const reader = fakeReader([readError("pane_not_found: gone")]);
  const outcome = await waitForStable(
    reader,
    { paneId: "wT:p9", source: "visible" },
    { settleMs: 400, timeoutMs: 1000 },
    fakeClock(),
  );
  assert.equal(outcome.stable, false);
  assert.equal(outcome.basis, "none");
  assert.match(outcome.error ?? "", /pane_not_found/);
});

test("waitForStable: 首次读取只作基线，不「一读就稳」", async () => {
  const reader = fakeReader([readOk("only-once", { revision: 9 })]);
  const outcome = await waitForStable(
    reader,
    { paneId: "wT:p2", source: "visible" },
    // 只留一次读取的预算：超时直接兜底
    { settleMs: 400, timeoutMs: 300 },
    fakeClock(),
  );
  assert.equal(outcome.stable, false);
  assert.equal(reader.calls.length, 1);
});
