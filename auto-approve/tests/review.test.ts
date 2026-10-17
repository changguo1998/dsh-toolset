import assert from "node:assert/strict";
import test from "node:test";

import {
  createReviewer,
  parseReviewDecision,
  readReviewText,
  renderReviewText,
  ReviewFailure,
  runReview,
  REVIEW_POLICY,
  type Reviewer,
  type StreamChunkLike,
} from "../src/review.ts";
import { resolveConfig } from "../src/config.ts";
import { createFakeLlm, reviewChunks } from "./fakes.ts";

test("renderReviewText：四段结构与「ENVIRONMENT 只有 cwd」", () => {
  const text = renderReviewText({
    toolName: "bash",
    arguments: { command: "npm test" },
    cwd: "/w",
    history: [
      { role: "human-instruction", kind: "user-message", text: "跑测试" },
    ],
    projectInstructions: [{ source: "/w/AGENTS.md", text: "中文回复" }],
    escalationTarget: "workspace-write",
    reason: "escalate sandbox to workspace-write: x",
  });
  const sections = text.split("\n\n").filter((part) => part.length > 0);
  assert.deepEqual(
    sections.filter((part) => /^[A-Z_]+$/.test(part)),
    [
      "ENVIRONMENT",
      "PROJECT_INSTRUCTIONS",
      "FILTERED_HISTORY",
      "PENDING_ACTION",
    ],
  );
  assert.match(text, /ENVIRONMENT\n\n\{"cwd":"\/w"\}/);
  assert.match(text, /PENDING_ACTION\n\n\{"tool":"bash"/);
  assert.match(text, /"escalationTarget":"workspace-write"/);
  assert.match(text, /"askReason":"escalate sandbox to workspace-write: x"/);
  assert.match(text, /"role":"human-instruction"/);
  assert.match(text, /"source":"\/w\/AGENTS\.md"/);
  // 不含环境变量、不含宿主提示词之外的内容
  assert.equal(/process\.env|PATH=|HOME=/.test(text), false);
});

test("readReviewText：正常流拼出文本；缺 finish / finish 后仍有输出 / 报错结束都失败", async () => {
  async function* stream(chunks: readonly StreamChunkLike[]) {
    for (const chunk of chunks) yield chunk;
  }
  assert.equal(
    await readReviewText(
      stream([
        { type: "reasoning-delta", index: 0, text: "想一下" },
        { type: "text-delta", index: 1, text: '{"risk":"low",' },
        { type: "text-delta", index: 1, text: '"decision":"allow"}' },
        { type: "finish", reason: { kind: "stop" } },
      ]),
    ),
    '{"risk":"low","decision":"allow"}',
  );
  await assert.rejects(
    () => readReviewText(stream([{ type: "text-delta", index: 0, text: "x" }])),
    ReviewFailure,
  );
  await assert.rejects(
    () =>
      readReviewText(
        stream([
          { type: "text-delta", index: 0, text: "x" },
          { type: "finish", reason: { kind: "stop" } },
          { type: "text-delta", index: 0, text: "y" },
        ]),
      ),
    ReviewFailure,
  );
  await assert.rejects(
    () =>
      readReviewText(
        stream([
          {
            type: "finish",
            reason: {
              kind: "error",
              failure: { code: "AUTH", message: "no key" },
            },
          },
        ]),
      ),
    /no key/,
  );
  await assert.rejects(
    () =>
      readReviewText(stream([{ type: "finish", reason: { kind: "length" } }])),
    ReviewFailure,
  );
});

test("runReview：超时中止（不静默放行，抛 ReviewFailure 之前的 abort 由调用方兜底）", async () => {
  const hanging: Reviewer = {
    route: () => ({ provider: "p", model: "m" }),
    review: (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () =>
          reject(new ReviewFailure("aborted")),
        );
      }),
  };
  await assert.rejects(
    () =>
      runReview(
        hanging,
        {
          toolName: "bash",
          arguments: {},
          cwd: "/w",
          history: [],
          projectInstructions: [],
        },
        30,
      ),
    ReviewFailure,
  );
});

test("createReviewer：缺省跟随会话路由，配置覆盖优先；llm 缺失即失败", async () => {
  const llm = createFakeLlm(
    reviewChunks('{"risk":"medium","decision":"allow"}'),
  );
  const config = resolveConfig({ mode: "rules+llm" });
  const reviewer = createReviewer({
    llm,
    config,
    route: () => ({ provider: "sess", model: "sess-model" }),
  });
  const decision = await reviewer.review({
    toolName: "bash",
    arguments: { command: "ls" },
    cwd: "/w",
    history: [],
    projectInstructions: [],
  });
  assert.deepEqual(decision, {
    risk: "medium",
    decision: "allow",
    model: "sess/sess-model",
  });
  assert.equal(llm.calls[0]?.provider, "sess");
  assert.equal(llm.calls[0]?.temperature, 0);
  assert.equal(llm.calls[0]?.system, REVIEW_POLICY);

  const overridden = createReviewer({
    llm,
    config: resolveConfig({
      mode: "rules+llm",
      review: { provider: "p2", model: "m2" },
    }),
    route: () => ({ provider: "sess", model: "sess-model" }),
  });
  assert.deepEqual(overridden.route(), { provider: "p2", model: "m2" });
  await overridden.review({
    toolName: "bash",
    arguments: {},
    cwd: "/w",
    history: [],
    projectInstructions: [],
  });
  assert.equal(llm.calls[1]?.provider, "p2");

  const missing = createReviewer({
    llm: undefined,
    config,
    route: () => undefined,
  });
  await assert.rejects(
    () =>
      missing.review({
        toolName: "bash",
        arguments: {},
        cwd: "/w",
        history: [],
        projectInstructions: [],
      }),
    /llm 服务不可用/,
  );
  const noRoute = createReviewer({ llm, config, route: () => undefined });
  await assert.rejects(
    () =>
      noRoute.review({
        toolName: "bash",
        arguments: {},
        cwd: "/w",
        history: [],
        projectInstructions: [],
      }),
    /无法确定审查模型路由/,
  );
});

test("createReviewer：非法输出按失败处理（不猜）", async () => {
  const llm = createFakeLlm(reviewChunks('{"risk":"high","decision":"allow"}'));
  const reviewer = createReviewer({
    llm,
    config: resolveConfig({ mode: "rules+llm" }),
    route: () => ({ provider: "p", model: "m" }),
  });
  await assert.rejects(
    () =>
      reviewer.review({
        toolName: "bash",
        arguments: {},
        cwd: "/w",
        history: [],
        projectInstructions: [],
      }),
    ReviewFailure,
  );
});

test("parseReviewDecision：拒绝形态可带 reason，成员数与取值封闭", () => {
  assert.deepEqual(
    parseReviewDecision('{"risk":"high","decision":"deny","reason":"泄露"}'),
    {
      risk: "high",
      decision: "deny",
      reason: "泄露",
    },
  );
});
