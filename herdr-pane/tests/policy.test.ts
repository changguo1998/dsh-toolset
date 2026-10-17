/**
 * tests/policy.test.ts — 归属判定、审批三档与 guard 复查的 fail-open 口径
 *
 * 三闸的语义（设计文档决策项 10 / 11）：
 *   ① guard 复查：`null` 放行 / 非空字符串拦截 / 服务缺失或抛错 fail-open（**每种失效模式只告警一次**）；
 *   ② 登记表：跨包，本包只验证入口参数面（`recommendedRegistration`）；
 *   ③ 审批：`foreign` 缺省只对非自有 pane 的输入 / 关闭打断，`always` / `never` 为全局档。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OWNED_ACTIONS,
  READONLY_ACTIONS,
  checkOwnership,
  isOwnedAction,
  isReadonlyAction,
  makeGuardChecker,
  needsApproval,
  ownershipDeniedHint,
  readService,
} from "../src/policy.ts";

test("动作分类: 写类 = send_text / send_keys / run / label / close；读类 = read / info", () => {
  assert.deepEqual(
    [...OWNED_ACTIONS].sort(),
    ["close", "label", "run", "send_keys", "send_text"].sort(),
  );
  assert.deepEqual([...READONLY_ACTIONS].sort(), ["info", "read"]);
  assert.equal(isOwnedAction("run"), true);
  assert.equal(isOwnedAction("read"), false);
  assert.equal(isReadonlyAction("read"), true);
  assert.equal(isReadonlyAction("create"), false);
});

test("checkOwnership: 写类动作对未登记 pane 拒绝，读类放行", () => {
  const isRegistered = (id: string): boolean => id === "wT1:p2";
  for (const action of OWNED_ACTIONS) {
    const own = checkOwnership(action, "wT1:p2", isRegistered);
    assert.equal(own.allowed, true, action);
    assert.equal(own.allowed && own.ownership, "registered");
    const foreign = checkOwnership(action, "wT1:p9", isRegistered);
    assert.equal(foreign.allowed, false, action);
    assert.equal(
      foreign.allowed === false && foreign.reason,
      "pane-not-registered",
    );
  }
  for (const action of READONLY_ACTIONS) {
    const foreign = checkOwnership(action, "wT1:p9", isRegistered);
    assert.equal(foreign.allowed, true, action);
    assert.equal(foreign.allowed && foreign.ownership, "foreign");
  }
});

test("checkOwnership: wait 只在 stable 模式按写类要求归属", () => {
  const isRegistered = (): boolean => false;
  assert.equal(
    checkOwnership("wait", "wT1:p9", isRegistered, { waitStable: false })
      .allowed,
    true,
  );
  assert.equal(
    checkOwnership("wait", "wT1:p9", isRegistered, { waitStable: true })
      .allowed,
    false,
  );
});

test("needsApproval: foreign 档只对非自有 pane 的输入 / 关闭要求审批", () => {
  // 输入 / 关闭 + 非自有 → 要审批
  for (const action of ["send_text", "send_keys", "run", "close"] as const) {
    assert.equal(needsApproval(action, "foreign", "foreign"), true, action);
    assert.equal(needsApproval(action, "registered", "foreign"), false, action);
  }
  // label 只改自己的标记，不打断人
  assert.equal(needsApproval("label", "foreign", "foreign"), false);
  // 建 pane / 读屏不弹审批
  assert.equal(needsApproval("create", "foreign", "foreign"), false);
  assert.equal(needsApproval("read", "foreign", "foreign"), false);
  assert.equal(needsApproval("info", "foreign", "foreign"), false);
});

test("needsApproval: always 档任何输入 / 关闭都审批；never 档从不审批", () => {
  for (const action of ["send_text", "send_keys", "run", "close"] as const) {
    assert.equal(needsApproval(action, "registered", "always"), true, action);
    assert.equal(needsApproval(action, "registered", "never"), false, action);
    assert.equal(needsApproval(action, "foreign", "never"), false, action);
  }
  // always 档也不对建 pane / 读屏弹审批
  assert.equal(needsApproval("create", "registered", "always"), false);
  assert.equal(needsApproval("read", "registered", "always"), false);
});

test("ownershipDeniedHint: 含可操作放行方式（create 自建 / allowForeignPanes）", () => {
  const hint = ownershipDeniedHint();
  assert.match(hint, /create/);
  assert.match(hint, /allowForeignPanes/);
});

test("readService: 服务缺失 / get 抛错都返回 undefined（不把异常抛给调用方）", () => {
  assert.equal(readService({}, "guard"), undefined);
  assert.equal(readService(undefined, "guard"), undefined);
  assert.deepEqual(readService({ get: () => ({ a: 1 }) }, "guard"), { a: 1 });
  assert.equal(
    readService(
      {
        get: () => {
          throw new Error("boom");
        },
      },
      "guard",
    ),
    undefined,
  );
});

test("makeGuardChecker: null / undefined / 空串放行，非空字符串拦截", () => {
  const warn = (): void => {};
  const pass = makeGuardChecker(
    { get: () => ({ inspectCommand: () => null }) },
    warn,
  );
  assert.deepEqual(pass("rm -rf /", "run"), { outcome: "pass" });

  const undefinedVerdict = makeGuardChecker(
    { get: () => ({ inspectCommand: () => undefined }) },
    warn,
  );
  assert.equal(undefinedVerdict("x", "run").outcome, "pass");

  const empty = makeGuardChecker(
    { get: () => ({ inspectCommand: () => "" }) },
    warn,
  );
  assert.equal(empty("x", "run").outcome, "pass");

  const deny = makeGuardChecker(
    {
      get: () => ({
        inspectCommand: (command: string, source?: string) =>
          `[security-guard] 拦截 ${command}（source=${source}）`,
      }),
    },
    warn,
  );
  const verdict = deny("sudo ls /", "run");
  assert.equal(verdict.outcome, "deny");
  assert.match(verdict.receipt ?? "", /sudo ls \//);
  assert.match(verdict.receipt ?? "", /herdr-pane:run/, "来源标注含动作名");
});

test("makeGuardChecker: 服务缺失 fail-open 且只告警一次", () => {
  const warnings: string[] = [];
  const check = makeGuardChecker({}, (message) => warnings.push(message));
  const first = check("a", "run");
  const second = check("b", "run");
  assert.equal(first.outcome, "skipped");
  assert.match(first.reason ?? "", /guard 服务不可用/);
  assert.equal(second.outcome, "skipped");
  assert.equal(warnings.length, 1, "同一失效模式只告警一次，不刷屏");
});

test("makeGuardChecker: 复查抛错 fail-open 且只告警一次", () => {
  const warnings: string[] = [];
  const service = {
    inspectCommand: () => {
      throw new Error("inspect boom");
    },
  };
  const check = makeGuardChecker({ get: () => service }, (message) =>
    warnings.push(message),
  );
  assert.equal(check("a", "run").outcome, "skipped");
  assert.equal(check("b", "run").outcome, "skipped");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /fail-open/);
});

test("makeGuardChecker: 惰性解析（每次调用重新读服务，挂载顺序无关）", () => {
  let service:
    | { inspectCommand?: (command: string, source?: string) => string | null }
    | undefined;
  const check = makeGuardChecker(
    {
      get: () => service,
    },
    () => {},
  );
  assert.equal(check("x", "run").outcome, "skipped");
  service = { inspectCommand: () => "[security-guard] deny" };
  assert.equal(check("x", "run").outcome, "deny");
});
