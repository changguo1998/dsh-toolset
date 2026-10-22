/**
 * tests/policy.test.ts — 归属判定、审批三档与 guard 复查的 fail-open 口径
 *
 *   ③ 审批：`foreign` 缺省只对非自有 pane 的输入 / 关闭打断，`always` / `never` 为全局档；
 *   ④ 沙箱：只读会话的写类动作拒绝（文案含模式与切换方式），模式不可判时 fail-open。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OWNED_ACTIONS,
  READONLY_ACTIONS,
  SANDBOX_WRITE_ACTIONS,
  checkOwnership,
  crossWorkspaceDenialReason,
  isOwnedAction,
  isReadonlyAction,
  isSandboxWrite,
  makeGuardChecker,
  makeSandboxModeReader,
  needsApproval,
  ownershipDeniedHint,
  readService,
  sandboxDenialReason,
} from "../src/policy.ts";

test("动作分类: 写类 = pane_send_text / pane_send_keys / pane_run / pane_label / pane_close / tab_close；读类 = pane_read / pane_info", () => {
  assert.deepEqual(
    [...OWNED_ACTIONS].sort(),
    [
      "pane_close",
      "pane_label",
      "pane_run",
      "pane_send_keys",
      "pane_send_text",
      "tab_close",
    ].sort(),
  );
  assert.deepEqual([...READONLY_ACTIONS].sort(), ["pane_info", "pane_read"]);
  assert.equal(isOwnedAction("pane_run"), true);
  assert.equal(isOwnedAction("tab_close"), true);
  assert.equal(isOwnedAction("tab_create"), false);
  assert.equal(isOwnedAction("pane_read"), false);
  assert.equal(isReadonlyAction("pane_read"), true);
  assert.equal(isReadonlyAction("pane_create"), false);
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

test("checkOwnership: pane_wait 只在 stable 模式按写类要求归属", () => {
  const isRegistered = (): boolean => false;
  assert.equal(
    checkOwnership("pane_wait", "wT1:p9", isRegistered, { waitStable: false })
      .allowed,
    true,
  );
  assert.equal(
    checkOwnership("pane_wait", "wT1:p9", isRegistered, { waitStable: true })
      .allowed,
    false,
  );
});

test("needsApproval: foreign 档只对非自有 pane 的输入 / 关闭要求审批", () => {
  // 输入 / 关闭 + 非自有 → 要审批
  for (const action of [
    "pane_send_text",
    "pane_send_keys",
    "pane_run",
    "pane_close",
  ] as const) {
    assert.equal(needsApproval(action, "foreign", "foreign"), true, action);
    assert.equal(needsApproval(action, "registered", "foreign"), false, action);
  }
  // label 只改自己的标记，不打断人
  assert.equal(needsApproval("pane_label", "foreign", "foreign"), false);
  // 建 pane / 建 tab / 读屏不弹审批
  assert.equal(needsApproval("pane_create", "foreign", "foreign"), false);
  assert.equal(needsApproval("tab_create", "foreign", "foreign"), false);
  assert.equal(needsApproval("tab_list", "foreign", "foreign"), false);
  assert.equal(needsApproval("pane_read", "foreign", "foreign"), false);
  assert.equal(needsApproval("pane_info", "foreign", "foreign"), false);
  // tab_close 与 close 同档：非本插件登记的 tab 要打断人
  assert.equal(needsApproval("tab_close", "foreign", "foreign"), true);
  assert.equal(needsApproval("tab_close", "registered", "foreign"), false);
  assert.equal(needsApproval("tab_close", "registered", "always"), true);
  assert.equal(needsApproval("tab_close", "foreign", "never"), false);
});

test("needsApproval: always 档任何输入 / 关闭都审批；never 档从不审批", () => {
  for (const action of [
    "pane_send_text",
    "pane_send_keys",
    "pane_run",
    "pane_close",
  ] as const) {
    assert.equal(needsApproval(action, "registered", "always"), true, action);
    assert.equal(needsApproval(action, "registered", "never"), false, action);
    assert.equal(needsApproval(action, "foreign", "never"), false, action);
  }
  // always 档也不对建 pane / 读屏弹审批
  assert.equal(needsApproval("pane_create", "registered", "always"), false);
  assert.equal(needsApproval("pane_read", "registered", "always"), false);
});

test("crossWorkspaceDenialReason: 说明写操作不出本会话 workspace，且不暴露 workspace id", () => {
  const reason = crossWorkspaceDenialReason("wT9:t1");
  assert.match(reason, /wT9:t1/);
  assert.match(reason, /不属于本会话的 workspace/);
  assert.match(reason, /tab_create/);
  assert.match(reason, /模型侧没有 workspace 参数/);
  assert.equal(/workspace wT|label=/.test(reason), false);
});

test("ownershipDeniedHint: 含可操作放行方式（pane_create 自建 / allowForeignPanes）", () => {
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
  assert.deepEqual(pass("rm -rf /", "pane_run"), { outcome: "pass" });

  const undefinedVerdict = makeGuardChecker(
    { get: () => ({ inspectCommand: () => undefined }) },
    warn,
  );
  assert.equal(undefinedVerdict("x", "pane_run").outcome, "pass");

  const empty = makeGuardChecker(
    { get: () => ({ inspectCommand: () => "" }) },
    warn,
  );
  assert.equal(empty("x", "pane_run").outcome, "pass");

  const deny = makeGuardChecker(
    {
      get: () => ({
        inspectCommand: (command: string, source?: string) =>
          `[security-guard] 拦截 ${command}（source=${source}）`,
      }),
    },
    warn,
  );
  const verdict = deny("sudo ls /", "pane_run");
  assert.equal(verdict.outcome, "deny");
  assert.match(verdict.receipt ?? "", /sudo ls \//);
  assert.match(verdict.receipt ?? "", /herdr-use:pane_run/, "来源标注含动作名");
});

test("makeGuardChecker: 服务缺失 fail-open 且只告警一次", () => {
  const warnings: string[] = [];
  const check = makeGuardChecker({}, (message) => warnings.push(message));
  const first = check("a", "pane_run");
  const second = check("b", "pane_run");
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
  assert.equal(check("a", "pane_run").outcome, "skipped");
  assert.equal(check("b", "pane_run").outcome, "skipped");
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
  assert.equal(check("x", "pane_run").outcome, "skipped");
  service = { inspectCommand: () => "[security-guard] deny" };
  assert.equal(check("x", "pane_run").outcome, "deny");
});

test("沙箱写类集合: 输入 / 关闭（含 tab_close）+ stable 模式的 pane_wait；pane_label 与 pane_create 不在内", () => {
  assert.deepEqual(
    [...SANDBOX_WRITE_ACTIONS].sort(),
    [
      "pane_close",
      "pane_run",
      "pane_send_keys",
      "pane_send_text",
      "tab_close",
    ].sort(),
  );
  for (const action of [
    "pane_send_text",
    "pane_send_keys",
    "pane_run",
    "pane_close",
    "tab_close",
  ] as const) {
    assert.equal(isSandboxWrite(action), true, action);
  }
  for (const action of [
    "pane_create",
    "pane_list",
    "pane_read",
    "pane_label",
    "pane_info",
    "tab_create",
    "tab_list",
  ] as const) {
    assert.equal(isSandboxWrite(action), false, action);
  }
  assert.equal(isSandboxWrite("pane_wait", false), false);
  assert.equal(isSandboxWrite("pane_wait", true), true);
});

test("sandboxDenialReason: 只在只读会话的写类动作上产出文案", () => {
  const denied = sandboxDenialReason("read-only", "pane_run", "wT1:p9");
  assert.notEqual(denied, undefined);
  assert.match(denied ?? "", /read-only/);
  assert.match(denied ?? "", /run/);
  assert.match(denied ?? "", /wT1:p9/);
  assert.match(denied ?? "", /\/permission/, "文案给切换方式");

  // 只读但读类 / 标记类：不拦
  assert.equal(
    sandboxDenialReason("read-only", "pane_read", "wT1:p9"),
    undefined,
  );
  assert.equal(
    sandboxDenialReason("read-only", "pane_info", "wT1:p9"),
    undefined,
  );
  assert.equal(
    sandboxDenialReason("read-only", "pane_label", "wT1:p9"),
    undefined,
  );
  assert.equal(
    sandboxDenialReason("read-only", "pane_create", "wT1:p9"),
    undefined,
  );
  // tab_close 按 tab 措辞；tab_create 不拦
  assert.match(
    sandboxDenialReason("read-only", "tab_close", "wT1:t2") ?? "",
    /目标 tab wT1:t2/,
  );
  assert.equal(
    sandboxDenialReason("read-only", "tab_create", "wT1:t2"),
    undefined,
  );
  // wait：stable 拦，match 不拦
  assert.notEqual(
    sandboxDenialReason("read-only", "pane_wait", "wT1:p9", true),
    undefined,
  );
  assert.equal(
    sandboxDenialReason("read-only", "pane_wait", "wT1:p9", false),
    undefined,
  );
  // 可写模式一律不拦
  for (const mode of ["workspace-write", "danger-full-access"] as const) {
    assert.equal(
      sandboxDenialReason(mode, "pane_run", "wT1:p9"),
      undefined,
      mode,
    );
    assert.equal(
      sandboxDenialReason(mode, "pane_close", "wT1:p9"),
      undefined,
      mode,
    );
  }
});

test("makeSandboxModeReader: 读宿主 resolve 的 mode；无会话时传空请求", () => {
  const requests: unknown[] = [];
  const reader = makeSandboxModeReader(
    {
      get: () => ({
        resolve: (request?: unknown) => {
          requests.push(request);
          return { mode: "read-only", workspaceRoot: "/w" };
        },
      }),
    },
    () => {},
  );
  const session = { id: "s1" };
  assert.equal(reader(session), "read-only");
  assert.deepEqual(requests[0], { session });
  assert.equal(reader(undefined), "read-only");
  assert.deepEqual(requests[1], {}, "无会话时按部署缺省解析（宿主口径）");
});

test("makeSandboxModeReader: 封闭词汇之外的值 / 形状不符按无法判定", () => {
  const modes: unknown[] = [{ mode: "weird" }, { mode: undefined }, null, {}];
  for (const value of modes) {
    const reader = makeSandboxModeReader(
      { get: () => ({ resolve: () => value }) },
      () => {},
    );
    assert.equal(reader({}), undefined, String(value));
  }
  // resolve 不是函数（服务形状不符）
  assert.equal(
    makeSandboxModeReader({ get: () => ({}) }, () => {})({}),
    undefined,
  );
});

test("makeSandboxModeReader: 服务缺失 fail-open 且只告警一次", () => {
  const warnings: string[] = [];
  const reader = makeSandboxModeReader({}, (message) => warnings.push(message));
  assert.equal(reader({}), undefined);
  assert.equal(reader({}), undefined);
  assert.equal(warnings.length, 1, "同一失效模式只告警一次");
  assert.match(warnings[0] ?? "", /fail-open/);
});

test("makeSandboxModeReader: 解析抛错 fail-open 且只告警一次", () => {
  const warnings: string[] = [];
  const reader = makeSandboxModeReader(
    {
      get: () => ({
        resolve: () => {
          throw new Error("resolve boom");
        },
      }),
    },
    (message) => warnings.push(message),
  );
  assert.equal(reader({}), undefined);
  assert.equal(reader({}), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /resolve boom/);
});

test("makeSandboxModeReader: 惰性解析（先挂载后生效）", () => {
  let service: { resolve?: () => unknown } | undefined;
  const reader = makeSandboxModeReader({ get: () => service }, () => {});
  assert.equal(reader({}), undefined);
  service = { resolve: () => ({ mode: "workspace-write" }) };
  assert.equal(reader({}), "workspace-write");
});
