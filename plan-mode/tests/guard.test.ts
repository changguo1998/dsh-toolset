import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decide,
  isWriteCommand,
  toolWriteKind,
  STAGE_READONLY_CODE,
} from "../src/guard.ts";

/** decide 的探索段基点（mapped + 探索 + 计划未 done）。 */
const explore = {
  mapped: true,
  stage: "explore" as const,
  planDone: false,
};

test("plan_stage_readonly 错误码在判定核里定义", () => {
  assert.equal(STAGE_READONLY_CODE, "plan_stage_readonly");
});

test("探索段拒绝 write", () => {
  const result = decide({ ...explore, kind: toolWriteKind("write", {}) });
  assert.equal(result.deny, true);
  assert.match(result.reason ?? "", /当前段是探索/);
});

test("只读段拒 hash_edit 与 md_logic 的 replace", () => {
  assert.equal(
    decide({ ...explore, kind: toolWriteKind("hash_edit", {}) }).deny,
    true,
  );
  assert.equal(
    decide({
      ...explore,
      kind: toolWriteKind("md_logic", { action: "replace" }),
    }).deny,
    true,
  );
  assert.equal(
    decide({
      ...explore,
      kind: toolWriteKind("md_logic", { action: "blocks" }),
    }).deny,
    false,
  );
});

test("dry-run 的 ast_replace 放行", () => {
  assert.equal(
    decide({ ...explore, kind: toolWriteKind("ast_replace", {}) }).deny,
    false,
  );
  assert.equal(
    decide({
      ...explore,
      kind: toolWriteKind("ast_replace", { write: true }),
    }).deny,
    true,
  );
});

test("重定向判为写", () => {
  assert.equal(isWriteCommand("echo hello > out.txt"), true);
  assert.equal(isWriteCommand("cmd >> log.txt"), true);
  assert.equal(isWriteCommand("cmd &> all.txt"), true);
});

test("认不出的命令放行", () => {
  assert.equal(isWriteCommand("git status"), false);
  assert.equal(isWriteCommand("ls -la"), false);
  assert.equal(
    isWriteCommand("sed 's/a/b/' in.txt"),
    false,
    "sed 不带 -i 不算写",
  );
});

test("回执写明当前段与下一步", () => {
  const r = decide({ ...explore, kind: "direct-write" });
  assert.match(r.reason ?? "", /当前段是/);
  assert.match(r.reason ?? "", /下一步: /);
  const p = decide({ ...explore, stage: "plan", kind: "direct-write" });
  assert.match(p.reason ?? "", /下一步: 计划经人工确认后再改/);
});

test("只读段拒 workflow 与 task_execute", () => {
  assert.equal(
    decide({ ...explore, kind: toolWriteKind("workflow", {}) }).deny,
    true,
  );
  assert.equal(
    decide({ ...explore, kind: toolWriteKind("task_execute", {}) }).deny,
    true,
  );
});

test("只读段拒 run_code 与 script_run", () => {
  assert.equal(
    decide({ ...explore, kind: toolWriteKind("run_code", {}) }).deny,
    true,
  );
  assert.equal(
    decide({ ...explore, kind: toolWriteKind("script_run", {}) }).deny,
    true,
  );
});

test("任务面工具不受影响", () => {
  for (const name of [
    "flow_select",
    "plan_start",
    "task_decompose",
    "task_implement",
    "task_stop",
  ]) {
    assert.equal(
      decide({ ...explore, kind: toolWriteKind(name, {}) }).deny,
      false,
      `${name} 应放行`,
    );
  }
});

test("herdr_text 按命令白名单判", () => {
  const base = { ...explore, kind: toolWriteKind("herdr_text", {}) };
  assert.equal(decide({ ...base, command: "touch f" }).deny, true);
  assert.equal(decide({ ...base, command: "git status" }).deny, false);
});

test("实施段放行", () => {
  const result = decide({
    mapped: true,
    stage: "implement",
    planDone: true,
    kind: "direct-write",
  });
  assert.equal(result.deny, false);
});

test("计划段 done 后判为可写", () => {
  const result = decide({
    ...explore,
    planDone: true,
    kind: "direct-write",
  });
  assert.equal(result.deny, false);
});
