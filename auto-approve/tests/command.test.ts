import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMAND_NAME,
  dispatch,
  parseCommandInput,
  registerCommand,
  renderLog,
  renderStatus,
} from "../src/command.ts";
import { resolveConfig } from "../src/config.ts";
import type {
  AutoApproveMode,
  AutoApproveService,
  AuditLine,
} from "../src/types.ts";
import { createFakeHost } from "./fakes.ts";

function line(overrides: Partial<AuditLine> = {}): AuditLine {
  return {
    t: "2026-10-17T00:00:00.000Z",
    sessionId: "s1",
    callId: "c1",
    toolName: "read",
    outcome: "allowed-once",
    source: "readonly",
    ruleId: "readonly:read",
    mode: "rules",
    ...overrides,
  };
}

function stubService(): AutoApproveService & { modes: AutoApproveMode[] } {
  let mode: AutoApproveMode = "rules";
  const modes: AutoApproveMode[] = [];
  return {
    modes,
    status: () => ({
      enabled: mode !== "off",
      mode,
      configuredMode: "rules",
      llmEnabled: mode === "rules+llm",
      llmRoute: "session",
      readonlyTools: 9,
      allowRules: 2,
      denyRules: 1,
      upgradeRules: 3,
      fingerprints: 4,
      audit: {
        sessionWritable: true,
        sessionFilePath: "/sessions/s1/auto-approve-audit.jsonl",
        projectWritable: true,
        projectSkipped: 0,
        sessionLines: 7,
        truncated: false,
      },
    }),
    recent: (n = 10) => [line({ callId: "c2" }), line()].slice(0, n),
    fingerprints: () => [],
    setMode: (value: AutoApproveMode) => {
      mode = value;
      modes.push(value);
    },
  };
}

test("parseCommandInput：空参按 status；子命令小写、参数切分", () => {
  assert.deepEqual(parseCommandInput(""), { sub: "status", args: [] });
  assert.deepEqual(parseCommandInput("  "), { sub: "status", args: [] });
  assert.deepEqual(parseCommandInput(" MODE rules "), { sub: "mode", args: ["rules"] });
  assert.deepEqual(parseCommandInput("log 3"), { sub: "log", args: ["3"] });
});

test("status：反映模式 / 名单 / 指纹 / LLM 路由 / 审计两处", () => {
  const text = renderStatus(stubService());
  assert.match(text, /已启用/);
  assert.match(text, /模式: rules（配置默认 rules）/);
  assert.match(text, /LLM 审查: 关闭/);
  assert.match(text, /只读类 9 · 白名单 2 · 拒绝名单 1 · 升级白名单 3/);
  assert.match(text, /本会话指纹: 4/);
  assert.match(text, /审计（会话）: \/sessions\/s1\/auto-approve-audit\.jsonl · 7 行/);
  assert.match(text, /审计（项目）: 可用/);
});

test("mode / on / off：改运行态并给反馈；非法取值报错", () => {
  const service = stubService();
  const options = { clearFingerprints: () => 0, defaultLogLines: 10 };
  const mode = dispatch(service, "mode rules+llm", options);
  assert.equal(mode.kind, "success");
  assert.match(mode.text ?? "", /rules\+llm/);
  assert.deepEqual(service.modes, ["rules+llm"]);
  assert.equal(dispatch(service, "mode off", options).kind, "success");
  assert.equal(dispatch(service, "on", options).kind, "success");
  assert.equal(dispatch(service, "off", options).kind, "success");
  assert.deepEqual(service.modes, ["rules+llm", "off", "rules", "off"]);
  const bad = dispatch(service, "mode yolo", options);
  assert.equal(bad.kind, "error");
  assert.match(bad.text ?? "", /用法/);
});

test("log：默认 10 条、可按参数收窄，且不含参数原文", () => {
  const service = stubService();
  const options = { clearFingerprints: () => 0, defaultLogLines: 10 };
  assert.equal(service.recent(10).length, 2);
  const text = renderLog(service, 1);
  assert.match(text, /最近 1 条自动裁定/);
  assert.match(text, /放行 read 来源=readonly/);
  const out = dispatch(service, "log 1", options);
  assert.match(out.text ?? "", /最近 1 条自动裁定/);
  const empty = renderLog({ ...service, recent: () => [] }, 5);
  assert.match(empty, /还没有自动裁定记录/);
});

test("clear-fingerprints：调用清理并报告条数", () => {
  let cleared = 0;
  const result = dispatch(stubService(), "clear-fingerprints", {
    clearFingerprints: () => {
      cleared = 3;
      return 3;
    },
    defaultLogLines: 10,
  });
  assert.equal(result.kind, "success");
  assert.match(result.text ?? "", /已清空 3 条会话指纹/);
  assert.equal(cleared, 3);
});

test("未知子命令：报错并列出用法", () => {
  const result = dispatch(stubService(), "bogus", {
    clearFingerprints: () => 0,
    defaultLogLines: 10,
  });
  assert.equal(result.kind, "error");
  assert.match(result.text ?? "", /未知子命令: bogus/);
  assert.match(result.text ?? "", /clear-fingerprints/);
});

test("registerCommand：commands 缺席返回 undefined；注册后 handler 走同一分派", async () => {
  const absent = registerCommand(createFakeHost(), {
    config: resolveConfig(undefined),
    service: stubService,
    clearFingerprints: () => 0,
  });
  assert.equal(absent, undefined);

  let definition:
    | {
        name?: string;
        description?: string;
        handler?: (invocation: { rawInput?: string }) => unknown;
      }
    | undefined;
  let disposed = 0;
  const host = createFakeHost({
    commands: {
      register(value: unknown) {
        definition = value as typeof definition;
        return () => {
          disposed += 1;
        };
      },
    },
  });
  const service = stubService();
  const off = registerCommand(host, {
    config: resolveConfig(undefined),
    service: () => service,
    clearFingerprints: () => 0,
  });
  assert.equal(typeof off, "function");
  assert.equal(definition?.name, COMMAND_NAME);
  assert.match(definition?.description ?? "", /自动审批插件/);
  const result = (await definition?.handler?.({ rawInput: "off" })) as {
    kind: string;
    text?: string;
  };
  assert.equal(result.kind, "success");
  assert.match(result.text ?? "", /已关闭/);
  off?.();
  assert.equal(disposed, 1);
});
