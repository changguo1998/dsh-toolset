// tool-consult/tests/dual-track.test.ts — 双轨：接入包装层的工具「声明常驻 + 派发拒绝 + JSON 全文投递」。

import { test } from "node:test";
import assert from "node:assert/strict";

import { assemble, STANDARD_SCHEMAS } from "./assemble.ts";
import type { FakeToolSchema } from "./fake-host.ts";

/** hold 登记记录。 */
interface HoldRecord {
  key: string;
  provider: (context: { sessionId: string }) => string | undefined;
}

/** 造一个记录 hold 的假 pinNotes 面。 */
function pinNotesFace(holds: HoldRecord[]): {
  hold(key: string, provider: HoldRecord["provider"]): () => void;
} {
  return {
    hold(key, provider) {
      holds.push({ key, provider });
      return () => {};
    },
  };
}

/** 接入包装层的一条工具全文。 */
interface SurfaceEntry {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/** 假的 toolSurface 服务面（lookup / list 与真包同形）。 */
function fakeSurface(entries: SurfaceEntry[]): {
  lookup(name: string): SurfaceEntry | undefined;
  list(): SurfaceEntry[];
} {
  return {
    lookup: (name) => entries.find((entry) => entry.name === name),
    list: () => [...entries],
  };
}

/** 参数 schema 的一条示例。 */
const RULE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string" } },
};

/** `tools/pre-execute` 的拒绝结果形态。 */
interface DenyDecision {
  kind: string;
  reason?: string;
  info?: { name?: string; code?: string };
}

test("接入工具：声明常驻、未揭示派发拒绝、揭示后放行", async () => {
  const holds: HoldRecord[] = [];
  const a = assemble({
    serviceValues: {
      pinNotes: pinNotesFace(holds),
      toolSurface: fakeSurface([
        {
          name: "rule_add",
          description:
            "用途: 往规则引擎里登记一条关键词触发规则。\n边界: 只登记。",
          parameters: RULE_PARAMETERS,
        },
      ]),
    },
  });
  a.apply();
  const agent = a.addAgent({ id: "w1" });

  // 声明常驻：遮罩名单里有它（模型侧看得见），不随揭示进出
  assert.ok((a.host.activeMask() ?? []).includes("rule_add"));

  const denied = agent.emit("tools/pre-execute", { name: "rule_add" }, () => ({
    kind: "allow",
  })) as DenyDecision;
  assert.equal(denied.kind, "deny");
  assert.equal(
    denied.reason,
    "tool rule_add 未在当前会话揭示, 请先经 tool_consult 查询后再调用",
  );
  assert.equal(denied.info?.code, "TOOL_NOT_REVEALED");

  await a.execute({ names: ["rule_add"] });
  const allowed = agent.emit("tools/pre-execute", { name: "rule_add" }, () => ({
    kind: "allow",
  }));
  assert.deepEqual(allowed, { kind: "allow" });

  // 揭示后投递 JSON：完整说明 + input_schema
  const text = holds[0]?.provider({ sessionId: "w1" });
  assert.ok(text !== undefined);
  assert.match(text, /已揭示工具/);
  const after = text.split("rule_add:\n")[1] ?? "";
  const payload = JSON.parse(after.split("\n")[0] ?? "{}") as {
    description?: string;
    input_schema?: unknown;
  };
  assert.equal(
    payload.description,
    "用途: 往规则引擎里登记一条关键词触发规则。\n边界: 只登记。",
  );
  assert.deepEqual(payload.input_schema, RULE_PARAMETERS);
  a.dispose();
});

test("接入工具：检索语料取全文（注册定义只剩短说明）", async () => {
  const short: FakeToolSchema = {
    name: "rule_add",
    description: "用途: 加规则; 完整说明与参数 schema 经 tool_consult 查询。",
    parameters: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
  };
  const a = assemble({
    schemas: STANDARD_SCHEMAS.map((schema) =>
      schema.name === "rule_add" ? short : schema,
    ),
    serviceValues: {
      toolSurface: fakeSurface([
        {
          name: "rule_add",
          description: "用途: 往规则引擎里登记一条关键词触发规则。",
          parameters: RULE_PARAMETERS,
        },
      ]),
    },
  });
  a.apply();
  a.addAgent({ id: "w2" });

  const text = await a.executeText({ query: "规则引擎", reveal: false });
  assert.match(text, /rule_add/);
  a.dispose();
});

test("maskMode off：不做工具面管理, 接入工具也不再拒绝", async () => {
  const a = assemble({
    serviceValues: {
      toolSurface: fakeSurface([
        {
          name: "rule_add",
          description: "用途: 加规则。",
          parameters: RULE_PARAMETERS,
        },
      ]),
    },
  });
  a.apply({ maskMode: "off" });
  const agent = a.addAgent({ id: "w3" });

  const allowed = agent.emit("tools/pre-execute", { name: "rule_add" }, () => ({
    kind: "allow",
  }));
  assert.deepEqual(allowed, { kind: "allow" });
  assert.equal(a.host.activeMask(), undefined, "off 档不挂遮罩");
  a.dispose();
});

test("disabledWhenTools：不进检索索引、不进遮罩名单", async () => {
  const a = assemble({
    schemas: [
      ...STANDARD_SCHEMAS,
      { name: "team_task_list", description: "列出团队任务。", parameters: {} },
    ],
    serviceValues: {
      toolSurface: fakeSurface([
        {
          name: "rule_add",
          description: "用途: 加规则。",
          parameters: RULE_PARAMETERS,
        },
      ]),
    },
  });
  a.apply();
  a.addAgent({ id: "w4" });

  assert.equal(
    (a.host.activeMask() ?? []).includes("team_task_list"),
    false,
    "缺省禁用的 when 工具不应出现在遮罩名单里",
  );
  const text = await a.executeText({ names: ["team_task_list"] });
  assert.match(text, /未知工具/);
  a.dispose();
});

test("过渡期：未接入工具仍走旧遮罩文案, 揭示进 allow 名单", async () => {
  const a = assemble({
    serviceValues: {
      toolSurface: fakeSurface([
        {
          name: "rule_add",
          description: "用途: 加规则。",
          parameters: RULE_PARAMETERS,
        },
      ]),
    },
  });
  a.apply();
  const agent = a.addAgent({ id: "w5" });

  const before = agent.emit(
    "tools/pre-execute",
    { name: "task_decompose" },
    () => ({ kind: "allow" }),
  ) as DenyDecision;
  assert.equal(before.kind, "deny");
  assert.match(before.reason ?? "", /当前不可见（被 tool-consult 管理）/);
  assert.equal(before.info, undefined, "旧路径不带自定义错误码");

  await a.execute({ names: ["task_decompose"] });
  assert.ok((a.host.activeMask() ?? []).includes("task_decompose"));
  a.dispose();
});
