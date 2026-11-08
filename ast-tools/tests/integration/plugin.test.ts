/**
 * 集成层用例（`ast-tools/tests/integration/plugin.test.ts`）：
 * 用 `ast-tools/tests/assemble.ts` 的假工具面 / 假事件面 / 假服务面拼宿主并调用 `apply`，
 * 断言工具注册名、`execute` 的 canonical 值、`output.render` 投影、事件与服务面接线。
 *
 * 二进制用假 ast-grep 脚本（输出预置 JSON），不依赖本机是否安装 ast-grep；
 * 需要真实文件的 replace 写回落在临时目录。
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";

import {
  assemble,
  createFakeAstGrep,
  createFakeClock,
  renderText,
} from "../assemble.ts";
import type { FakeCli, ToolDefLike } from "../assemble.ts";

/** 假 CLI 的 run 输出：搜索命中 + 替换目标（含元变量与字节偏移）。 */
const RUN_PAYLOAD = [
  {
    text: "console.log(add(1, 2))",
    file: "a.ts",
    range: {
      start: { line: 0, column: 0 },
      end: { line: 0, column: 22 },
      byteOffset: { start: 0, end: 22 },
    },
    metaVariables: {
      single: {
        ARG: {
          text: "add(1, 2)",
          range: {
            start: { line: 0, column: 12 },
            end: { line: 0, column: 21 },
            byteOffset: { start: 12, end: 21 },
          },
        },
      },
      multi: {
        ARGS: [
          {
            text: "1",
            range: {
              start: { line: 0, column: 12 },
              end: { line: 0, column: 13 },
              byteOffset: { start: 12, end: 13 },
            },
          },
          {
            text: "2",
            range: {
              start: { line: 0, column: 15 },
              end: { line: 0, column: 16 },
              byteOffset: { start: 15, end: 16 },
            },
          },
        ],
      },
    },
    replacement: "logger.info(add(1, 2))",
    replacementOffsets: { start: 0, end: 22 },
  },
];

const OUTLINE_PAYLOAD = [
  {
    path: "a.ts",
    language: "TypeScript",
    items: [
      {
        role: "item",
        symbolType: "function",
        name: "f",
        range: {
          start: { line: 0, column: 0 },
          end: { line: 0, column: 26 },
          byteOffset: { start: 0, end: 26 },
        },
        signature: "export function f(): void",
        astKind: "function_declaration",
        isImport: false,
        isExported: true,
        members: [],
      },
    ],
  },
];

const SCAN_PAYLOAD = [
  {
    text: "console.log(x)",
    file: "a.ts",
    range: {
      start: { line: 2, column: 4 },
      end: { line: 2, column: 20 },
      byteOffset: { start: 30, end: 46 },
    },
    ruleId: "no-console",
    severity: "warning",
    message: "避免 console",
  },
];

/** 每个用例一份假 CLI 与临时文件，结束后统一清理。 */
const clis: FakeCli[] = [];
function fakeCli(): FakeCli {
  const cli = createFakeAstGrep({
    run: RUN_PAYLOAD,
    outline: OUTLINE_PAYLOAD,
    scan: SCAN_PAYLOAD,
  });
  clis.push(cli);
  return cli;
}
after(() => {
  for (const cli of clis.splice(0)) cli.cleanup();
});

function tool(host: ReturnType<typeof assemble>, name: string): ToolDefLike {
  return host.tools.require(name);
}

test("apply 接线: 注册 ast_query / ast_replace, 契约面齐全且不订阅事件", () => {
  const cli = fakeCli();
  const host = assemble({ config: { bin: cli.bin } });

  assert.deepEqual(host.tools.names(), ["ast_query", "ast_replace"]);
  for (const def of host.tools.defs) {
    assert.equal(def.parameters.type, "object", `${def.name} parameters`);
    assert.equal(def.output.schema.type, "object", `${def.name} output.schema`);
    assert.equal(typeof def.output.render, "function", `${def.name} render`);
  }
  // 服务面：apply 只读 clock / fs / workingDirectory（三个都不 provide；假面由装配器装上）
  assert.deepEqual(host.services.names(), ["fs", "workingDirectory"]);
  assert.equal(host.services.get("clock"), undefined);
  // 事件面：本包无事件消费者，装配后零订阅
  assert.equal(host.events.listenerCount(), 0);
  assert.equal(host.events.emit("session/event", { probe: true }), 0);
  // 日志面：ready 行带解析出的二进制路径；clock 缺失只告警一次
  assert.ok(
    host.logs.info.some(
      (line) => line.includes("ast-tools ready") && line.includes(cli.bin),
    ),
    host.logs.info.join("\n"),
  );
  assert.equal(
    host.logs.warn.filter((line) => line.includes("clock 服务不可用")).length,
    1,
  );
});

test("ast_query: search 的 execute canonical 值与 render 投影", async () => {
  const cli = fakeCli();
  const host = assemble({ config: { bin: cli.bin } });
  const query = tool(host, "ast_query");

  const value = await query.execute({
    action: "search",
    pattern: "console.log($ARG)",
    language: "ts",
    path: "a.ts",
    strictness: "ast",
  });
  assert.deepEqual(value, { action: "search", matches: RUN_PAYLOAD });
  assert.deepEqual(cli.args(), [
    "run -p console.log($ARG) -l typescript --json=compact --strictness ast a.ts",
  ]);
  assert.equal(
    renderText(query, value),
    "a.ts:1:1  console.log(add(1, 2))  {$ARG=add(1, 2), $$ARGS=2节点}",
  );

  const empty = { action: "search", matches: [] };
  assert.equal(renderText(query, empty), "(无命中)");
});

test("ast_query: outline 的参数装配与 render 缩进投影", async () => {
  const cli = fakeCli();
  const host = assemble({ config: { bin: cli.bin } });
  const query = tool(host, "ast_query");

  const value = await query.execute({
    action: "outline",
    path: "a.ts",
    language: "ts",
    items: "all",
    types: ["function"],
  });
  assert.deepEqual(value, { action: "outline", files: OUTLINE_PAYLOAD });
  assert.deepEqual(cli.args(), [
    "outline --json=compact --items all --type function -l typescript a.ts",
  ]);
  assert.equal(
    renderText(query, value),
    "a.ts（TypeScript）\n  L1 function f  export function f(): void",
  );
});

test("ast_query: rules 的内联 / 规则文件两种来源与 render 投影", async () => {
  const cli = fakeCli();
  const host = assemble({ config: { bin: cli.bin } });
  const query = tool(host, "ast_query");

  const inline = await query.execute({
    action: "rules",
    rules: "id: no-console",
    paths: ["a.ts"],
    includeMetadata: true,
    minSeverity: "warning",
  });
  assert.deepEqual(inline, { action: "rules", hits: SCAN_PAYLOAD });
  assert.equal(
    renderText(query, inline),
    "a.ts:3:5 warning no-console: 避免 console",
  );

  await query.execute({
    action: "rules",
    rulePath: "rules/no-console.yml",
    paths: ["a.ts"],
  });
  assert.deepEqual(cli.args(), [
    "scan --json=compact --inline-rules id: no-console --include-metadata --min-severity warning a.ts",
    "scan --json=compact --rule rules/no-console.yml a.ts",
  ]);
});

test("ast_replace: dry-run 返回 canonical 值且不写文件, write:true 写回", async () => {
  const cli = fakeCli();
  const host = assemble({ config: { bin: cli.bin } });
  const replace = tool(host, "ast_replace");
  const file = `${cli.dir}/a.ts`;
  writeFileSync(file, "console.log(add(1, 2));\n", "utf8");

  const dry = await replace.execute({
    pattern: "console.log($ARG)",
    replacement: "logger.info($ARG)",
    language: "ts",
    path: file,
  });
  assert.deepEqual(dry, {
    updatedSource: "logger.info(add(1, 2));\n",
    replacedCount: 1,
    written: false,
    matches: RUN_PAYLOAD,
  });
  assert.equal(readFileSync(file, "utf8"), "console.log(add(1, 2));\n");
  assert.ok(
    renderText(replace, dry).startsWith(
      "预览：将替换 1 处（未写回；写入需 write:true）",
    ),
  );

  const written = await replace.execute({
    pattern: "console.log($ARG)",
    replacement: "logger.info($ARG)",
    language: "ts",
    path: file,
    write: true,
  });
  assert.deepEqual(written, {
    updatedSource: "logger.info(add(1, 2));\n",
    replacedCount: 1,
    written: true,
    matches: RUN_PAYLOAD,
  });
  assert.equal(readFileSync(file, "utf8"), "logger.info(add(1, 2));\n");
  assert.ok(renderText(replace, written).startsWith("已替换 1 处并写回文件"));
});

test("ast_query: 入参错误走 canonical error 值并投影为失败文本", async () => {
  const cli = fakeCli();
  const host = assemble({ config: { bin: cli.bin } });
  const query = tool(host, "ast_query");

  const value = await query.execute({
    action: "rules",
    rulePath: "r.yml",
    rules: "id: x",
    paths: ["a.ts"],
  });
  assert.deepEqual(value, { error: "rulePath 与 rules 二选一，不能同时给出" });
  assert.equal(
    renderText(query, value),
    "ast_query 失败：rulePath 与 rules 二选一，不能同时给出",
  );
  assert.deepEqual(cli.args(), [], "非法入参不应触达子进程");
});

test("apply 降级: 二进制不可用仍注册工具, execute 返回安装指引并投影失败文本", async () => {
  const host = assemble({ config: { bin: "/nonexistent/ast-grep-xyz" } });

  assert.deepEqual(host.tools.names(), ["ast_query", "ast_replace"]);
  assert.ok(host.logs.info.some((line) => line.includes("降级")));
  assert.equal(host.events.listenerCount(), 0);

  const value = (await tool(host, "ast_query").execute({
    action: "search",
    pattern: "f()",
    language: "ts",
    path: "a.ts",
  })) as { error?: string };
  assert.match(value.error ?? "", /npm install -g @ast-grep\/cli/);
  assert.match(
    renderText(tool(host, "ast_query"), value),
    /^ast_query 失败：未找到 ast-grep 二进制/,
  );
});

test("服务面: clock 可用时按 ctx 造排期器, 操作收尾后无残留排期", async () => {
  const cli = fakeCli();
  const clock = createFakeClock();
  const host = assemble({
    services: { clock: clock.service },
    config: { bin: cli.bin },
  });

  assert.deepEqual(
    host.logs.warn.filter((line) => line.includes("clock 服务不可用")),
    [],
    "服务可用时不应告警",
  );
  assert.equal(clock.scopes.length, 2, "scoped 与 detached 各一次");
  assert.equal(clock.scopes[0], host.ctx);
  assert.equal(clock.scopes[1], undefined);

  const value = await tool(host, "ast_query").execute({
    action: "search",
    pattern: "console.log($ARG)",
    language: "ts",
    path: "a.ts",
  });
  assert.deepEqual(value, { action: "search", matches: RUN_PAYLOAD });
  assert.equal(clock.pending(), 0, "操作收尾应撤销超时排期");
});

test("服务面: clock 形状不符时回落进程内定时器并告警", () => {
  const cli = fakeCli();
  const host = assemble({
    services: { clock: { now: () => 0, scope: () => ({}) } },
    config: { bin: cli.bin },
  });
  assert.equal(
    host.logs.warn.filter((line) => line.includes("clock 服务不可用")).length,
    1,
  );
  assert.deepEqual(host.tools.names(), ["ast_query", "ast_replace"]);
});
