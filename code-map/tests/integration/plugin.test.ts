/**
 * 集成层: `apply` 与宿主接线 (工具注册与 execute、`output.render` 投影、
 * `codeMap` 服务面、`ctx.get("lsp")` 语义层接线、宿主形态防御).
 *
 * 用 `tests/assemble.ts` 的假 astTools / 假工具面 / 假服务面拼宿主, 项目落在
 * `os.tmpdir()` 的临时目录, 用例结束删除; 不依赖 ast-grep 二进制.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { getCodeMapBundle } from "../../src/index.ts";
import type { LspReferencesProvider } from "../../src/semantic/lsp.ts";
import {
  assemble,
  makeProject,
  type Assembled,
  type Workspace,
} from "../assemble.ts";

/** 一次装配 + 临时项目, 用例结束统一清理. */
async function setup(
  options: {
    shape?: "full" | "no-tools" | "no-provide" | "no-logger";
    registerThrows?: boolean;
    lsp?: LspReferencesProvider;
  } = {},
): Promise<{ ws: Workspace; host: Assembled }> {
  const ws = await makeProject();
  const host = await assemble({ root: ws.dir, ...options });
  return { ws, host };
}

/** 索引后释放临时目录 (共享 `activeBundle` 由下一次 apply 覆盖, 不需复位). */
async function cleanup(ws: Workspace): Promise<void> {
  await ws.cleanup();
}

test("apply: 注册 code_map 单工具与 codeMap 服务面, 零事件订阅", async () => {
  const { ws, host } = await setup();
  try {
    assert.deepEqual(host.tools.names(), ["code_map"], "只注册 code_map");
    const def = host.tool();
    assert.equal(def.parameters.type, "object");
    assert.deepEqual(def.parameters.required, ["action"]);
    assert.deepEqual(def.parameters.properties["action"]?.enum, [
      "index",
      "refresh",
      "callers",
      "callees",
      "impact",
      "cycles",
      "report",
      "summary",
    ]);
    assert.deepEqual(host.services.names(), ["codeMap"], "提供 codeMap 面");
    assert.equal(host.events.listenerCount(), 0, "本包不订阅事件");
    assert.deepEqual(host.logs, []);
    assert.deepEqual(host.stderr, []);
    // 未索引: 服务面摘要为空
    assert.equal(host.facade().getSummary(), undefined);
    assert.equal(host.facade().getBundle(), getCodeMapBundle());
  } finally {
    await cleanup(ws);
  }
});

test("工具: index 惰性建索引并返回 canonical IndexResult", async () => {
  const { ws, host } = await setup();
  try {
    const result = (await host.execute({ action: "index" })) as Record<
      string,
      unknown
    >;
    assert.equal(result["ready"], true);
    assert.equal(
      result["files"],
      5,
      "files 是扫到的源码文件数 (含 outline 失败的那个)",
    );
    assert.equal(
      result["symbols"],
      6,
      "Auth + authenticate + helper + use + orphan + main",
    );
    assert.equal(result["imports"], 3, "b→a、main→b、main→node:fs");
    assert.equal(result["unresolved"], 1, "node:fs 记外部");
    assert.equal(typeof result["elapsedMs"], "number");
    assert.ok((result["elapsedMs"] as number) >= 0);
    // 扫过全部源码文件 (含 outline 失败的那个)
    assert.equal(host.ast.outlineCalls.length, 5);
    assert.ok(
      host.ast.outlineCalls.includes(ws.path("broken/gen.ts")),
      "失败文件也被尝试过一次",
    );
  } finally {
    await cleanup(ws);
  }
});

test("工具: 已索引时 index 返回摘要, summary 报根与计数", async () => {
  const { ws, host } = await setup();
  try {
    await host.execute({ action: "index" });
    assert.deepEqual(await host.execute({ action: "summary" }), {
      ready: true,
      root: ws.dir,
      files: 4,
      symbols: 6,
    });
    const again = (await host.execute({ action: "index" })) as Record<
      string,
      unknown
    >;
    assert.deepEqual(again, {
      ready: true,
      files: 4,
      symbols: 6,
      imports: 0,
      unresolved: 1,
      elapsedMs: 0,
    });
    assert.equal(host.ast.outlineCalls.length, 5, "摘要路径不再扫描");
  } finally {
    await cleanup(ws);
  }
});

test("工具: 未索引时 summary 兜底 {ready:false}", async () => {
  const { ws, host } = await setup();
  try {
    assert.deepEqual(await host.execute({ action: "summary" }), {
      ready: false,
    });
  } finally {
    await cleanup(ws);
  }
});

test("工具: callers 返回 canonical 候选与 precision=structural", async () => {
  const { ws, host } = await setup();
  try {
    await host.execute({ action: "index" });
    const b = ws.path("core/b.ts");
    assert.deepEqual(
      await host.execute({ action: "callers", symbol: "Auth" }),
      {
        symbol: "Auth",
        refs: [{ file: b, line: 2, column: 15, text: "Auth" }],
        files: [b],
        precision: "structural",
      },
    );
    assert.deepEqual(host.ast.searchCalls, ["Auth"], "候选引用按符号名搜一次");
  } finally {
    await cleanup(ws);
  }
});

test("工具: callers 的 file 限定与未知符号空结果", async () => {
  const { ws, host } = await setup();
  try {
    await host.execute({ action: "index" });
    const a = ws.path("core/a.ts");
    const b = ws.path("core/b.ts");
    // 限定在定义文件: file 只限定符号归属, 引用仍按全仓候选 (定义区间内的命中被排除)
    assert.deepEqual(
      await host.execute({ action: "callers", symbol: "Auth", file: a }),
      {
        symbol: "Auth",
        refs: [{ file: b, line: 2, column: 15, text: "Auth" }],
        files: [b],
        precision: "structural",
      },
    );
    // 限定在非定义文件: 该文件内没有同名符号
    assert.deepEqual(
      await host.execute({ action: "callers", symbol: "Auth", file: b }),
      { symbol: "Auth", refs: [], files: [], precision: "structural" },
    );
    // 未索引也能查 (隐式建索引)
    assert.deepEqual(await host.execute({ action: "callees", symbol: "use" }), {
      files: [a],
    });
    assert.deepEqual(
      await host.execute({ action: "callees", symbol: "Nope" }),
      { files: [] },
    );
  } finally {
    await cleanup(ws);
  }
});

test("工具: impact 需 file, 结果聚合到模块", async () => {
  const { ws, host } = await setup();
  try {
    assert.deepEqual(await host.execute({ action: "impact" }), {
      error: "impact 需要 file 参数",
    });
    await host.execute({ action: "index" });
    const a = ws.path("core/a.ts");
    const b = ws.path("core/b.ts");
    const main = ws.path("cli/main.ts");
    assert.deepEqual(await host.execute({ action: "impact", file: a }), {
      target: a,
      files: [main, b],
      modules: ["cli", "core"],
    });
    assert.deepEqual(await host.execute({ action: "impact", file: b }), {
      target: b,
      files: [main],
      modules: ["cli"],
    });
  } finally {
    await cleanup(ws);
  }
});

test("工具: cycles 不隐式建索引, 索引后返回空环", async () => {
  const { ws, host } = await setup();
  try {
    assert.deepEqual(await host.execute({ action: "cycles" }), {
      ok: false,
      error: "not_indexed",
      hint: "先调用 index / refresh 建索引（cycles 不隐式建索引）",
    });
    await host.execute({ action: "index" });
    assert.deepEqual(await host.execute({ action: "cycles" }), []);
  } finally {
    await cleanup(ws);
  }
});

test("工具: report 未索引给错误, 索引后出项目报告", async () => {
  const { ws, host } = await setup();
  try {
    assert.deepEqual(await host.execute({ action: "report" }), {
      error: "未索引（先调用 index）",
    });
    await host.execute({ action: "index" });
    const report = (await host.execute({ action: "report" })) as Record<
      string,
      unknown
    >;
    assert.equal(report["root"], ws.dir);
    assert.equal(report["fileCount"], 4);
    assert.equal(report["symbolCount"], 6);
    assert.equal(report["importCount"], 2, "只算仓库内已解析的边");
    assert.equal(report["unresolvedImportCount"], 1);
    assert.deepEqual(report["languageCounts"], { typescript: 4 });
    // lexical_declaration 与空 astKind 都落 other (kindBucket 只认 class/interface/
    // enum/function/variable/type/import 词根, 见包追踪文档「实现记录」的观察项)
    assert.deepEqual(report["kindCounts"], {
      class: 1,
      function: 3,
      other: 2,
    });
    assert.deepEqual(report["moduleCycles"], []);
    assert.deepEqual(report["unimportedExportFiles"], [
      ws.path("cli/main.ts"),
      ws.path("core/d.ts"),
    ]);
    const modules = report["modules"] as Array<Record<string, unknown>>;
    assert.deepEqual(
      modules.map((m) => m["name"]),
      ["cli", "core"],
      "模块按名排序, 无 root 直接文件故无 . 模块",
    );
    assert.deepEqual(modules[0], {
      name: "cli",
      fileCount: 1,
      symbolCount: 1,
      imports: ["core"],
      importedBy: [],
    });
    assert.deepEqual(modules[1], {
      name: "core",
      fileCount: 3,
      symbolCount: 5,
      imports: [],
      importedBy: ["cli"],
    });
  } finally {
    await cleanup(ws);
  }
});

test("工具: refresh 重扫, 未知 action 报错", async () => {
  const { ws, host } = await setup();
  try {
    await host.execute({ action: "index" });
    const refreshed = (await host.execute({ action: "refresh" })) as Record<
      string,
      unknown
    >;
    assert.equal(refreshed["ready"], true);
    assert.equal(refreshed["imports"], 3, "refresh 重扫后 import 数回到 3");
    assert.equal(host.ast.outlineCalls.length, 10, "两轮各扫 5 个文件");
    // 不带 root 的 refresh 沿用已索引根
    await host.execute({ action: "refresh" });
    assert.equal(host.ast.outlineCalls.length, 15);
    assert.deepEqual(await host.execute({ action: "nope" }), {
      error: "未知 action: nope",
    });
  } finally {
    await cleanup(ws);
  }
});

test("output.render: 投影第二参为 JSON 文本 (含 undefined / 字符串)", async () => {
  const { ws, host } = await setup();
  try {
    await host.execute({ action: "index" });
    const summary = await host.execute({ action: "summary" });
    const blocks = host.render(summary);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, "text");
    const text = String(blocks[0]?.text);
    assert.ok(text.startsWith("{"), `JSON 文本 (实际 ${text.slice(0, 20)})`);
    assert.ok(text.includes(`"root": ${JSON.stringify(ws.dir)}`));
    // 未索引摘要走同一投影, 仍是 string
    const fallback = host.render({ ready: false });
    assert.equal(typeof fallback[0]?.text, "string");
    assert.ok(String(fallback[0]?.text).includes('"ready": false'));
    // undefined / 字符串的兜底
    assert.equal(host.render(undefined)[0]?.text, "undefined");
    assert.equal(host.render("already text")[0]?.text, "already text");
    // 形参顺序哨兵: 渲染的必须是第二参
    const ordered = host.render(
      { marker: "VALUE_MARKER" },
      { marker: "ARGS_MARKER" },
    );
    assert.ok(String(ordered[0]?.text).includes("VALUE_MARKER"));
    assert.ok(!String(ordered[0]?.text).includes("ARGS_MARKER"));
  } finally {
    await cleanup(ws);
  }
});

test("服务面: codeMap.getSummary / getBundle 反映当前 bundle", async () => {
  const { ws, host } = await setup();
  try {
    await host.execute({ action: "index" });
    const facade = host.facade();
    assert.deepEqual(facade.getSummary(), {
      ready: true,
      root: ws.dir,
      files: 4,
      symbols: 6,
    });
    const bundle = facade.getBundle() as { cycles(): unknown[] };
    assert.deepEqual(bundle.cycles(), []);
    assert.equal(facade.getBundle(), getCodeMapBundle());
  } finally {
    await cleanup(ws);
  }
});

test("宿主形态: 缺 tools / 缺 provide / register 抛错只告警", async () => {
  // 缺 ctx.tools: 仍提供 codeMap 面
  const noTools = await setup({ shape: "no-tools" });
  try {
    assert.deepEqual(noTools.host.tools.names(), []);
    assert.deepEqual(noTools.host.services.names(), ["codeMap"]);
    assert.deepEqual(noTools.host.stderr, []);
  } finally {
    await cleanup(noTools.ws);
  }
  // 缺 ctx.provide: 仍注册工具
  const noProvide = await setup({ shape: "no-provide" });
  try {
    assert.deepEqual(noProvide.host.tools.names(), ["code_map"]);
    assert.deepEqual(noProvide.host.services.names(), []);
  } finally {
    await cleanup(noProvide.ws);
  }
  // 工具注册抛错 + 有 logger: 只告警, 服务面照旧
  const throwing = await setup({ registerThrows: true });
  try {
    assert.equal(throwing.host.tools.names().length, 0);
    assert.deepEqual(throwing.host.logs, [
      "code-map: code_map 工具注册失败：Error: tool registry rejected",
    ]);
    assert.deepEqual(throwing.host.services.names(), ["codeMap"]);
  } finally {
    await cleanup(throwing.ws);
  }
  // 工具注册抛错 + 无 logger: 告警落 stderr
  const noLogger = await setup({ shape: "no-logger", registerThrows: true });
  try {
    assert.equal(noLogger.host.logs.length, 0);
    assert.equal(noLogger.host.stderr.length, 1);
    assert.ok(
      noLogger.host.stderr[0]?.includes(
        "[code-map] code_map 工具注册失败：Error: tool registry rejected",
      ),
      `stderr 告警 (实际 ${JSON.stringify(noLogger.host.stderr)})`,
    );
  } finally {
    await cleanup(noLogger.ws);
  }
});

test("宿主 LSP: ctx.get('lsp') 经 apply 接上语义层 (precision=lsp)", async () => {
  const ws = await makeProject();
  const b = ws.path("core/b.ts");
  const asked: Array<{ file: string; line: number; character: number }> = [];
  const lsp: LspReferencesProvider = {
    async findReferences(file, position) {
      asked.push({ file, line: position.line, character: position.character });
      if (file !== ws.path("core/a.ts")) return null;
      return [
        {
          uri: pathToFileURL(b).href,
          range: {
            start: { line: 2, character: 15 },
            end: { line: 2, character: 19 },
          },
        },
      ];
    },
  };
  const host = await assemble({ root: ws.dir, lsp });
  try {
    await host.execute({ action: "index" });
    const result = (await host.execute({
      action: "callers",
      symbol: "Auth",
    })) as Record<string, unknown>;
    assert.equal(result["precision"], "lsp");
    assert.deepEqual(result["files"], [b]);
    assert.deepEqual(result["refs"], [
      { file: b, line: 2, column: 15, text: "" },
    ]);
    assert.deepEqual(asked, [
      {
        file: ws.path("core/a.ts"),
        line: 0,
        character: "export class ".length,
      },
    ]);
    assert.deepEqual(host.ast.searchCalls, [], "LSP 精确路径不搜候选");
  } finally {
    await cleanup(ws);
  }
});

test("临时目录: 项目落在 tmpdir 内, cleanup 后删除", async () => {
  const ws = await makeProject();
  try {
    assert.ok(ws.exists("core/a.ts"));
    assert.ok(
      ws.dir.startsWith(tmpdir()),
      `临时根在 os.tmpdir() 下 (实际 ${ws.dir})`,
    );
  } finally {
    await cleanup(ws);
  }
  assert.equal(ws.exists("core/a.ts"), false, "cleanup 删掉临时目录");
});
