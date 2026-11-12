import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_INITIAL_TOOLS,
  expandInitialTools,
  isSubagentSession,
  matchGlob,
  resolveConfig,
} from "../src/config.ts";

test("缺省值：11 核心工具（含 skill 与两个联网工具）、session 档、roots", () => {
  const config = resolveConfig();
  assert.equal(config.initialTools.length, 11);
  assert.deepEqual(config.initialTools, [...DEFAULT_INITIAL_TOOLS]);
  assert.deepEqual(config.initialTools, [
    "bash",
    "read",
    "glob",
    "grep",
    "ask_user_question",
    "skill",
    "hash_read",
    "hash_edit",
    "write",
    "web_search",
    "web_fetch",
  ]);
  assert.ok(config.initialTools.includes("skill"));
  assert.equal(config.revealScope, "session");
  assert.equal(config.applyTo, "roots");
  assert.equal(config.maxRevealed, 12);
  assert.equal(config.maxPinned, 3);
  assert.equal(config.ttlTurns, 0);
  assert.equal(config.maxResults, 5);
  assert.equal(config.enabled, true);
});

test("缺省禁用官方条件工具：6 个 when 工具, 不含 tool-web", () => {
  const config = resolveConfig();
  assert.deepEqual(config.disabledWhenTools, [
    "exit_plan_mode",
    "propose_action",
    "team_task_create",
    "team_task_get",
    "team_task_list",
    "team_task_update",
  ]);
  assert.equal(config.disabledWhenTools.includes("web_search"), false);
  assert.equal(config.disabledWhenTools.includes("web_fetch"), false);
  assert.deepEqual(
    resolveConfig({ disabledWhenTools: [] }).disabledWhenTools,
    [],
  );
});

test("缺省名单不含 edit / todo_write（收进按需揭示）", () => {
  const config = resolveConfig();
  assert.equal(config.initialTools.includes("edit"), false);
  assert.equal(config.initialTools.includes("todo_write"), false);
  for (const name of ["write", "hash_read", "hash_edit"]) {
    assert.ok(config.initialTools.includes(name), `${name} 应在缺省名单中`);
  }
});

test("非法值回退缺省", () => {
  const config = resolveConfig({
    revealScope: "nonsense" as never,
    maskMode: "weird" as never,
    maxRevealed: -3,
    ttlTurns: 1.5,
    maxResults: 99,
    initialTools: [""],
  });
  assert.equal(config.revealScope, "session");
  assert.equal(config.maskMode, "allowlist");
  assert.equal(config.maxRevealed, 12);
  assert.equal(config.ttlTurns, 0);
  assert.equal(config.maxResults, 20);
  assert.deepEqual(config.initialTools, []);
});

test("显式 turn 档与 all 生效", () => {
  const config = resolveConfig({
    revealScope: "turn",
    applyTo: "all",
    maxRevealed: 3,
  });
  assert.equal(config.revealScope, "turn");
  assert.equal(config.applyTo, "all");
  assert.equal(config.maxRevealed, 3);
});

test("通配匹配", () => {
  assert.equal(matchGlob("task_*", "task_stop"), true);
  assert.equal(matchGlob("task_*", "task"), false);
  assert.equal(matchGlob("a?c", "abc"), true);
  assert.equal(matchGlob("md_*", "md_logic"), true);
  assert.equal(matchGlob("md_*", "session_channel"), false);
});

test("通配展开与未命中的模式", () => {
  const known = ["task_stop", "task_status", "bash", "session_channel"];
  const result = expandInitialTools(
    ["task_*", "bash", "nope", "missing_*"],
    known,
  );
  assert.deepEqual(result.names, ["bash", "task_status", "task_stop"]);
  assert.deepEqual(result.unknown, ["nope", "missing_*"]);
});

test("子代理判定", () => {
  assert.equal(isSubagentSession(undefined), false);
  assert.equal(isSubagentSession({}), false);
  assert.equal(isSubagentSession({ origin: "subagent" }), true);
  assert.equal(isSubagentSession({ delegationDepth: 1 }), true);
  assert.equal(isSubagentSession({ delegationDepth: 0 }), false);
});
