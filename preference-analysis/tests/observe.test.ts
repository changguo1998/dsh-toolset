import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Observer,
  approvalText,
  commandHead,
  messageText,
  paramHead,
  pathHead,
  sourceKind,
  type Observation,
} from "../src/observe.ts";
import { normalizeKey } from "../src/induce.ts";

function userEvent(
  text: string,
  options: { sourceKind?: string; time?: number } = {},
): Record<string, unknown> {
  return {
    type: "user/message",
    time: options.time ?? 1_000,
    data: {
      message: {
        content: [{ type: "text", text }],
        ...(options.sourceKind === undefined
          ? {}
          : { source: { kind: options.sourceKind } }),
      },
    },
  };
}

function evidences(observations: Observation[]): Array<{
  text: string;
  weight: number;
  key?: string;
  origin: string;
}> {
  return observations
    .filter(
      (item): item is Extract<Observation, { kind: "evidence" }> =>
        item.kind === "evidence",
    )
    .map((item) => ({
      text: item.evidence.text,
      weight: item.evidence.weight,
      origin: item.evidence.origin,
      ...(item.evidence.key === undefined ? {} : { key: item.evidence.key }),
    }));
}

test("S1：user/message 抽出约束句作为证据（排除 rule-engine 注入）", () => {
  const observer = new Observer();
  const out = observer.handle(
    "s1",
    "/p",
    userEvent("先看下表。以后不要用 emoji，请记住。"),
  );
  assert.deepEqual(evidences(out), [
    { text: "以后不要用 emoji，请记住", weight: 1, origin: "user" },
  ]);
  assert.equal(observer.stats.constraints, 1);
  // 注入消息不参与观测
  assert.deepEqual(
    observer.handle(
      "s1",
      "/p",
      userEvent("不要用 emoji", { sourceKind: "rule-engine" }),
    ),
    [],
  );
  // 空正文 / 无标记正文都不产出
  assert.deepEqual(observer.handle("s1", "/p", userEvent("   ")), []);
  assert.deepEqual(observer.handle("s1", "/p", userEvent("把代码格式化")), []);
});

test("S2：上一回合被打断 -> 下一条约束权重 x1.5，且只消费一次", () => {
  const observer = new Observer();
  observer.handle("s1", "/p", {
    type: "turn/end",
    data: { reason: { type: "aborted", reason: "user" } },
  });
  const first = evidences(
    observer.handle("s1", "/p", userEvent("不要用 emoji")),
  );
  assert.equal(first[0]?.weight, 1.5);
  const second = evidences(
    observer.handle("s1", "/p", userEvent("不要用 emoji")),
  );
  assert.equal(second[0]?.weight, 1, "打断标记只作用于紧随其后的用户消息");
});

test("S2：消息自带纠正词同样加权；纠正里没有约束句只记未成形观察", () => {
  const observer = new Observer();
  const corrected = evidences(
    observer.handle("s1", "/p", userEvent("不对，我说的是不要用 emoji")),
  );
  assert.equal(corrected[0]?.weight, 1.5);
  const unformed = observer.handle("s1", "/p", userEvent("不对，重新来一遍"));
  assert.deepEqual(unformed, [
    { kind: "unformed", sessionId: "s1", at: 1_000 },
  ]);
  assert.equal(observer.stats.unformed, 1);
  assert.equal(observer.stats.constraints, 1);
});

test("S3：审批拒绝按 id 配对并取 callId 参数首段，产出指纹证据", () => {
  const observer = new Observer();
  observer.handle("s1", "/p", {
    type: "tool/call",
    time: 2_000,
    data: {
      name: "bash",
      callId: "call_1",
      arguments: JSON.stringify({ command: "sudo rm -rf /tmp/x" }),
    },
  });
  observer.handle("s1", "/p", {
    type: "approval/asked",
    time: 2_001,
    data: { id: "ap_1", toolName: "bash", callId: "call_1" },
  });
  const out = observer.handle("s1", "/p", {
    type: "approval/decided",
    time: 2_002,
    data: { id: "ap_1", outcome: "rejected" },
  });
  assert.deepEqual(evidences(out), [
    {
      text: approvalText("bash", "rm"),
      weight: 1,
      origin: "approval",
      key: normalizeKey("bash:rm"),
    },
  ]);
  assert.equal(observer.stats.approvals, 1);
  // 同一个 id 再决定一次：配对已消费，按忽略计
  assert.deepEqual(
    observer.handle("s1", "/p", {
      type: "approval/decided",
      data: { id: "ap_1", outcome: "rejected" },
    }),
    [],
  );
  assert.equal(observer.stats.ignoredApprovals, 1);
});

test("S3：非 rejected、缺参数归因都忽略", () => {
  const observer = new Observer();
  observer.handle("s1", "/p", {
    type: "approval/asked",
    data: { id: "ap_1", toolName: "bash", callId: "missing" },
  });
  assert.deepEqual(
    observer.handle("s1", "/p", {
      type: "approval/decided",
      data: { id: "ap_1", outcome: "allowed-once" },
    }),
    [],
  );
  observer.handle("s1", "/p", {
    type: "approval/asked",
    data: { id: "ap_2", toolName: "write", callId: "no-args" },
  });
  assert.deepEqual(
    observer.handle("s1", "/p", {
      type: "approval/decided",
      data: { id: "ap_2", outcome: "rejected" },
    }),
    [],
  );
  assert.equal(observer.stats.ignoredApprovals, 2);
  assert.equal(observer.stats.approvals, 0);
});

test("paramHead：命令跳环境变量 / sudo，路径取 basename，URL 取主机名", () => {
  assert.equal(paramHead(JSON.stringify({ command: "rm -rf /tmp/x" })), "rm");
  assert.equal(
    paramHead(JSON.stringify({ command: "FOO=1 sudo git push origin main" })),
    "git",
  );
  assert.equal(paramHead({ file_path: "/home/u/.env" }), ".env");
  assert.equal(paramHead({ path: "src/app/main.ts" }), "main.ts");
  assert.equal(
    paramHead({ url: "https://example.com/a/b?q=1" }),
    "example.com",
  );
  assert.equal(paramHead({ pattern: "TODO" }), "TODO");
  assert.equal(paramHead("ls | wc -l"), "ls");
  assert.equal(paramHead({}), undefined);
  assert.equal(paramHead("   "), undefined);
  assert.equal(commandHead("   "), undefined);
  assert.equal(pathHead("  "), undefined);
});

test("messageText / sourceKind：内容块拼接与来源 kind", () => {
  const message = {
    content: [
      { type: "text", text: "第一段" },
      { type: "image", url: "x" },
      { type: "text", text: "第二段" },
    ],
    source: { kind: "user" },
  };
  assert.equal(messageText(message), "第一段第二段");
  assert.equal(sourceKind(message), "user");
  assert.equal(messageText(null), "");
  assert.equal(messageText({ content: "x" }), "");
  assert.equal(sourceKind({}), undefined);
});

test("事件时间优先于注入时钟；畸形事件安全跳过", () => {
  const observer = new Observer({ now: () => 9_999 });
  const [item] = observer.handle("s1", "/p", userEvent("不要用 emoji"));
  assert.equal(item?.kind, "evidence");
  assert.equal(item?.kind === "evidence" ? item.evidence.at : 0, 1_000);
  assert.deepEqual(observer.handle("", "/p", userEvent("不要用 emoji")), []);
  assert.deepEqual(observer.handle("s1", "/p", null), []);
  assert.deepEqual(observer.handle("s1", "/p", { type: 42 }), []);
});
