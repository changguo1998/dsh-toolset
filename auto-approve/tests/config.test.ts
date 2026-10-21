import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BYPASS_TOOLS,
  DEFAULT_READONLY_TOOLS,
  resolveConfig,
  reviewActive,
} from "../src/config.ts";

test("缺省值：enabled true / mode rules / 四张名单全空 / 只读类内置", () => {
  const config = resolveConfig(undefined);
  assert.equal(config.enabled, true);
  assert.equal(config.mode, "rules");
  assert.deepEqual(config.readonlyTools, DEFAULT_READONLY_TOOLS);
  assert.deepEqual(config.bypassTools, DEFAULT_BYPASS_TOOLS);
  assert.deepEqual(config.allowCommands, []);
  assert.deepEqual(config.allowPaths, []);
  assert.deepEqual(config.denyTools, []);
  assert.deepEqual(config.denyEscalationTo, []);
  assert.deepEqual(config.escalationRules, []);
  assert.equal(config.escalationMode, "match");
  assert.equal(config.review.enabled, true);
  assert.equal(config.review.onFailure, "panel");
  assert.equal(config.review.maxRiskAllow, "medium");
  assert.equal(config.review.timeoutMs, 10_000);
  assert.equal(config.audit.project, true);
  assert.equal(config.audit.maxBytes, 16 * 1024 * 1024);
  assert.deepEqual(config.diagnostics, []);
});

test("enabled 仅显式 false 关闭；mode 非法回落 rules 并记诊断", () => {
  assert.equal(resolveConfig({ enabled: false }).enabled, false);
  assert.equal(resolveConfig({ enabled: true }).enabled, true);
  const config = resolveConfig({ mode: "yolo" as never });
  assert.equal(config.mode, "rules");
  assert.equal(config.diagnostics.length, 1);
  assert.match(config.diagnostics[0] ?? "", /mode 非法/);
});

test("只读类 / bypass / gate 名单可覆盖（空数组即关闭该层）", () => {
  const config = resolveConfig({
    readonlyTools: [],
    bypassTools: [],
    gateTools: ["bash"],
  });
  assert.deepEqual(config.readonlyTools, []);
  assert.deepEqual(config.bypassTools, []);
  assert.deepEqual(config.gateTools, ["bash"]);
});

test("白名单 / 拒绝名单归一：四张表按工具名分节并编译正则", () => {
  const config = resolveConfig({
    allow: {
      commands: { bash: ["^git status\\b"] },
      paths: { read: ["^/var/log/"] },
    },
    deny: {
      tools: ["mcp__*", "run_code"],
      escalation: { to: ["danger-full-access"] },
    },
    escalation: {
      allow: [
        {
          id: "git-ro",
          match: "^git (status|diff)\\b",
          to: ["workspace-write"],
        },
        { path: "^/var/log/.*", to: ["read-only"] },
      ],
    },
  });
  assert.equal(config.allowCommands.length, 1);
  assert.equal(config.allowCommands[0]?.tool, "bash");
  assert.equal(config.allowPaths.length, 1);
  assert.deepEqual(config.denyTools, ["mcp__*", "run_code"]);
  assert.deepEqual(config.denyEscalationTo, ["danger-full-access"]);
  assert.equal(config.escalationRules.length, 2);
  assert.equal(config.escalationRules[0]?.id, "git-ro");
  assert.ok(config.escalationRules[0]?.command instanceof RegExp);
  assert.ok(config.escalationRules[1]?.path instanceof RegExp);
});

test("非法正则被忽略并记诊断（不抛错、不误放行）", () => {
  const config = resolveConfig({
    allow: { commands: { bash: ["("] } },
    escalation: { allow: [{ match: "([", to: ["workspace-write"] }] },
  });
  assert.deepEqual(config.allowCommands, []);
  assert.deepEqual(config.escalationRules, []);
  // 两条正则错误各一条 + 该规则因此「既无 match 也无 path」一条
  assert.equal(config.diagnostics.length, 3);
  assert.equal(
    config.diagnostics.filter((line) => line.includes("正则非法")).length,
    2,
  );
});

test("升级规则没有目标模式时被忽略（该规则不放行任何升级）", () => {
  const config = resolveConfig({
    escalation: { allow: [{ match: "^git status\\b" }] },
  });
  assert.deepEqual(config.escalationRules, []);
  assert.match(config.diagnostics.join("\n"), /没有可允许的目标模式/);
});

test("review 段：覆盖路由、超时与失败兜底；非法值回落缺省", () => {
  const overridden = resolveConfig({
    review: {
      provider: "p",
      model: "m",
      timeoutMs: 3000,
      maxRiskAllow: "low",
      onFailure: "reject",
    },
  });
  assert.deepEqual(
    {
      provider: overridden.review.provider,
      model: overridden.review.model,
      timeoutMs: overridden.review.timeoutMs,
      maxRiskAllow: overridden.review.maxRiskAllow,
      onFailure: overridden.review.onFailure,
    },
    {
      provider: "p",
      model: "m",
      timeoutMs: 3000,
      maxRiskAllow: "low",
      onFailure: "reject",
    },
  );
  const invalid = resolveConfig({
    review: {
      timeoutMs: -1,
      maxRiskAllow: "none" as never,
      onFailure: "nope" as never,
    },
  });
  assert.equal(invalid.review.timeoutMs, 10_000);
  assert.equal(invalid.review.maxRiskAllow, "medium");
  assert.equal(invalid.review.onFailure, "panel");
});

test("reviewActive：仅 rules+llm 且 review.enabled 时生效", () => {
  assert.equal(reviewActive(resolveConfig({ mode: "rules" })), false);
  assert.equal(reviewActive(resolveConfig({ mode: "all" })), false);
  assert.equal(reviewActive(resolveConfig({ mode: "rules+llm" })), true);
  assert.equal(
    reviewActive(
      resolveConfig({ mode: "rules+llm", review: { enabled: false } }),
    ),
    false,
  );
});

test("容量类配置的上下界（非法回落缺省）", () => {
  const config = resolveConfig({
    fingerprintCapacity: 0,
    callTableCapacity: 999_999,
    audit: { maxBytes: 1 },
  });
  assert.equal(config.fingerprintCapacity, 256);
  assert.equal(config.callTableCapacity, 256);
  assert.equal(config.audit.maxBytes, 16 * 1024 * 1024);
  assert.equal(
    resolveConfig({ fingerprintCapacity: 8 }).fingerprintCapacity,
    8,
  );
});

test("学习键：缺省值（自动学 / 泛化开 / 审阅开 / 256 / 512 / 5 min / 回填开）", () => {
  const config = resolveConfig(undefined);
  assert.equal(config.learnFromManual, true);
  assert.equal(config.learnGeneralize, true);
  assert.deepEqual(config.learnReview, { enabled: true, onFailure: "skip" });
  assert.equal(config.formCapacity, 256);
  assert.equal(config.selfDecidedCapacity, 512);
  assert.equal(config.selfDecidedTtlMs, 300_000);
  assert.equal(config.learnRehydrate, true);
});

test("学习键：合法值原样生效，不产生诊断", () => {
  const config = resolveConfig({
    learnFromManual: false,
    learnGeneralize: "off",
    learnReview: { enabled: false, onFailure: "skip" },
    formCapacity: 8,
    selfDecidedCapacity: 4,
    selfDecidedTtlMs: 1000,
    learnRehydrate: false,
  });
  assert.equal(config.learnFromManual, false);
  assert.equal(config.learnGeneralize, false);
  assert.deepEqual(config.learnReview, { enabled: false, onFailure: "skip" });
  assert.equal(config.formCapacity, 8);
  assert.equal(config.selfDecidedCapacity, 4);
  assert.equal(config.selfDecidedTtlMs, 1000);
  assert.equal(config.learnRehydrate, false);
  assert.deepEqual(config.diagnostics, []);
});

test("学习键：非法值回落缺省并各记一条诊断（不抛错）", () => {
  const config = resolveConfig({
    learnFromManual: "yes" as never,
    learnGeneralize: "maybe" as never,
    learnReview: { enabled: 1 as never, onFailure: "panel" as never },
    formCapacity: -1,
    selfDecidedCapacity: 0,
    selfDecidedTtlMs: 10,
    learnRehydrate: "on" as never,
  } as never);
  assert.equal(config.learnFromManual, true);
  assert.equal(config.learnGeneralize, true);
  assert.deepEqual(config.learnReview, { enabled: true, onFailure: "skip" });
  assert.equal(config.formCapacity, 256);
  assert.equal(config.selfDecidedCapacity, 512);
  assert.equal(config.selfDecidedTtlMs, 300_000);
  assert.equal(config.learnRehydrate, true);
  assert.equal(config.diagnostics.length, 8);
  for (const label of [
    "learnFromManual",
    "learnGeneralize",
    "learnReview.enabled",
    "learnReview.onFailure",
    "formCapacity",
    "selfDecidedCapacity",
    "selfDecidedTtlMs",
    "learnRehydrate",
  ]) {
    assert.match(config.diagnostics.join("\n"), new RegExp(label));
  }
});
