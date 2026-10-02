/**
 * bundle 接入面测试：createCodeMapBundle（真实 ast-grep）/ apply 防御降级。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  apply,
  createCodeMapBundle,
  getCodeMapBundle,
  name,
  provide,
} from "../src/index.ts";
import { astTest, withTempDir, writeFixture } from "./helpers.ts";

test("bundle 契约：name / provide / inject", () => {
  assert.equal(name, "code-map");
  assert.deepEqual(provide, ["codeMap"]);
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
