/**
 * 围栏接入测试：策略解析四态、`confine` 三态、fail-closed 错误码、
 * 拒绝方言与运行器失败的判定语义。全部用替身，不需要真实沙箱后端。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SANDBOX_UNAVAILABLE,
  SandboxUnavailableError,
  classifyRunnerFailure,
  confineArgv,
  matchesSignature,
  resolveSandboxPolicy,
} from "../src/sandbox.ts";
import { fakePolicyService, fakeSandbox } from "./helpers.ts";

const READ_ONLY = { mode: "read-only", workspaceRoot: "/tmp" } as const;

test("策略解析：没有策略服务时如实标注不可用", () => {
  const outcome = resolveSandboxPolicy({}, undefined);
  assert.equal(outcome.policy, undefined);
  assert.ok(outcome.unavailable?.includes("ctx.sandboxPolicy"));
});

test("策略解析：策略抛错时降级标注，不炸装配", () => {
  const outcome = resolveSandboxPolicy(
    {
      sandboxPolicy: {
        resolve() {
          throw new Error("policy boom");
        },
      },
    },
    undefined,
  );
  assert.equal(outcome.policy, undefined);
  assert.ok(outcome.unavailable?.includes("策略解析失败"), outcome.unavailable);
  assert.ok(outcome.unavailable?.includes("policy boom"), outcome.unavailable);
});

test("策略解析：danger-full-access 不需要围栏服务", () => {
  const { service } = fakePolicyService({
    mode: "danger-full-access",
    workspaceRoot: "/tmp",
  });
  const outcome = resolveSandboxPolicy({ sandboxPolicy: service }, undefined);
  assert.equal(outcome.policy?.mode, "danger-full-access");
  assert.equal(outcome.unavailable, undefined);
});

test("策略解析：围栏模式缺 ctx.sandbox 时标注不可用（不围栏但不静默）", () => {
  const { service } = fakePolicyService(READ_ONLY);
  const outcome = resolveSandboxPolicy({ sandboxPolicy: service }, undefined);
  assert.equal(outcome.policy?.mode, "read-only");
  assert.ok(outcome.unavailable?.includes("ctx.sandbox"), outcome.unavailable);
});

test("策略解析：把会话原样交给策略服务，无会话时给空请求", () => {
  const { service, calls } = fakePolicyService({
    mode: "workspace-write",
    workspaceRoot: "/tmp",
  });
  const session = { id: "s1" };
  resolveSandboxPolicy(
    { sandboxPolicy: service, sandbox: fakeSandbox({ argv: [] }).provider },
    session,
  );
  resolveSandboxPolicy(
    { sandboxPolicy: service, sandbox: fakeSandbox({ argv: [] }).provider },
    undefined,
  );
  assert.deepEqual(calls[0], { session });
  assert.deepEqual(calls[1], {});
});

test("confine：danger-full-access 原样返回，不调 provider", async () => {
  const sandbox = fakeSandbox({ argv: ["/usr/bin/wrapped"] });
  const outcome = await confineArgv(
    ["python3", "-"],
    { sandbox: sandbox.provider },
    { mode: "danger-full-access", workspaceRoot: "/tmp" },
  );
  assert.deepEqual(outcome.argv, ["python3", "-"]);
  assert.equal(outcome.confined, undefined);
  assert.equal(sandbox.calls.length, 0);
});

test("confine：没有沙箱服务时原样返回", async () => {
  const outcome = await confineArgv(["python3", "-"], {}, READ_ONLY);
  assert.deepEqual(outcome.argv, ["python3", "-"]);
  assert.equal(outcome.confined, undefined);
});

test("confine：成功时用 provider 的 argv 并带回围栏事实", async () => {
  const confined = {
    argv: ["bwrap", "--", "python3", "-"],
    enforcement: "full" as const,
    denialSignatures: ["read-only file system"],
    runnerFailureRules: [],
  };
  const sandbox = fakeSandbox(confined);
  const policy = { mode: "read-only" as const, workspaceRoot: "/tmp" };
  const outcome = await confineArgv(
    ["python3", "-"],
    { sandbox: sandbox.provider },
    policy,
  );
  assert.deepEqual(outcome.argv, confined.argv);
  assert.deepEqual(outcome.confined, confined);
  assert.deepEqual(sandbox.calls[0]?.policy, policy);
});

test("confine：失败即 fail-closed，抛 SANDBOX_UNAVAILABLE", async () => {
  const sandbox = fakeSandbox(new Error("no usable runner"));
  await assert.rejects(
    confineArgv(
      ["python3", "-"],
      { sandbox: sandbox.provider },
      {
        mode: "workspace-write",
        workspaceRoot: "/tmp",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SandboxUnavailableError);
      assert.equal(error.code, SANDBOX_UNAVAILABLE);
      assert.equal(error.mode, "workspace-write");
      assert.ok(error.message.includes("no usable runner"), error.message);
      assert.ok(error.message.includes(SANDBOX_UNAVAILABLE), error.message);
      return true;
    },
  );
});

test("matchesSignature：只有非零退出且命中方言才算拒绝", () => {
  const signatures = ["read-only file system"];
  assert.equal(
    matchesSignature(
      1,
      "bash: cannot create: Read-Only File System",
      signatures,
    ),
    true,
  );
  assert.equal(matchesSignature(0, "read-only file system", signatures), false);
  assert.equal(
    matchesSignature(null, "read-only file system", signatures),
    false,
  );
  assert.equal(matchesSignature(1, "permission denied", signatures), false);
  assert.equal(matchesSignature(1, "read-only file system", []), false);
});

test("classifyRunnerFailure：退出码 0 永不算，allowedExitCodes 是门禁", () => {
  const rules = [{ allowedExitCodes: [125], fatalSignatures: ["bwrap: "] }];
  assert.equal(classifyRunnerFailure(0, "bwrap: oops", rules), undefined);
  assert.equal(classifyRunnerFailure(1, "bwrap: oops", rules), undefined);
  assert.deepEqual(classifyRunnerFailure(125, "bwrap: oops", rules), {
    detail: "bwrap: oops",
  });
  assert.equal(classifyRunnerFailure(125, "nothing here", rules), undefined);
  assert.equal(classifyRunnerFailure(1, "bwrap: oops", undefined), undefined);
});

test("classifyRunnerFailure：informationalLines 先按整行剔除，再匹配致命签名", () => {
  const rules = [
    {
      fatalSignatures: ["failed"],
      informationalLines: ["note: failed probes are informational"],
    },
  ];
  assert.equal(
    classifyRunnerFailure(1, "note: failed probes are informational", rules),
    undefined,
  );
  assert.deepEqual(classifyRunnerFailure(1, "sandbox runner failed", rules), {
    detail: "sandbox runner failed",
  });
});
