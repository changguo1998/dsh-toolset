import { test } from "node:test";
import assert from "node:assert/strict";
import {
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  WriteObserver,
} from "../src/observe.ts";

test("写类工具调用被记入", () => {
  const observer = new WriteObserver();
  observer.observe("s1", { type: "tool/call", data: { name: "edit" } });
  assert.equal(observer.writeSeen("s1"), true);
  assert.equal(observer.lastWriteTool("s1"), "edit");
});

test("只读工具不计", () => {
  const observer = new WriteObserver();
  for (const name of READ_TOOL_NAMES) {
    observer.observe("s1", { type: "tool/call", data: { name } });
  }
  assert.equal(observer.writeSeen("s1"), false);
});

test("非工具事件 / 缺 name / 空 name 均忽略", () => {
  const observer = new WriteObserver();
  observer.observe("s1", { type: "user/message", data: { name: "edit" } });
  observer.observe("s1", { type: "tool/call", data: {} });
  observer.observe("s1", { type: "tool/call", data: { name: "" } });
  observer.observe("s1", {});
  assert.equal(observer.writeSeen("s1"), false);
});

test("按会话隔离", () => {
  const observer = new WriteObserver();
  observer.observe("s1", { type: "tool/call", data: { name: "bash" } });
  assert.equal(observer.writeSeen("s2"), false);
});

test("reset 只清一个会话，clear 清全部", () => {
  const observer = new WriteObserver();
  observer.observe("s1", { type: "tool/call", data: { name: "write" } });
  observer.observe("s2", { type: "tool/call", data: { name: "write" } });
  observer.reset("s1");
  assert.equal(observer.writeSeen("s1"), false);
  assert.equal(observer.writeSeen("s2"), true);
  observer.clear();
  assert.equal(observer.writeSeen("s2"), false);
});

test("写类清单覆盖常用改动工具", () => {
  for (const name of ["write", "edit", "bash", "pwsh", "script_run"]) {
    assert.ok(WRITE_TOOL_NAMES.includes(name), name);
  }
});
