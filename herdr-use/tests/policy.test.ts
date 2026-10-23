import assert from "node:assert/strict";
import test from "node:test";

import {
  SANDBOX_WRITE_ACTIONS,
  isSandboxWrite,
  makeGuardChecker,
  makeSandboxModeReader,
  sandboxDenialReason,
} from "../src/policy.ts";

test("写类集合：create / label / text / key / run / close", () => {
  assert.deepEqual([...SANDBOX_WRITE_ACTIONS].sort(), [
    "close",
    "create",
    "key",
    "label",
    "run",
    "text",
  ]);
  for (const action of ["list", "read", "info", "wait"] as const) {
    assert.equal(isSandboxWrite(action), false, action);
  }
  for (const action of SANDBOX_WRITE_ACTIONS) {
    assert.equal(isSandboxWrite(action), true, action);
  }
});

test("sandboxDenialReason：只读拒写类，读类放行", () => {
  const denial = sandboxDenialReason("read-only", "herdr_run", "run", "wT1:p2");
  assert.ok(denial !== undefined);
  assert.match(denial, /read-only/);
  assert.match(denial, /herdr_run/);
  assert.match(denial, /wT1:p2/);
  assert.equal(
    sandboxDenialReason("read-only", "herdr_read", "read", "wT1:p2"),
    undefined,
  );
  assert.equal(
    sandboxDenialReason("workspace-write", "herdr_run", "run"),
    undefined,
  );
});

test("guard：缺服务 → skipped，只告警一次", () => {
  const warnings: string[] = [];
  const check = makeGuardChecker({}, (message) => warnings.push(message));
  const first = check("rm -rf /", "run");
  const second = check("ls", "run");
  assert.equal(first.outcome, "skipped");
  assert.equal(second.outcome, "skipped");
  assert.equal(warnings.length, 1);
});

test("guard：拦截串 → deny，null → pass", () => {
  const ctx = {
    get: (name: string) =>
      name === "guard"
        ? {
            inspectCommand: (text: string) =>
              text.includes("rm") ? "危险命令" : null,
          }
        : undefined,
  };
  const check = makeGuardChecker(ctx, () => undefined);
  assert.deepEqual(check("rm -rf /", "run"), {
    outcome: "deny",
    receipt: "危险命令",
  });
  assert.deepEqual(check("ls", "run"), { outcome: "pass" });
});

test("guard：调用抛错 → skipped（fail-open）", () => {
  const ctx = {
    get: () => ({
      inspectCommand: () => {
        throw new Error("boom");
      },
    }),
  };
  const check = makeGuardChecker(ctx, () => undefined);
  assert.equal(check("ls", "run").outcome, "skipped");
});

test("sandboxMode：缺服务 / 抛错 → undefined（放行），只告警一次", () => {
  const warnings: string[] = [];
  const missing = makeSandboxModeReader({}, (m) => warnings.push(m));
  assert.equal(missing(undefined), undefined);
  assert.equal(missing(undefined), undefined);
  assert.equal(warnings.length, 1);

  const throwing = makeSandboxModeReader(
    {
      get: () => ({
        resolve: () => {
          throw new Error("nope");
        },
      }),
    },
    () => undefined,
  );
  assert.equal(throwing(undefined), undefined);
});

test("sandboxMode：解析合法模式", () => {
  const ctx = {
    get: () => ({
      resolve: (request?: { session?: unknown }) =>
        request?.session === "read"
          ? { mode: "read-only" }
          : { mode: "workspace-write" },
    }),
  };
  const reader = makeSandboxModeReader(ctx, () => undefined);
  assert.equal(reader("read"), "read-only");
  assert.equal(reader("write"), "workspace-write");
  assert.equal(reader("weird"), "workspace-write");
});

test("sandboxMode：未知模式值按无法判定处理", () => {
  const ctx = { get: () => ({ resolve: () => ({ mode: "yolo" }) }) };
  const reader = makeSandboxModeReader(ctx, () => undefined);
  assert.equal(reader(undefined), undefined);
});
