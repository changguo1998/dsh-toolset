/**
 * tool-surface + tool-consult 双轨端到端：真实宿主装配下的「常驻声明 + 未揭示拒绝 + 揭示后放行」。
 *
 * 夹具起真实 dsh 树（`dsh-base` + tool-consult + tool-surface + fs-digest），工具经
 * `ctx.tools.execute()` 调用，断言的是宿主真实投影与真实派发结果，不是单测里的假件。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("tool-surface：接入工具常驻工具面, 未揭示拒绝, 揭示后放行", async (t) => {
  const host = await bootPackage("tool-consult", {
    extraPackages: ["tool-surface", "fs-digest"],
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-surface");
  t.after(async () => agent.dispose());

  const tools = host.ctx.tools as {
    schemas(agent?: unknown): Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
  };
  const view = tools
    .schemas(agent.agent)
    .find((tool) => tool.name === "fs_digest");
  assert.ok(view, "接入包装层的工具应常驻工具面（声明常驻）");
  assert.match(String(view.description), /tool_consult/);
  assert.equal(view.parameters?.["additionalProperties"], true);
  assert.equal(view.parameters?.["properties"] !== undefined, true);

  // 未揭示：派发被拦，错误码来自 tool-consult 的 deny info
  const denied = await host.callTool(
    "fs_digest",
    { path: "x.md", mode: "outline" },
    { agent: agent.agent },
  );
  assert.equal(denied.isError, true);
  assert.equal(denied.error?.info?.code, "TOOL_NOT_REVEALED", textOf(denied));

  // 揭示后放行（文件不存在 → 工具级错误，但不再是未揭示拒绝）
  const consulted = await host.callTool(
    "consult_tools",
    { names: ["fs_digest"] },
    { agent: agent.agent },
  );
  assert.equal(consulted.isError, false, textOf(consulted));
  const after = await host.callTool(
    "fs_digest",
    { path: "x.md", mode: "outline" },
    { agent: agent.agent },
  );
  assert.notEqual(after.error?.info?.code, "TOOL_NOT_REVEALED", textOf(after));
});

test("tool-surface：参数按完整 schema 严格校验（INVALID_ARGS）", async (t) => {
  const host = await bootPackage("tool-consult", {
    extraPackages: ["tool-surface", "fs-digest"],
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-surface-args");
  t.after(async () => agent.dispose());

  // 先揭示（否则派发先被未揭示拦截，轮不到参数校验）
  const consulted = await host.callTool(
    "consult_tools",
    { names: ["fs_digest"] },
    { agent: agent.agent },
  );
  assert.equal(consulted.isError, false, textOf(consulted));

  // 缺必填 path：宿主侧宽松占位放行，包装层按完整 schema 拒绝
  const result = await host.callTool("fs_digest", {}, { agent: agent.agent });
  assert.equal(result.isError, true);
  assert.equal(result.error?.info?.code, "INVALID_ARGS", textOf(result));
  assert.match(textOf(result), /path/);

  // 探针：完整 schema 经 toolSurface 服务可取到（服务面在真实宿主里可见）
  const surface = host.ctx.get?.("toolSurface") as
    | {
        lookup(
          name: string,
        ):
          | { description?: string; parameters?: Record<string, unknown> }
          | undefined;
      }
    | undefined;
  assert.ok(surface !== undefined, "toolSurface 服务应已暴露");
  const full = surface.lookup("fs_digest");
  assert.ok(full !== undefined);
  const properties = full.parameters?.["properties"] as
    Record<string, unknown> | undefined;
  assert.ok(properties?.["path"], "完整 schema 应含 path 属性");
});
