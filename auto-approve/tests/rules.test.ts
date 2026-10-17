import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/config.ts";
import {
  checkCommandAllow,
  checkDenyEscalation,
  checkDenyTools,
  checkEscalationAllow,
  checkPathAllow,
  checkReadonly,
  commandOf,
  denialReason,
  isBypassed,
  isGatedOut,
  needsArguments,
  pathsOf,
} from "../src/rules.ts";
import type { CallInfo } from "../src/types.ts";

function call(name: string, args: unknown, cwd = "/w"): CallInfo {
  return { callId: `c-${name}`, name, arguments: args, cwd, sessionId: "s1" };
}

test("拒绝名单：工具名精确与 `*` 前缀通配；未命中返回 undefined", () => {
  const config = resolveConfig({ deny: { tools: ["mcp__*", "run_code"] } });
  assert.equal(checkDenyTools(config, "bash"), undefined);
  const hit = checkDenyTools(config, "mcp__figma__get");
  assert.equal(hit?.outcome, "rejected");
  assert.equal(hit?.source, "rule");
  assert.match(hit?.reason ?? "", /auto-approve 拒绝了工具 "mcp__figma__get"/);
  assert.equal(checkDenyTools(config, "run_code")?.outcome, "rejected");
});

test("拒绝名单：升级目标档命中即拒（优先于升级白名单）", () => {
  const config = resolveConfig({ deny: { escalation: { to: ["danger-full-access"] } } });
  assert.equal(checkDenyEscalation(config, "bash", "danger-full-access")?.outcome, "rejected");
  assert.equal(checkDenyEscalation(config, "bash", "workspace-write"), undefined);
  assert.equal(checkDenyEscalation(config, "bash", undefined), undefined);
});

test("只读类：按工具名放行；不含 bash", () => {
  const config = resolveConfig(undefined);
  assert.equal(checkReadonly(config, "read")?.source, "readonly");
  assert.equal(checkReadonly(config, "grep")?.ruleId, "readonly:grep");
  assert.equal(checkReadonly(config, "bash"), undefined);
  const narrowed = resolveConfig({ readonlyTools: ["glob"] });
  assert.equal(checkReadonly(narrowed, "read"), undefined);
});

test("路径白名单：按工具名分节、归一化后匹配、任一命中即放行", () => {
  const config = resolveConfig({ allow: { paths: { write: ["^/var/log/", "^/tmp/"] } } });
  assert.equal(
    checkPathAllow(config, call("write", { file_path: "/var/log/app.log" }))?.outcome,
    "allowed-once",
  );
  assert.equal(
    checkPathAllow(config, call("write", { path: "~/x" }))?.outcome,
    undefined,
  );
  assert.equal(checkPathAllow(config, call("read", { path: "/var/log/app.log" })), undefined);
  // 相对路径按会话 cwd 解析
  const relative = resolveConfig({ allow: { paths: { write: ["^/w/tmp/"] } } });
  assert.equal(
    checkPathAllow(relative, call("write", { path: "tmp/a" }, "/w"))?.outcome,
    "allowed-once",
  );
});

test("路径白名单：参数取不到时不生效（缺信息不猜）", () => {
  const config = resolveConfig({ allow: { paths: { write: ["^/"] } } });
  assert.equal(checkPathAllow(config, call("write", undefined)), undefined);
  assert.deepEqual(pathsOf(config, call("write", undefined)), []);
});

test("命令白名单：命令原文归一化后匹配", () => {
  const config = resolveConfig({ allow: { commands: { bash: ["^git status\\b"] } } });
  assert.equal(
    checkCommandAllow(config, call("bash", { command: "  git   status  " }))?.outcome,
    "allowed-once",
  );
  assert.equal(
    checkCommandAllow(config, call("bash", { command: "git push" }))?.outcome,
    undefined,
  );
  // 未登记工具不套用 bash 的命令规则
  assert.equal(commandOf(config, call("read", { command: "git status" })), undefined);
});

test("沙箱升级白名单：两维都要过（命令命中 + 目标模式在 to 内）", () => {
  const config = resolveConfig({
    escalation: {
      allow: [{ id: "git-ro", match: "^git (status|diff)\\b", to: ["workspace-write"] }],
    },
  });
  const info = call("bash", { command: "git status" });
  assert.equal(checkEscalationAllow(config, info, "workspace-write")?.ruleId, "git-ro");
  assert.equal(checkEscalationAllow(config, info, "danger-full-access"), undefined);
  assert.equal(
    checkEscalationAllow(config, call("bash", { command: "git push" }), "workspace-write"),
    undefined,
  );
  // 目标模式缺失 = 非升级请求，本层不生效
  assert.equal(checkEscalationAllow(config, info, undefined), undefined);
});

test("沙箱升级白名单：路径规则按路径匹配（文件工具）", () => {
  const config = resolveConfig({
    escalation: { allow: [{ id: "log-path", path: "^/var/log/", to: ["workspace-write"] }] },
  });
  assert.equal(
    checkEscalationAllow(
      config,
      call("write", { path: "/var/log/x" }),
      "workspace-write",
    )?.ruleId,
    "log-path",
  );
  assert.equal(
    checkEscalationAllow(config, call("write", { path: "/etc/x" }), "workspace-write"),
    undefined,
  );
});

test("沙箱升级白名单：escalation.mode any 放行任何升级；规则 to 缺省取全局 to", () => {
  const any = resolveConfig({ escalation: { mode: "any" } });
  assert.equal(checkEscalationAllow(any, call("bash", {}), "danger-full-access")?.ruleId, "escalation:any");
  const globalTo = resolveConfig({
    escalation: { to: ["read-only"], allow: [{ match: "^ls\\b" }] },
  });
  assert.equal(globalTo.escalationRules[0]?.to[0], "read-only");
  assert.equal(
    checkEscalationAllow(globalTo, call("bash", { command: "ls /var/log" }), "read-only")
      ?.outcome,
    "allowed-once",
  );
  assert.equal(
    checkEscalationAllow(globalTo, call("bash", { command: "ls /var/log" }), "workspace-write"),
    undefined,
  );
});

test("needsArguments：只有命中命令 / 路径 / 升级规则时才要求参数", () => {
  const config = resolveConfig({
    allow: { commands: { bash: ["^ls"] }, paths: { write: ["^/tmp/"] } },
    escalation: { allow: [{ match: "^git", to: ["workspace-write"] }] },
  });
  assert.equal(needsArguments(config, "bash", undefined), true);
  assert.equal(needsArguments(config, "write", undefined), true);
  assert.equal(needsArguments(config, "read", undefined), false);
  assert.equal(needsArguments(resolveConfig(undefined), "bash", "workspace-write"), false);
});

test("bypass / gate 名单：前缀通配与白名单语义", () => {
  const config = resolveConfig({ bypassTools: ["run_code", "mcp__*"], gateTools: [] });
  assert.equal(isBypassed(config, "run_code"), true);
  assert.equal(isBypassed(config, "mcp__a"), true);
  assert.equal(isBypassed(config, "bash"), false);
  assert.equal(isGatedOut(config, "bash"), false);
  const gated = resolveConfig({ gateTools: ["bash"] });
  assert.equal(isGatedOut(gated, "read"), true);
  assert.equal(isGatedOut(gated, "bash"), false);
});

test("拒绝文案形态：含工具名与「未执行」", () => {
  const reason = denialReason("bash", "测试理由");
  assert.match(reason, /auto-approve 拒绝了工具 "bash"/);
  assert.match(reason, /测试理由/);
  assert.match(reason, /未执行/);
});
