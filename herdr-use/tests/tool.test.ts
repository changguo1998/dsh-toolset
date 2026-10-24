import assert from "node:assert/strict";
import test from "node:test";

import { capText, createHerdrTools, renderHerdrUse } from "../src/tools.ts";
import type { HerdrUseToolDef } from "../src/tools.ts";
import { ALL_ACTIONS, TOOL_NAMES, resolveConfig } from "../src/types.ts";
import type { ActionResult } from "../src/types.ts";
import {
  fakeExec,
  fakeHerdr,
  fakeReader,
  makeDeps,
  readOk,
  registerTerminal,
} from "./helpers.ts";

const tools = (): HerdrUseToolDef[] => createHerdrTools(makeDeps());

const toolNamed = (name: string): HerdrUseToolDef => {
  const found = tools().find((tool) => tool.name === name);
  assert.ok(found !== undefined, `缺少工具 ${name}`);
  return found;
};

test("十个工具、名称与动作一一对应", () => {
  const list = tools();
  assert.equal(list.length, 10);
  assert.deepEqual(
    list.map((tool) => tool.name),
    ALL_ACTIONS.map((action) => TOOL_NAMES[action]),
  );
  assert.deepEqual(list.map((tool) => tool.name).sort(), [
    "herdr_close",
    "herdr_create",
    "herdr_info",
    "herdr_key",
    "herdr_label",
    "herdr_list",
    "herdr_read",
    "herdr_run",
    "herdr_text",
    "herdr_wait",
  ]);
});

test("每个工具：additionalProperties=false，且没有 action / pane_id / tab_id", () => {
  for (const tool of tools()) {
    assert.equal(tool.parameters.additionalProperties, false, tool.name);
    assert.equal(tool.parameters.type, "object");
    const keys = Object.keys(tool.parameters.properties);
    assert.equal(keys.includes("action"), false, tool.name);
    assert.equal(keys.includes("pane_id"), false, tool.name);
    assert.equal(keys.includes("tab_id"), false, tool.name);
    assert.equal(keys.includes("workspace"), false, tool.name);
    assert.equal(keys.includes("force"), false, tool.name);
  }
});

test("必填项与参数面", () => {
  assert.deepEqual(toolNamed("herdr_list").parameters.required, undefined);
  assert.deepEqual(toolNamed("herdr_read").parameters.required, [
    "terminal_id",
  ]);
  assert.deepEqual(toolNamed("herdr_info").parameters.required, [
    "terminal_id",
  ]);
  assert.deepEqual(toolNamed("herdr_wait").parameters.required, [
    "terminal_id",
  ]);
  assert.deepEqual(toolNamed("herdr_create").parameters.required, undefined);
  assert.deepEqual(toolNamed("herdr_close").parameters.required, [
    "terminal_id",
  ]);
  assert.deepEqual(toolNamed("herdr_label").parameters.required, [
    "terminal_id",
    "label",
  ]);
  assert.deepEqual(toolNamed("herdr_text").parameters.required, [
    "terminal_id",
    "text",
  ]);
  assert.deepEqual(toolNamed("herdr_key").parameters.required, [
    "terminal_id",
    "keys",
  ]);
  assert.deepEqual(toolNamed("herdr_run").parameters.required, [
    "terminal_id",
    "command",
  ]);
  const createProps = toolNamed("herdr_create").parameters.properties;
  assert.deepEqual(Object.keys(createProps).sort(), [
    "cwd",
    "foreground",
    "label",
  ]);
  const readProps = toolNamed("herdr_read").parameters.properties;
  assert.deepEqual(Object.keys(readProps).sort(), [
    "format",
    "lines",
    "source",
    "terminal_id",
  ]);
  assert.deepEqual((readProps.source as { enum: string[] }).enum, [
    "visible",
    "recent",
    "recent-unwrapped",
    "detection",
  ]);
});

test("execute 走 dispatchAction（create 后 registry 可查）", async () => {
  const deps = makeDeps({ runner: fakeHerdr().runner });
  const create = createHerdrTools(deps).find(
    (tool) => tool.name === "herdr_create",
  );
  assert.ok(create !== undefined);
  const result = await create.execute({ label: "one" }, fakeExec());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const terminalId = String(result.payload.terminal_id);
  assert.equal(deps.registry.has(terminalId), true);
});

test("execute 把 exec 透传给会话解析（缺 exec → session-unavailable）", async () => {
  const deps = makeDeps({ runner: fakeHerdr().runner });
  const create = createHerdrTools(deps).find(
    (tool) => tool.name === "herdr_create",
  );
  assert.ok(create !== undefined);
  const result = await create.execute({});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "session-unavailable");
});

test("render：list / create / read / 失败", () => {
  const list: ActionResult = {
    ok: true,
    action: "list",
    payload: {
      terminals: [
        {
          terminal_id: "wT1:p2",
          label: "fg",
          foreground: true,
          registered: true,
          focused: false,
          pane_count: 1,
        },
        {
          terminal_id: "wT9:p1",
          label: "old",
          foreground: false,
          registered: false,
          focused: false,
          pane_count: 2,
        },
      ],
    },
  };
  const listText = renderHerdrUse(list);
  assert.match(listText, /herdr_list：本会话有 2 个终端/);
  assert.match(listText, /\[本插件\] wT1:p2（前台）/);
  assert.match(listText, /wT9:p1（后台）/);

  const created = renderHerdrUse({
    ok: true,
    action: "create",
    payload: {
      terminal_id: "wT1:p2",
      label: "fg",
      cwd: "/tmp/proj",
      foreground: false,
    },
  });
  assert.match(created, /herdr_create：已建终端 wT1:p2（后台 dshbg/);

  const read = renderHerdrUse({
    ok: true,
    action: "read",
    payload: {
      terminal_id: "wT1:p2",
      source: "recent-unwrapped",
      revision: 3,
      text: "hello",
    },
  });
  assert.match(read, /herdr_read：terminal=wT1:p2/);
  assert.match(read, /hello/);

  const failed = renderHerdrUse({
    ok: false,
    action: "close",
    error: { code: "terminal-not-registered", message: "nope", hint: "hint" },
  });
  assert.match(failed, /herdr_close 失败\[terminal-not-registered\]/);
  assert.match(failed, /放行 \/ 下一步：hint/);
});

test("capText：字符与行截断", () => {
  const limit = resolveConfig({
    renderLimit: { lines: 2, chars: 5 },
  }).renderLimit;
  const capped = capText("abcdefghij\nsecond\nthird", limit, "read");
  assert.equal(capped.truncated, true);
  assert.match(capped.text, /已截断/);
  const keep = capText("ok", limit, "read");
  assert.equal(keep.truncated, false);
});

test("render 对畸形值不抛", () => {
  assert.doesNotThrow(() => renderHerdrUse(undefined));
  assert.equal(typeof renderHerdrUse(null), "string");
  assert.equal(typeof renderHerdrUse({ ok: true, action: "list" }), "string");
});

test("read 工具经 fake reader 取屏", async () => {
  const deps = makeDeps({ runner: fakeHerdr().runner });
  registerTerminal(deps.registry);
  deps.readerFor = () => fakeReader([readOk("screen", { revision: 9 })]);
  const read = createHerdrTools(deps).find(
    (tool) => tool.name === "herdr_read",
  );
  assert.ok(read !== undefined);
  const result = await read.execute({ terminal_id: "wT1:p10" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.text, "screen");
  assert.equal(result.payload.revision, 9);
});

/**
 * 工具描述回归（P0，见 docs/implementation/2026-10-24-tool-description-review.md）：
 * D6 与 bash 的分工、C2 与 read / herdr_run 的边界、C1 / C6 / C9。
 */
test("工具描述：P0 与 bash 的分工（D6 / C2 / C1 / C9）", () => {
  const description = (name: string): string => toolNamed(name).description;
  for (const name of ["herdr_run", "herdr_read", "herdr_text", "herdr_key"]) {
    const text = description(name);
    // C1：首句不超过 80 字符
    const first = text.replace(/\s+/g, " ").trim();
    const cut = first.search(/[。！？.!?]/);
    const sentence = cut === -1 ? first : first.slice(0, cut + 1);
    assert.ok(sentence.length <= 80, `${name} 首句：${sentence}`);
    // C9：工具级不超过 400 字符
    assert.ok([...text].length <= 400, `${name} 描述过长`);
    // C6：不用「宿主」「官方」代称
    assert.doesNotMatch(text, /宿主|官方/, name);
  }
  // D6：herdr_run 写明一次性命令用 bash、交互状态用本工具
  const run = description("herdr_run");
  assert.match(run, /bash/);
  assert.match(run, /一次性/);
  // C2：herdr_text 与 herdr_run 的分工；herdr_run 反指 herdr_text
  assert.match(description("herdr_text"), /herdr_run/);
  assert.match(run, /herdr_text/);
  // C2：herdr_read 指向 read（文件内容）与 herdr_wait（等输出）
  const read = description("herdr_read");
  assert.match(read, /read/);
  assert.match(read, /herdr_wait/);
  // C2：herdr_key 与 herdr_text 的分工
  assert.match(description("herdr_key"), /herdr_text/);
});
