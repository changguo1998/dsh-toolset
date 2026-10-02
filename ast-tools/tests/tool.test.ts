/**
 * 模型侧工具面测试（ast_query / ast_replace）：
 * - 注册行为与二进制缺失 fail-closed（无需二进制，恒跑）；
 * - 参数校验分支（无需二进制：桩 ops 会在被调用时抛错，用于证明「非法入参不触发子进程」）；
 * - 渲染格式与预算（1 基换算、截断标记、render 形参顺序）；
 * - dry-run 默认不写文件 / write:true 写回（需真二进制，条件跑）。
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  apply,
  createAstToolsBundle,
  inject,
  name,
  RENDER_LIMIT,
  toToolDefs,
  unavailableOps,
} from "../src/index.ts";
import type { AstOperations } from "../src/tools.ts";
import type { AstMatch, AstRuleHit } from "../src/types.ts";
import { astTest, withTempDir } from "./helpers.ts";

/** 工具定义的最小结构面（与 tools.ts 产出一致）。 */
interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: string;
    required?: string[];
    properties: Record<string, unknown>;
  };
  execute(args: Record<string, unknown>): Promise<unknown>;
  output: {
    schema: { type: string };
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: string }>;
  };
}

/** 捕获注册的宿主桩。 */
function mockHost(): {
  defs: unknown[];
  logs: string[];
  host: {
    tools: { register(def: unknown): void };
    logger(ns: string): { info(message: string): void };
  };
} {
  const defs: unknown[] = [];
  const logs: string[] = [];
  return {
    defs,
    logs,
    host: {
      tools: { register: (def) => defs.push(def) },
      logger: (ns) => ({
        info: (message: string) => logs.push(`${ns}: ${message}`),
      }),
    },
  };
}

/** 桩 ops：任何调用都视为「不该发生的子进程」，用于参数校验用例。 */
function throwingOps(): AstOperations {
  const boom = (): never => {
    throw new Error("非法入参不应触达 ast-grep 子进程");
  };
  return {
    search: async () => boom(),
    replace: async () => boom(),
    outline: async () => boom(),
    rules: async () => boom(),
  };
}

function defs(): { query: ToolDef; replace: ToolDef } {
  const [query, replace] = toToolDefs(throwingOps()) as ToolDef[];
  assert.ok(query !== undefined && replace !== undefined);
  return { query, replace };
}

/** 真实 bundle 的工具定义（需二进制；仅条件用例使用）。 */
function realDefs(): { query: ToolDef; replace: ToolDef } {
  const [query, replace] = toToolDefs(createAstToolsBundle()) as ToolDef[];
  assert.ok(query !== undefined && replace !== undefined);
  return { query, replace };
}

function textOf(def: ToolDef, value: unknown): string {
  // render 契约：args 第一、value 第二（写反会让模型只拿到入参回显）
  return def.output.render({ probe: true }, value)[0]?.text ?? "";
}

/** 一条 0 基坐标的命中。 */
function matchAt(line: number, column: number, text = "foo()"): AstMatch {
  return {
    text,
    file: "/tmp/a.ts",
    range: {
      start: { line, column },
      end: { line, column: column + text.length },
      byteOffset: { start: 0, end: text.length },
    },
  };
}

// ---- 无需二进制的用例（恒跑）----

test("apply 注册 ast_query / ast_replace，契约面完整", () => {
  const { defs: registered, logs, host } = mockHost();
  apply(host, { bin: process.execPath }); // 任意可执行文件即可通过探测（不真的调用 CLI）
  assert.deepEqual(
    registered.map((d) => (d as ToolDef).name),
    ["ast_query", "ast_replace"],
  );
  assert.equal(name, "ast-tools");
  assert.deepEqual(inject, ["tools"]);
  for (const def of registered as ToolDef[]) {
    // 宿主强制：output.schema 必须存在且为受支持的 JSON Schema，render 必须是函数
    assert.equal(def.output.schema.type, "object");
    assert.equal(typeof def.output.render, "function");
    assert.equal(def.parameters.type, "object");
  }
  assert.ok(logs.some((l) => l.includes("ast-tools ready")));
});

test("二进制缺失时注册降级工具：调用返回含安装指引的 error（fail-closed 但不隐藏能力）", async () => {
  const { defs: registered, logs, host } = mockHost();
  apply(host, { bin: "/nonexistent/ast-grep" });
  assert.deepEqual(
    registered.map((d) => (d as ToolDef).name),
    ["ast_query", "ast_replace"],
    "降级时仍注册工具（口径对齐 code-map 的降级 bundle）",
  );
  assert.ok(logs.join("\n").includes("降级"));
  for (const def of registered as ToolDef[]) {
    const value = (await def.execute({ action: "search" })) as { error?: string };
    assert.ok(
      value.error?.includes("npm install -g @ast-grep/cli"),
      `降级调用应给安装指引，实际：${JSON.stringify(value)}`,
    );
    assert.ok(textOf(def, value).includes("失败"));
  }
  // 替身 ops 本身不应被调用（execute 短路）
  const stub = unavailableOps("x");
  assert.equal(stub.unavailable, "x");
});

test("render 是全函数：畸形值不抛，且形参顺序为 (args, value)", () => {
  const { query, replace } = defs();
  for (const bad of [undefined, null, {}, 42, "text", []]) {
    for (const def of [query, replace]) {
      const blocks = def.output.render({}, bad);
      assert.equal(blocks[0]?.type, "text");
      assert.ok(typeof blocks[0]?.text === "string");
    }
  }
  // 哨兵探针（有鉴别力）：第一参是 args、第二参是 value，渲染文本只由第二参决定。
  // 哨兵放 **value 形状的第二参**，第一参用 args 形状并带一个「不该被渲染」的标记：
  // 形参写反 / 少参（单形参实现）时渲染器拿到的是第一参 → 文本不含哨兵 → 断言必失败。
  // （本包 render 签名是 `(_args, value)`：args 不参与输出，故哨兵只有放 value 位才可能出现。）
  // 原先的 `textOf(query, value) !== render(value)` 无鉴别力：两种实现下两个文本本来就不同。
  // args 形状与 value **同形**，标记放在渲染器会回显的字段里
  // ast_replace 的渲染按它自己的 value 形状（matches/written）读，故两个工具各给对应形状
  const probes: Array<[unknown, unknown]> = [
    [
      { action: "outline", files: [{ path: "ARGS_MARKER_NOT_RENDERED", language: "ts", items: [] }] },
      { action: "outline", files: [{ path: "SENTINEL_VALUE_MARKER", language: "ts", items: [] }] },
    ],
    [
      { action: "replace", matches: [{ file: "ARGS_MARKER_NOT_RENDERED", line: 1, text: "x" }], replacedCount: 1, written: false },
      { action: "replace", matches: [{ file: "SENTINEL_VALUE_MARKER", line: 1, text: "x" }], replacedCount: 1, written: false },
    ],
  ];
  for (const [index, tool] of [query, replace].entries()) {
  const [probeArgs, probeValue] = probes[index] ?? [undefined, undefined];
  const text = tool.output.render(probeArgs, probeValue)[0]?.text ?? "";
  assert.equal(typeof text, "string");
  assert.ok(
    text.includes("SENTINEL_VALUE_MARKER"),
    "渲染的必须是第二参（value）",
  );
  assert.ok(
    !text.includes("ARGS_MARKER_NOT_RENDERED"),
    "第一参（args）不该被当成 value 渲染",
  );
  }
});

test("ast_query 参数校验：返回 {error} 且不触达子进程", async () => {
  const { query } = defs();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ action: "nope" }, "未知 action"],
    [{ action: "search", language: "ts", path: "a.ts" }, "pattern"],
    [{ action: "search", pattern: "foo()", path: "a.ts" }, "language"],
    [{ action: "search", pattern: "foo()", language: "ts" }, "path"],
    [{ action: "outline" }, "path"],
    [{ action: "rules", paths: ["a.ts"] }, "rulePath 或 rules"],
    [
      { action: "rules", rulePath: "r.yml", rules: "id: x", paths: ["a.ts"] },
      "二选一",
    ],
    [{ action: "rules", rules: "id: x", paths: [] }, "paths"],
  ];
  for (const [args, needle] of cases) {
    const value = (await query.execute(args)) as { error?: string };
    assert.ok(
      typeof value.error === "string" && value.error.includes(needle),
      `args=${JSON.stringify(args)} 应报含「${needle}」的错误，实际：${JSON.stringify(value)}`,
    );
  }
});

test("ast_replace 参数校验：缺参报错且不触达子进程", async () => {
  const { replace } = defs();
  const value = (await replace.execute({
    pattern: "foo()",
    language: "ts",
    path: "a.ts",
  })) as { error?: string };
  assert.ok(value.error?.includes("replacement"));
});

test("事实描述：写清与文本检索 / 改写的选择成本", () => {
  const { query, replace } = defs();
  assert.ok(query.description.includes("grep"));
  assert.ok(query.description.includes("AST"));
  assert.ok(replace.description.includes("dry-run"));
  assert.ok(replace.description.includes("hash_edit"));
  assert.deepEqual(query.parameters.required, ["action"]);
  // minSeverity 枚举不含非法值 help（ast-grep CLI 只接受 hint/info/warning/error/off）
  const minSeverity = (
    query.parameters.properties.minSeverity as { enum: string[] }
  ).enum;
  assert.ok(!minSeverity.includes("help"), JSON.stringify(minSeverity));
  assert.ok(minSeverity.includes("hint"), JSON.stringify(minSeverity));
  assert.deepEqual(replace.parameters.required, [
    "pattern",
    "replacement",
    "language",
    "path",
  ]);
});

test("渲染：坐标转 1 基、元变量摘要、空结果与预算截断", () => {
  const { query } = defs();
  const one = textOf(query, { action: "search", matches: [matchAt(0, 4)] });
  assert.equal(one, "/tmp/a.ts:1:5  foo()");

  const meta = textOf(query, {
    action: "search",
    matches: [
      {
        ...matchAt(2, 0, "console.log(add(1, 2))"),
        metaVariables: {
          single: { ARG: { text: "add(1, 2)", range: matchAt(2, 12).range } },
          multi: { ARGS: [matchAt(2, 12), matchAt(2, 20)] },
        },
      },
    ],
  });
  assert.match(meta, /^\/tmp\/a\.ts:3:1 {2}console\.log\(add\(1, 2\)\)/);
  assert.ok(meta.includes("$ARG=add(1, 2)"));
  assert.ok(meta.includes("$$ARGS=2节点"));

  assert.equal(textOf(query, { action: "search", matches: [] }), "(无命中)");
  assert.equal(textOf(query, { action: "outline", files: [] }), "(无符号)");
  assert.equal(textOf(query, { action: "rules", hits: [] }), "(无规则命中)");
  assert.equal(
    textOf(query, { error: "search 需要 pattern / language / path 三个参数" }),
    "ast_query 失败：search 需要 pattern / language / path 三个参数",
  );

  const many = Array.from({ length: RENDER_LIMIT + 5 }, (_, i) =>
    matchAt(i, 0),
  );
  const capped = textOf(query, { action: "search", matches: many });
  assert.equal(capped.split("\n").length, RENDER_LIMIT + 1);
  assert.ok(capped.endsWith("…（其余 5 条略）"));
});

test("渲染：outline 缩进 + rules 严重度/规则号 + replace 预览措辞", () => {
  const { query, replace } = defs();
  const outline = textOf(query, {
    action: "outline",
    files: [
      {
        path: "/tmp/a.ts",
        language: "TypeScript",
        items: [
          {
            role: "item",
            symbolType: "class",
            name: "Counter",
            range: matchAt(9, 0).range,
            signature: "class Counter {",
            astKind: "class_declaration",
            isImport: false,
            isExported: true,
            members: [
              {
                role: "member",
                symbolType: "method",
                name: "inc",
                range: matchAt(12, 2).range,
                signature: "inc(): number {",
                astKind: "method_definition",
                isImport: false,
                isExported: false,
              },
            ],
          },
        ],
      },
    ],
  });
  assert.match(outline, /^\/tmp\/a\.ts（TypeScript）$/m);
  assert.match(outline, /^ {2}L10 class Counter {2}class Counter \{$/m);
  assert.match(outline, /^ {4}L13 method inc {2}inc\(\): number \{$/m);

  const hit: AstRuleHit = {
    ...matchAt(4, 6),
    ruleId: "no-console",
    severity: "warning",
    message: "避免 console",
  };
  assert.equal(
    textOf(query, { action: "rules", hits: [hit] }),
    "/tmp/a.ts:5:7 warning no-console: 避免 console",
  );

  const preview = textOf(replace, {
    replacedCount: 1,
    written: false,
    matches: [
      { ...matchAt(1, 0, "console.log(x)"), replacement: "logger.info(x)" },
    ],
  });
  assert.ok(preview.includes("未写回"));
  assert.ok(preview.includes("console.log(x) → logger.info(x)"));

  const written = textOf(replace, {
    replacedCount: 2,
    written: true,
    matches: [],
  });
  assert.ok(written.includes("已替换 2 处并写回"));
});

// ---- 需真二进制的用例 ----

astTest("ast_replace 默认 dry-run 不写文件，write:true 才写回", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = `${dir}/a.ts`;
    writeFileSync(file, "console.log(add(1, 2));\n", "utf8");
    const { replace } = realDefs();

    const dry = (await replace.execute({
      pattern: "console.log($ARG)",
      replacement: "logger.info($ARG)",
      language: "ts",
      path: file,
    })) as { written: boolean; replacedCount: number };
    assert.equal(dry.written, false);
    assert.equal(dry.replacedCount, 1);
    assert.equal(readFileSync(file, "utf8"), "console.log(add(1, 2));\n");

    const real = (await replace.execute({
      pattern: "console.log($ARG)",
      replacement: "logger.info($ARG)",
      language: "ts",
      path: file,
      write: true,
    })) as { written: boolean; replacedCount: number };
    assert.equal(real.written, true);
    assert.equal(readFileSync(file, "utf8"), "logger.info(add(1, 2));\n");
  } finally {
    cleanup();
  }
});

astTest("ast_query：search 命中与 outline 骨架走真二进制", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = `${dir}/a.ts`;
    writeFileSync(file, "export function f(): void {}\nf();\n", "utf8");
    const { query } = realDefs();

    const search = (await query.execute({
      action: "search",
      pattern: "f()",
      language: "ts",
      path: file,
    })) as { matches: AstMatch[] };
    assert.equal(search.matches.length, 1);
    const rendered = textOf(query, search);
    assert.ok(rendered.includes(":2:"), rendered);

    const outline = (await query.execute({
      action: "outline",
      path: file,
    })) as {
      files: Array<{ items: Array<{ name: string }> }>;
    };
    assert.ok(
      outline.files[0]?.items.some((i) => i.name === "f"),
      JSON.stringify(outline),
    );
  } finally {
    cleanup();
  }
});
