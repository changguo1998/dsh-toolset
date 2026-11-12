/**
 * tool-surface 入口单测: 服务面暴露与 ctx.provide 缺席时的降级。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resetSurfaceCatalog, wrapToolDefinition } from "../src/definition.ts";
import { apply, provide } from "../src/index.ts";

test("bundle 契约: 服务面名为 toolSurface, 不 inject 任何宿主服务", () => {
  assert.deepEqual(provide, ["toolSurface"]);
});

test("apply 暴露只读服务面 lookup / list", () => {
  resetSurfaceCatalog();
  wrapToolDefinition({
    name: "svc_tool",
    description: "用途: 服务面演示。\n边界: 无。",
    parameters: { type: "object", additionalProperties: true, properties: {} },
  });
  const provided = new Map<string, unknown>();
  apply({
    provide: (serviceName: string, value: unknown) => {
      provided.set(serviceName, value);
    },
  });

  const face = provided.get("toolSurface") as {
    lookup(name: string): { description: string } | undefined;
    list(): unknown[];
  };
  assert.ok(face);
  assert.match(face.lookup("svc_tool")?.description ?? "", /服务面演示/);
  assert.equal(face.list().length, 1);
  assert.equal(face.lookup("missing_tool"), undefined);
});

test("ctx.provide 缺席时只告警, 不抛错", () => {
  const warnings: string[] = [];
  const dispose = apply({
    logger: { warn: (message: string) => warnings.push(message) },
  });

  assert.equal(typeof dispose, "function");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /ctx\.provide 不可用/);
});
