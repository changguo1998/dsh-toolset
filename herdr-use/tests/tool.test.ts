/**
 * tests/tool.test.ts — `herdr_use` 工具定义与回执渲染
 *
 * 重点：
 *   - `parameters` 的必填项与枚举是模型侧契约（改它等于改接口）；
 *   - `render` 是**全函数**：任何畸形值都要能渲染出文本（不抛）；
 *   - `renderLimit` 只截显示、不改库面数据，且提示用 `lines` / `source` 收窄。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PaneRegistry } from "../src/registry.ts";
import {
  TOOL_NAME,
  capText,
  createHerdrUseTool,
  renderHerdrUse,
} from "../src/tools.ts";
import type { DispatchDeps } from "../src/actions.ts";
import { resolveConfig, failure, success } from "../src/types.ts";
import {
  fakeClock,
  fakeHerdr,
  fakeReader,
  fakeRunner,
  fakeSession,
  readOk,
} from "./helpers.ts";

/** 组装工具定义。 */
function tool(
  options: {
    runner?: ReturnType<typeof fakeRunner>;
    reader?: ReturnType<typeof fakeReader>;
    renderLimit?: { lines?: number; chars?: number };
  } = {},
) {
  const config = resolveConfig(
    options.renderLimit === undefined
      ? {}
      : { renderLimit: options.renderLimit },
  );
  const registry = new PaneRegistry(config.label);
  const deps: DispatchDeps = {
    config,
    runner: options.runner ?? fakeRunner(),
    reader: options.reader ?? fakeReader([readOk("x")]),
    registry,
    callerPaneId: "wT1:p1",
    resolveSession: () => fakeSession,
    clock: fakeClock(),
  };
  return { def: createHerdrUseTool(deps), deps, registry, config };
}

test("工具定义: 名称、必填 action、十三动作枚举与关键参数类型", () => {
  const { def } = tool();
  assert.equal(def.name, TOOL_NAME);
  assert.equal(def.name, "herdr_use");
  assert.deepEqual(def.parameters.required, ["action"]);
  const properties = def.parameters.properties as Record<
    string,
    Record<string, unknown>
  >;
  assert.deepEqual(properties.action?.enum, [
    "pane_create",
    "pane_list",
    "pane_read",
    "pane_wait",
    "pane_send_text",
    "pane_send_keys",
    "pane_run",
    "pane_label",
    "pane_info",
    "pane_close",
    "tab_create",
    "tab_list",
    "tab_close",
  ]);
  // workspace 面整体不出现（没有 workspace 动作，也没有 workspace 参数）
  const actions = properties.action?.enum as string[];
  assert.equal(
    actions.some((action) => action.includes("workspace")),
    false,
  );
  assert.equal("workspace" in properties, false);
  assert.equal(properties.tab_id?.type, "string");
  assert.deepEqual(properties.direction?.enum, ["right", "down"]);
  assert.deepEqual(properties.source?.enum, [
    "visible",
    "recent",
    "recent-unwrapped",
    "detection",
  ]);
  assert.deepEqual(properties.format?.enum, ["text", "ansi"]);
  assert.deepEqual(properties.keys?.items, { type: "string" });
  assert.equal(properties.keys?.type, "array");
  assert.equal(properties.stable?.type, "boolean");
  assert.equal(properties.force?.type, "boolean");
  assert.equal(properties.settle_ms?.type, "number");
  assert.equal(properties.timeout_ms?.type, "number");
  // 描述里必须写明安全边界与通道（模型据此选工具）
  assert.match(def.description, /写类动作/);
  assert.match(def.description, /只作用于本插件创建的 pane/);
  assert.match(def.description, /不带.*文件沙箱|不受.*沙箱约束/);
  assert.match(def.description, /socket/);
  assert.match(def.description, /revision/);
  // workspace 由插件内部绑定，模型看不到也传不进
  assert.match(def.description, /workspace 由插件内部按会话绑定/);
  assert.match(def.description, /写操作不出这个内部 workspace/);
  // create 的落点写明是 workspace 活动 pane（不是调用者 pane）
  assert.match(
    def.description,
    /pane_create 在本会话 workspace 的活动 pane 上切兄弟 pane/,
  );
  assert.match(def.description, /tab_create/);
  assert.match(def.description, /新 tab 自带 root pane/);
  assert.match(def.description, /无需再 pane_create/);
  assert.match(def.description, /刚建完 tab 时不必调用/);
  assert.match(def.description, /tab_close/);
});

test("工具 execute: 缺 action 返回 unknown-action 并列出可选动作", async () => {
  const { def } = tool();
  const result = await def.execute({});
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "unknown-action");
  assert.match(
    result.ok === false ? result.error.message : "",
    /pane_create \/ pane_list/,
  );
});

test("工具 execute: 合法 action 交给 dispatchAction（create 走 runner，落点是 workspace 活动 pane）", async () => {
  const fake = fakeHerdr();
  const { def } = tool({ runner: fake.runner });
  const result = await def.execute({
    action: "pane_create",
    direction: "right",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.runner.calls[0]?.[0], "workspace");
  assert.deepEqual(
    fake.runner.calls.find((args) => args[1] === "split"),
    [
      "pane",
      "split",
      "wT1:p1",
      "--direction",
      "right",
      "--cwd",
      "/tmp/proj",
      "--no-focus",
    ],
  );
});

test("render: 失败回执含失败动作、错误码、错误信息与放行提示", () => {
  const text = renderHerdrUse(
    failure("pane_run", "pane-not-registered", "pane wT1:p9 不是本插件创建的", {
      paneId: "wT1:p9",
      hint: "放行方式：用 pane_create 建新 pane",
    }),
  );
  assert.match(text, /herdr_use pane_run 失败\[pane-not-registered\]/);
  assert.match(text, /不是本插件创建的/);
  assert.match(text, /放行 \/ 下一步：放行方式：用 pane_create 建新 pane/);
});

test("render: 畸形值 / null 也能渲染（全函数，不抛）", () => {
  for (const value of [null, undefined, 42, "text", {}, { ok: true }]) {
    const text = renderHerdrUse(value);
    assert.equal(typeof text, "string");
    assert.notEqual(text, "");
  }
});

test("render: list 回执标出本插件登记项与焦点", () => {
  const text = renderHerdrUse(
    success("pane_list", {
      panes: [
        {
          pane_id: "wT1:p2",
          label: "dsh-pane",
          agent: "dsh",
          agent_status: "idle",
          registered: true,
          focused: true,
          cwd: "/tmp",
        },
        { pane_id: "wT1:p9", registered: false },
      ],
      registered: ["wT1:p2"],
    }),
  );
  assert.match(text, /herdr_use pane_list：2 个 pane/);
  assert.match(
    text,
    /\[本插件\] wT1:p2 label=dsh-pane agent=dsh\(idle\) \[焦点\]/,
  );
  assert.match(text, /本插件登记：wT1:p2/);
});

test("render: read 回执带 revision / source，空屏给明确占位", () => {
  const text = renderHerdrUse(
    success("pane_read", {
      pane_id: "wT1:p2",
      source: "recent-unwrapped",
      revision: 12,
      truncated: false,
      text: "line1\nline2",
    }),
  );
  assert.match(
    text,
    /herdr_use pane_read：pane=wT1:p2 source=recent-unwrapped revision=12/,
  );
  assert.match(text, /line1\nline2/);

  const empty = renderHerdrUse(
    success("pane_read", {
      pane_id: "wT1:p2",
      source: "visible",
      text: "",
    }),
  );
  assert.match(empty, /\(屏内容为空\)/);
});

test("render: wait 的命中形态与判稳形态文案不同（模型能区分）", () => {
  const matched = renderHerdrUse(
    success("pane_wait", {
      pane_id: "wT1:p2",
      matched: true,
      stable: false,
      matched_line: ">>> ready",
      text: ">>> ready",
    }),
  );
  assert.match(matched, /已命中：>>> ready/);

  const stable = renderHerdrUse(
    success("pane_wait", {
      pane_id: "wT1:p2",
      matched: true,
      stable: true,
      basis: "revision",
      changes: 2,
      elapsed_ms: 1200,
      text: "done",
    }),
  );
  assert.match(stable, /已判稳（basis=revision，变化 2 次，用时 1200ms）/);
});

test("render: info 无前台进程时明确说明（pane 停在 shell 提示符）", () => {
  const busy = renderHerdrUse(
    success("pane_info", {
      pane_id: "wT1:p2",
      running: true,
      shell_pid: 4242,
      foreground_processes: [
        { pid: 77, name: "python3", cmdline: "python3 -i", cwd: "/tmp" },
      ],
    }),
  );
  assert.match(busy, /running=true shell_pid=4242/);
  assert.match(busy, /pid=77 python3 {2}python3 -i/);

  const idle = renderHerdrUse(
    success("pane_info", {
      pane_id: "wT1:p2",
      running: false,
      shell_pid: 4242,
      foreground_processes: [],
    }),
  );
  assert.match(idle, /无前台进程/);
});

test("render: tab_list / tab_create / tab_close 各自要点明结果与登记标记", () => {
  const listed = renderHerdrUse(
    success("tab_list", {
      tabs: [
        {
          tab_id: "wT1:t1",
          label: "1",
          number: 1,
          pane_count: 1,
          agent_status: "idle",
          focused: true,
          registered: false,
        },
        {
          tab_id: "wT1:t2",
          label: "dsh-pane",
          number: 2,
          pane_count: 2,
          registered: true,
        },
      ],
      registered: ["wT1:t2"],
    }),
  );
  assert.match(listed, /herdr_use tab_list：本会话 workspace 有 2 个 tab/);
  assert.match(listed, /\[本插件\] wT1:t2 number=2 label=dsh-pane panes=2/);
  assert.match(listed, /本插件登记：wT1:t2/);

  const created = renderHerdrUse(
    success("tab_create", {
      tab_id: "wT1:t2",
      pane_id: "wT1:p2",
      label: "dsh-pane",
      cwd: "/tmp/proj",
    }),
  );
  assert.match(
    created,
    /已建 tab wT1:t2，自带 root pane wT1:p2（即回执的 pane_id，可直接对其 pane_run \/ pane_send_text \/ pane_read，无需再 pane_create；label=dsh-pane，cwd=\/tmp\/proj）/,
  );

  const closed = renderHerdrUse(
    success("tab_close", { tab_id: "wT1:t2", pane_id: "wT1:p2" }),
  );
  assert.match(closed, /已关闭 tab wT1:t2（root pane wT1:p2 登记项已注销）/);
  assert.match(
    renderHerdrUse(success("tab_close", { tab_id: "wT1:t2", pane_id: null })),
    /已关闭 tab wT1:t2（登记项已注销）/,
  );
});

test("render: create / send_text / send_keys / run / label / close 各自要点明结果", () => {
  const create = renderHerdrUse(
    success("pane_create", {
      pane_id: "wT1:p2",
      direction: "right",
      label: "dsh-pane",
    }),
  );
  assert.match(create, /已建 pane wT1:p2（direction=right，label=dsh-pane）/);

  assert.match(
    renderHerdrUse(success("pane_send_text", { pane_id: "wT1:p2", chars: 5 })),
    /注入 5 个字符（未回车）/,
  );
  assert.match(
    renderHerdrUse(
      success("pane_send_keys", { pane_id: "wT1:p2", keys: ["ctrl+c"] }),
    ),
    /发送按键 ctrl\+c/,
  );
  assert.match(
    renderHerdrUse(
      success("pane_run", { pane_id: "wT1:p2", command: "ls -la" }),
    ),
    /提交命令并回车：ls -la/,
  );
  assert.match(
    renderHerdrUse(
      success("pane_label", { pane_id: "wT1:p2", label: "x", cleared: false }),
    ),
    /标记为 x/,
  );
  assert.match(
    renderHerdrUse(
      success("pane_label", { pane_id: "wT1:p2", label: "", cleared: true }),
    ),
    /已清除/,
  );
  assert.match(
    renderHerdrUse(
      success("pane_close", { pane_id: "wT1:p2", was_registered: true }),
    ),
    /已关闭 pane wT1:p2（本插件登记项已注销）/,
  );
});

test("render: create 的自动打标失败以「注：」附在回执末尾", () => {
  const text = renderHerdrUse(
    success(
      "pane_create",
      { pane_id: "wT1:p2", direction: "right", label: "dsh-pane" },
      { notes: ["自动打 label 失败（pane wT1:p2 已创建并登记）"] },
    ),
  );
  assert.match(text, /注：自动打 label 失败/);
});

test("capText: 超字符 / 超行数各自截断并给收窄提示，未超时原样返回", () => {
  const limit = { lines: 2, chars: 10 };
  const unchanged = capText("short", limit, "pane_read");
  assert.deepEqual(unchanged, { text: "short", truncated: false });

  const byChars = capText("0123456789abcdef", limit, "pane_read");
  assert.equal(byChars.truncated, true);
  assert.match(byChars.text, /已截断：正文超过 10 字符/);
  assert.match(byChars.text, /用 lines 收窄行数、用 source 收窄范围/);

  const byLines = capText("a\nb\nc", { lines: 2, chars: 100 }, "pane_wait");
  assert.equal(byLines.truncated, true);
  assert.match(byLines.text, /行数超过 2 行/);
  assert.equal(byLines.text.split("\n").slice(0, 2).join("\n"), "a\nb");
});

test("render 的截断使用注入的 renderLimit（不写死 200 / 16000）", () => {
  const { def } = tool({ renderLimit: { lines: 1, chars: 1000 } });
  const text = def.output.render(
    {},
    success("pane_read", {
      pane_id: "wT1:p2",
      source: "visible",
      text: "line1\nline2\nline3",
    }),
  )[0]?.text;
  assert.match(text ?? "", /line1/);
  assert.match(text ?? "", /行数超过 1 行/);
  assert.equal(text?.includes("line3"), false);
});

test("output.schema 是宽松对象（回执形状随动作，不锁死）", () => {
  const { def } = tool();
  assert.equal(def.output.schema.type, "object");
  assert.equal(def.output.schema.additionalProperties, true);
});
