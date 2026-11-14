import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ALLOWED_WHEN_TOOLS,
  DEFAULT_INITIAL_TOOLS,
  expandInitialTools,
  isSubagentSession,
  matchGlob,
  resolveConfig,
} from "../src/config.ts";

test("缺省值：14 个初始工具、web 条件白名单、roots、只留 maxResults", () => {
  const config = resolveConfig();
  assert.deepEqual(config.initialTools, [...DEFAULT_INITIAL_TOOLS]);
  assert.deepEqual(config.initialTools, [
    "bash",
    "read",
    "glob",
    "grep",
    "ask_user_question",
    "skill",
    "write",
    "edit",
    "read_image",
    "web_search",
    "web_fetch",
    "job_output",
    "job_list",
    "job_kill",
  ]);
  assert.deepEqual(config.allowedWhenTools, [...DEFAULT_ALLOWED_WHEN_TOOLS]);
  assert.equal(config.applyTo, "roots");
  assert.equal(config.maxResults, 5);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.ignoredKeys, []);
});

test("旧配置键不再生效，但记入 ignoredKeys", () => {
  const config = resolveConfig({
    maskMode: "denylist",
    revealScope: "turn",
    maxRevealed: 3,
    maxPinned: 1,
    ttlTurns: 2,
    disabledWhenTools: ["x"],
  } as never);
  assert.deepEqual(config.ignoredKeys, [
    "maskMode",
    "revealScope",
    "maxRevealed",
    "maxPinned",
    "ttlTurns",
    "disabledWhenTools",
  ]);
  assert.equal("maskMode" in config, false);
  assert.equal("revealScope" in config, false);
});

test("非法值回退缺省，显式名单与 all 生效", () => {
  assert.equal(resolveConfig({ maxResults: 99 }).maxResults, 20);
  assert.equal(resolveConfig({ maxResults: -3 }).maxResults, 5);
  assert.deepEqual(resolveConfig({ initialTools: [""] }).initialTools, []);
  const config = resolveConfig({
    applyTo: "all",
    allowedWhenTools: ["team_task_list"],
    maxResults: 2,
  });
  assert.equal(config.applyTo, "all");
  assert.deepEqual(config.allowedWhenTools, ["team_task_list"]);
  assert.equal(config.maxResults, 2);
});

test("通配匹配与展开", () => {
  assert.equal(matchGlob("task_*", "task_stop"), true);
  assert.equal(matchGlob("task_*", "task"), false);
  assert.equal(matchGlob("a?c", "abc"), true);
  const result = expandInitialTools(
    ["task_*", "bash", "nope", "missing_*"],
    ["task_stop", "task_status", "bash", "session_channel"],
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
