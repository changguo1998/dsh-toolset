/**
 * bundle 接入面测试：createCodeMapBundle（真实 ast-grep）/ apply 防御降级。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import type { AstToolsBundle } from "@dsh-toolset/ast-tools";
import {
  apply,
  createCodeMapBundle,
  getCodeMapBundle,
  inject,
  name,
  provide,
} from "../src/index.ts";
import { astTest, withTempDir, writeFixture } from "./helpers.ts";

test("bundle 契约：name / provide / inject", () => {
  assert.equal(name, "code-map");
  assert.deepEqual(provide, ["codeMap"]);
  assert.deepEqual(inject, ["tools"], "工具面是硬依赖");
});

astTest("createCodeMapBundle：index → summary/report 全链路", async () => {
  const { dir, cleanup } = withTempDir();
  const root = join(dir, "repo");
  writeFixture(root, "src/a.ts", "export const A = 1;\n");
  writeFixture(
    root,
    "src/b.ts",
    "import { A } from './a';\nexport const B = A + 1;\n",
  );
  try {
    const bundle = createCodeMapBundle({ root });
    assert.equal(bundle.summary(), undefined, "未索引时 summary 为 undefined");
    const idx = await bundle.index();
    assert.equal(idx.ready, true);
    assert.equal(idx.files, 2);
    assert.ok(idx.symbols >= 2);
    const report = bundle.report();
    assert.ok(report, "report 可用");
    assert.equal(report!.fileCount, 2);
    assert.equal(bundle.cycles().length, 0);
    const callees = await bundle.callees("B");
    assert.deepEqual(
      callees.files,
      [resolve(root, "src/a.ts")],
      "b.ts import a.ts",
    );
    const imp = await bundle.impact(resolve(root, "src/a.ts"));
    assert.ok(imp.files.includes(resolve(root, "src/b.ts")));
    bundle.dispose();
  } finally {
    cleanup();
    void dir;
  }
});

astTest("callers：未知符号返回空结果", async () => {
  const { dir, cleanup } = withTempDir();
  const root = join(dir, "repo");
  writeFixture(root, "src/a.ts", "export const A = 1;\n");
  try {
    const bundle = createCodeMapBundle({ root });
    await bundle.index();
    const r = await bundle.callers("Nope");
    assert.deepEqual(r.refs, []);
    assert.deepEqual(r.files, []);
    bundle.dispose();
  } finally {
    cleanup();
    void dir;
  }
});

test("apply 防御：无 tools/provide/logger 的 ctx 不抛，且可经 getCodeMapBundle 访问", () => {
  assert.doesNotThrow(() => apply({} as never));
  const b = getCodeMapBundle();
  assert.ok(b, "apply 后 getCodeMapBundle 可用");
  // 未索引时 summary() 为 undefined（工具层兜底为 {ready:false}）
  assert.equal(b!.summary(), undefined);
});

test("apply 防御：tools.register 抛错只告警不崩", () => {
  const ctx = {
    logger: () => ({ info: () => {} }),
    tools: {
      register: () => {
        throw new Error("boom");
      },
    },
  };
  assert.doesNotThrow(() => apply(ctx as never));
});

astTest(
  "工具面：未索引时 cycles 返回 not_indexed（不静默当成无环）",
  async () => {
    const { dir, cleanup } = withTempDir();
    const root = join(dir, "repo");
    writeFixture(root, "src/a.ts", "export const A = 1;\n");
    const registered: unknown[] = [];
    try {
      apply(
        {
          provide: () => {},
          tools: { register: (t: unknown) => void registered.push(t) },
        } as never,
        { root },
      );
      const tool = registered[0] as {
        execute: (
          a: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };
      assert.ok(tool, "apply 应注册 code_map 工具");
      const before = await tool!.execute({ action: "cycles" });
      assert.equal(before["ok"], false);
      assert.equal(before["error"], "not_indexed");
      await getCodeMapBundle()!.index();
      const after = await tool!.execute({ action: "cycles" });
      assert.deepEqual(after, [], "索引后返回环数组（本仓无环）");
    } finally {
      getCodeMapBundle()?.dispose();
      apply({} as never); // 复位共享状态，避免影响后续用例
      cleanup();
    }
  },
);

astTest("apply：config 透传（root 生效；缺省沿用 cwd）", async () => {
  const { dir, cleanup } = withTempDir();
  const root = join(dir, "repo");
  writeFixture(root, "src/a.ts", "export const A = 1;\n");
  try {
    const provided: Record<string, unknown> = {};
    apply(
      {
        provide: (key: string, value: unknown) => {
          provided[key] = value;
        },
      } as never,
      { root },
    );
    const bundle = getCodeMapBundle();
    assert.ok(bundle, "apply 后 getCodeMapBundle 可用");
    await bundle!.index();
    assert.equal(bundle!.summary()?.root, root, "索引根取自 config.root");
    // provide 面暴露同一 bundle
    const svc = provided["codeMap"] as { getBundle: () => unknown };
    assert.equal(svc.getBundle(), bundle);
    bundle!.dispose();
  } finally {
    // 复位共享状态：后续用例（无 config 的 apply）不应看到本用例的 bundle
    apply({} as never);
    cleanup();
  }
});

/** 计数用最小假 ast（只实现 outline / search）：验证惰性索引、inflight 去重与重扫。 */
function countingAst(root: string): {
  ast: AstToolsBundle;
  calls: () => number;
} {
  let calls = 0;
  const ast = {
    bin: "fake-ast-grep",
    async outline(params: { path: string }) {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const rel = params.path.slice(root.length + 1);
      const items =
        rel === "src/a.ts"
          ? [
              {
                role: "item",
                symbolType: "function",
                name: "A",
                range: {
                  start: { line: 0, column: 0 },
                  end: { line: 0, column: 10 },
                  byteOffset: { start: 0, end: 0 },
                },
                signature: "export function A()",
                astKind: "function_declaration",
                isImport: false,
                isExported: true,
              },
            ]
          : [];
      return [{ path: params.path, language: "typescript", items }];
    },
    async search() {
      return [];
    },
    async replace() {
      throw new Error("fake ast: replace 不可用");
    },
    async rules() {
      throw new Error("fake ast: rules 不可用");
    },
    dispose() {
      /* 无持久资源 */
    },
  } as unknown as AstToolsBundle;
  return { ast, calls: () => calls };
}

test("index：惰性 + 并发 inflight 去重 + 已索引摘要 + refresh/index({root}) 重扫", async () => {
  const { dir, cleanup } = withTempDir();
  const root = join(dir, "repo");
  writeFixture(root, "src/a.ts", "export function A() { return 1; }\n");
  try {
    const { ast, calls } = countingAst(root);
    const bundle = createCodeMapBundle({ root, ast });
    assert.equal(bundle.summary(), undefined, "首次查询前不建索引");
    assert.equal(calls(), 0, "构造不扫描");
    const [first, second] = await Promise.all([bundle.index(), bundle.index()]);
    assert.equal(calls(), 1, "并发首查共用同一次扫描");
    assert.deepEqual(first, second);
    assert.equal(first.files, 1);
    assert.equal(first.symbols, 1);
    assert.equal(bundle.summary()?.files, 1);
    const cached = await bundle.index();
    assert.equal(calls(), 1, "已索引后不再扫描");
    assert.equal(cached.imports, 0, "摘要路径不带 import 计数");
    await bundle.refresh();
    assert.equal(calls(), 2, "refresh 重扫");
    await bundle.index({ root });
    assert.equal(calls(), 3, "index({ root }) 等同重扫");
    bundle.dispose();
  } finally {
    cleanup();
    void dir;
  }
});

/** 工具输出面（render 全函数契约用）。 */
interface RenderFace {
  name?: string;
  output: {
    render(args: unknown, value: unknown): { type?: string; text?: unknown }[];
  };
}

test("工具 render 全函数：text 恒为 string（undefined / 对象 / 字符串 / 不可序列化）", () => {
  const registered: RenderFace[] = [];
  apply({
    tools: {
      register: (def: unknown) => void registered.push(def as RenderFace),
    },
  } as never);
  assert.equal(registered.length, 1, "code_map 单工具注册");
  const render = registered[0]!.output.render;

  // 裸 JSON.stringify(undefined, null, 2) === undefined：旧实现下此断言必失败
  const undef = render({}, undefined);
  assert.equal(typeof undef[0]?.text, "string");
  assert.equal(undef[0]?.text, "undefined");

  // 对象走 JSON 分支
  assert.match(String(render({}, { a: 1 })[0]?.text), /"a": 1/);

  // 字符串原样返回（不二次编码）
  assert.equal(render({}, "s")[0]?.text, "s");

  // 循环引用 / BigInt：JSON.stringify 抛错 → String 兜底
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.equal(render({}, circular)[0]?.text, "[object Object]");
  assert.equal(render({}, 1n)[0]?.text, "1");

  // 复位共享状态（后续用例不应看到本用例的 bundle）
  apply({} as never);
});

test("render 形参顺序哨兵：渲染的必须是第二参（变异回单形参必失败）", () => {
  const registered: RenderFace[] = [];
  apply({
    tools: {
      register: (def: unknown) => void registered.push(def as RenderFace),
    },
  } as never);
  assert.equal(registered.length, 1, "code_map 单工具注册（探针须覆盖全部）");
  // 本包 render 是 jsonText(value)：整个 value 进 JSON 文本，任意字段都会回显 →
  // 最小结构即可。哨兵放 **value 位**；args 用同形结构、标记放同一可回显字段，
  // 形参写反 / 少参（单形参实现）时渲染器拿到的是 args → ②③ 双失败。
  const argsShaped = { marker: "ARGS_MARKER_NOT_RENDERED" };
  const valueShaped = { marker: "SENTINEL_VALUE_MARKER" };
  for (const tool of registered) {
    const text = tool.output.render(argsShaped, valueShaped)[0]?.text;
    assert.equal(
      typeof text,
      "string",
      `${tool.name}：blocks[0].text 必须是 string`,
    );
    assert.ok(
      String(text).includes("SENTINEL_VALUE_MARKER"),
      `${tool.name}：渲染的必须是第二参（value）`,
    );
    assert.ok(
      !String(text).includes("ARGS_MARKER_NOT_RENDERED"),
      `${tool.name}：第一参（args）不该被当成 value 渲染`,
    );
  }

  // 复位共享状态（后续用例不应看到本用例的 bundle）
  apply({} as never);
});
