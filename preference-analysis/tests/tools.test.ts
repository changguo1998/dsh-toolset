import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_NAMES,
  createTools,
  type PreferenceAddInput,
  type PreferenceListOptions,
  type PreferenceApi,
} from "../src/tools.ts";
import type { LedgerEntry } from "../src/ledger.ts";

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "pref_1",
    key: "不要用emoji",
    text: "不要用 emoji",
    status: "active",
    evidence: 3,
    sessions: ["s1", "s2"],
    origin: "user",
    project: "/p",
    importance: 4,
    firstSeen: 0,
    lastSeen: 1_700_000_000_000,
    ...overrides,
  };
}

interface Calls {
  list: PreferenceListOptions[];
  add: PreferenceAddInput[];
  remove: string[];
}

function fakeApi(overrides: Partial<PreferenceApi> = {}): {
  api: PreferenceApi;
  calls: Calls;
} {
  const calls: Calls = { list: [], add: [], remove: [] };
  const api: PreferenceApi = {
    async list(opts) {
      calls.list.push(opts ?? {});
      return [entry()];
    },
    async add(input) {
      calls.add.push(input);
      return { ok: true, id: "pref_2", status: "candidate" };
    },
    async remove(id) {
      calls.remove.push(id);
      return { ok: true, removed: 1 };
    },
    ...overrides,
  };
  return { api, calls };
}

function toolByName(api: PreferenceApi, name: string) {
  const tool = createTools(api).find((item) => item.name === name);
  assert.ok(tool !== undefined, `应注册 ${name}`);
  return tool;
}

test("createTools：三个工具名与参数契约（required 字段）", () => {
  const api = fakeApi().api;
  const tools = createTools(api);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...TOOL_NAMES],
  );
  const add = tools.find((tool) => tool.name === "preference_add")!;
  assert.deepEqual(add.parameters["required"], ["text"]);
  const remove = tools.find((tool) => tool.name === "preference_remove")!;
  assert.deepEqual(remove.parameters["required"], ["id"]);
  for (const tool of tools) {
    assert.ok(tool.description.length > 20, "描述应写清用途与边界");
    assert.equal(typeof tool.output.render, "function");
    assert.equal(tool.output.schema["type"], "object");
  }
});

test("preference_list：按状态与上限转发，返回精简行", async () => {
  const { api, calls } = fakeApi();
  const tool = toolByName(api, "preference_list");
  const value = (await tool.execute({ status: "active", limit: 5 })) as {
    count: number;
    entries: Array<Record<string, unknown>>;
  };
  assert.deepEqual(calls.list, [{ status: "active", limit: 5 }]);
  assert.equal(value.count, 1);
  assert.deepEqual(value.entries[0], {
    id: "pref_1",
    text: "不要用 emoji",
    status: "active",
    evidence: 3,
    sessions: 2,
    origin: "user",
    importance: 4,
    lastSeen: new Date(1_700_000_000_000).toISOString(),
  });
  // 非法状态 / 上限回退缺省
  await tool.execute({ status: "bogus", limit: -3 });
  assert.deepEqual(calls.list[1], { limit: 20 });
});

test("preference_add：正文必填、裁剪空白、只转发文本 / 项目 / 标题", async () => {
  const { api, calls } = fakeApi();
  const tool = toolByName(api, "preference_add");
  assert.deepEqual(await tool.execute({ text: "   " }), {
    ok: false,
    reason: "text 不能为空",
  });
  const value = await tool.execute({
    text: "  不要用 emoji  ",
    project: "/p",
    title: "符号",
  });
  assert.deepEqual(value, { ok: true, id: "pref_2", status: "candidate" });
  assert.deepEqual(calls.add, [
    { text: "不要用 emoji", project: "/p", title: "符号" },
  ]);
});

test("preference_remove：id 必填、原样转发", async () => {
  const { api, calls } = fakeApi();
  const tool = toolByName(api, "preference_remove");
  assert.deepEqual(await tool.execute({ id: "" }), {
    ok: false,
    reason: "id 不能为空",
  });
  await tool.execute({ id: " pref_1 " });
  assert.deepEqual(calls.remove, ["pref_1"]);
});

test("render：把返回值序列化成单个文本块", async () => {
  const api = fakeApi().api;
  const tool = toolByName(api, "preference_list");
  const value = await tool.execute({});
  const blocks = tool.output.render({}, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "text");
  assert.ok(blocks[0]?.text.includes('"pref_1"'));
  // 不可序列化值退化为 String，render 不抛错
  assert.equal(tool.output.render({}, undefined)[0]?.text, "undefined");
});

test("异常上报：api.add / api.remove 的失败原样返回", async () => {
  const failing = fakeApi({
    async add() {
      return { ok: false, reason: "敏感内容" };
    },
    async remove() {
      return { ok: false, reason: "not-found" };
    },
  }).api;
  assert.deepEqual(
    await toolByName(failing, "preference_add").execute({
      text: "改 .ssh 配置",
    }),
    { ok: false, reason: "敏感内容" },
  );
  assert.deepEqual(
    await toolByName(failing, "preference_remove").execute({ id: "nope" }),
    { ok: false, reason: "not-found" },
  );
});
