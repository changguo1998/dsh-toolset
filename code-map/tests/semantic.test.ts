/**
 * 语义层测试：`ctx.lsp` 缝适配（resolveLspReferences）、定义行定位（symbolPositionAt）
 * 与 callers 的精确/回落两态（precision=lsp / structural）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCodeMapBundle } from "../src/index.ts";
import {
  resolveLspReferences,
  type LspLocation,
  type LspReferencesProvider,
} from "../src/semantic/lsp.ts";
import { symbolPositionAt } from "../src/semantic/locate.ts";
import { astTest, withTempDir, writeFixture } from "./helpers.ts";

/* -- resolveLspReferences（官方缝 / 窄化形态 / 受保护读取） ---------------- */

const location = (
  uri: string,
  line: number,
  character: number,
): LspLocation => ({
  uri,
  range: {
    start: { line, character },
    end: { line, character: character + 1 },
  },
});

test("resolveLspReferences：注入优先；官方缝 query 形态解析 locations", async () => {
  const injected: LspReferencesProvider = {
    findReferences: async () => [],
  };
  assert.equal(
    resolveLspReferences({}, "/root", injected),
    injected,
    "注入的 provider 原样返回",
  );

  const requests: unknown[] = [];
  const ctx = {
    get: (name: string) =>
      name === "lsp"
        ? {
            query: async (req: unknown) => {
              requests.push(req);
              return {
                kind: "locations",
                locations: [location("file:///repo/src/b.ts", 3, 2)],
                resolvedWorkspaceUri: "file:///repo",
              };
            },
          }
        : undefined,
  };
  const provider = resolveLspReferences(ctx, "/repo");
  assert.ok(provider, "缝可解析");
  const locs = await provider!.findReferences("/repo/src/a.ts", {
    line: 1,
    character: 4,
  });
  assert.deepEqual(locs, [location("file:///repo/src/b.ts", 3, 2)]);
  assert.deepEqual(requests[0], {
    operation: "findReferences",
    filePath: "/repo/src/a.ts",
    position: { line: 1, character: 4 },
    workspaceRoot: "/repo",
  });
});

test("resolveLspReferences：fail-open（hover / 形状不符 / 抛错 / 无服务 → null 或 undefined）", async () => {
  const hover = {
    get: () => ({ query: async () => ({ kind: "hover", hover: null }) }),
  };
  assert.equal(
    await resolveLspReferences(hover, "/r")!.findReferences("/a.ts", {
      line: 0,
      character: 0,
    }),
    null,
    "hover 结果 → null（回落）",
  );
  const malformed = {
    get: () => ({ query: async () => ({ kind: "locations" }) }),
  };
  assert.equal(
    await resolveLspReferences(malformed, "/r")!.findReferences("/a.ts", {
      line: 0,
      character: 0,
    }),
    null,
    "locations 缺失 → null",
  );
  const throwing = {
    get: () => ({
      query: async () => {
        throw new Error("LSP_UNAVAILABLE");
      },
    }),
  };
  assert.equal(
    await resolveLspReferences(throwing, "/r")!.findReferences("/a.ts", {
      line: 0,
      character: 0,
    }),
    null,
    "查询抛错 → null",
  );
  assert.equal(
    resolveLspReferences({ get: () => undefined }, "/r"),
    undefined,
    "无 lsp 服务 → undefined",
  );
  // cordis 代理语义：直接属性读抛错且 get 缺失 → undefined（受保护）
  const proxyLike = {
    get lsp(): never {
      throw new Error('cannot get property "lsp" without inject');
    },
  };
  assert.equal(resolveLspReferences(proxyLike, "/r"), undefined);
});

test("resolveLspReferences：窄化 findReferences 形态直接采用", async () => {
  const fn: LspReferencesProvider = {
    findReferences: async () => [location("file:///x.ts", 1, 1)],
  };
  const provider = resolveLspReferences({ get: () => fn }, "/r");
  assert.deepEqual(
    await provider!.findReferences("/x.ts", { line: 1, character: 1 }),
    [location("file:///x.ts", 1, 1)],
  );
});

test("resolveLspReferences：ctx.get 抛错时回落直接属性；query 非函数 → undefined", async () => {
  // cordis 严格代理：读 get 抛错，但直接属性可读
  const strict = {
    get: () => {
      throw new Error('cannot get property "lsp" without inject');
    },
    lsp: { findReferences: async () => [location("file:///x.ts", 0, 0)] },
  };
  const provider = resolveLspReferences(strict, "/r");
  assert.ok(provider, "抛错的 get 之后仍能取到直接属性");
  assert.deepEqual(
    await provider!.findReferences("/x.ts", { line: 0, character: 0 }),
    [location("file:///x.ts", 0, 0)],
  );
  assert.equal(
    resolveLspReferences({ get: () => ({ query: 42 }) }, "/r"),
    undefined,
    "query 非函数 → 无可解析面",
  );
  assert.equal(
    resolveLspReferences({ get: () => ({}) }, "/r"),
    undefined,
    "空对象面 → undefined",
  );
  assert.equal(
    resolveLspReferences(undefined, "/r"),
    undefined,
    "非对象 ctx → undefined",
  );
});

test("resolveLspReferences：结果形状不符 fail-open，非法条目被丢弃", async () => {
  const cases: Array<[string, unknown, LspLocation[] | null]> = [
    ["null", null, null],
    ["字符串", "x", null],
    ["locations 非数组", { kind: "locations", locations: 1 }, null],
  ];
  for (const [name, payload, expected] of cases) {
    const provider = resolveLspReferences(
      { get: () => ({ query: async () => payload }) },
      "/r",
    );
    assert.deepEqual(
      await provider!.findReferences("/a.ts", { line: 0, character: 0 }),
      expected,
      name,
    );
  }
  const mixed = resolveLspReferences(
    {
      get: () => ({
        query: async () => ({
          kind: "locations",
          locations: [
            null,
            1,
            { uri: 2 },
            { uri: "file:///a.ts" }, // 缺 range
            {
              uri: "file:///a.ts",
              range: { start: { line: 0, character: 0 } },
            },
            {
              uri: "file:///b.ts",
              range: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 5 },
              },
            },
          ],
        }),
      }),
    },
    "/r",
  );
  assert.deepEqual(
    await mixed!.findReferences("/a.ts", { line: 0, character: 0 }),
    [
      {
        uri: "file:///b.ts",
        range: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 5 },
        },
      },
    ],
    "只保留形状完整的条目",
  );
});

test("resolveLspReferences：调用方 AbortSignal 原样透传给宿主 query", async () => {
  const seen: unknown[] = [];
  const provider = resolveLspReferences(
    {
      get: () => ({
        query: async (_req: unknown, signal?: AbortSignal) => {
          seen.push(signal);
          return { kind: "locations", locations: [] };
        },
      }),
    },
    "/r",
  );
  const controller = new AbortController();
  await provider!.findReferences(
    "/a.ts",
    { line: 0, character: 0 },
    controller.signal,
  );
  assert.equal(seen[0], controller.signal, "不额外包一层超时信号");
});

/* -- symbolPositionAt ------------------------------------------------------ */

test("symbolPositionAt：定义行内定位列号；缺失/越界 → undefined", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(
      dir,
      "a.ts",
      "export function alpha() {}\nconst beta = 1;\n",
    );
    assert.deepEqual(await symbolPositionAt(file, 0, "alpha"), {
      line: 0,
      character: "export function ".length,
    });
    assert.deepEqual(await symbolPositionAt(file, 1, "beta"), {
      line: 1,
      character: "const ".length,
    });
    assert.equal(await symbolPositionAt(file, 0, "gamma"), undefined);
    assert.equal(await symbolPositionAt(file, 9, "alpha"), undefined);
    assert.equal(
      await symbolPositionAt(join(dir, "absent.ts"), 0, "x"),
      undefined,
    );
  } finally {
    cleanup();
  }
});

test("symbolPositionAt：非法行号与空名直接 undefined（不读文件）", async () => {
  assert.equal(await symbolPositionAt("/nope.ts", -1, "x"), undefined);
  assert.equal(await symbolPositionAt("/nope.ts", 1.5, "x"), undefined);
  assert.equal(await symbolPositionAt("/nope.ts", 0, ""), undefined);
});

/* -- callers：精确 / 回落两态 ---------------------------------------------- */

astTest(
  "callers：LSP findReferences 精确结果（precision=lsp，定义被排除）",
  async () => {
    const { dir, cleanup } = withTempDir();
    try {
      const root = join(dir, "repo");
      const aFile = writeFixture(
        root,
        "src/a.ts",
        "export function alpha() { return 1; }\n",
      );
      const bFile = writeFixture(
        root,
        "src/b.ts",
        "import { alpha } from './a';\nalpha();\n",
      );
      const calls: Array<{ file: string; line: number; character: number }> =
        [];
      const lsp: LspReferencesProvider = {
        async findReferences(file, position) {
          calls.push({
            file,
            line: position.line,
            character: position.character,
          });
          if (file !== aFile) return null;
          return [
            // 声明本身（同文件定义行）→ 应被 excludeDefinitionRange 排除
            location(pathToFileURL(aFile).href, 0, 16),
            location(pathToFileURL(bFile).href, 1, 0),
          ];
        },
      };
      const bundle = createCodeMapBundle({ root, lsp });
      await bundle.index();
      const res = await bundle.callers("alpha");
      assert.equal(res.precision, "lsp");
      assert.deepEqual(calls, [
        { file: aFile, line: 0, character: "export function ".length },
      ]);
      assert.deepEqual(res.files, [bFile]);
      assert.deepEqual(
        res.refs.map((r) => ({ file: r.file, line: r.line, column: r.column })),
        [{ file: bFile, line: 1, column: 0 }],
      );
    } finally {
      cleanup();
    }
  },
);

astTest("callers：LSP 返回 null（不可用/失败）→ 结构层候选回落", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const root = join(dir, "repo");
    writeFixture(root, "src/a.ts", "export function alpha() { return 1; }\n");
    const bFile = writeFixture(
      root,
      "src/b.ts",
      "import { alpha } from './a';\nalpha();\n",
    );
    const bundle = createCodeMapBundle({
      root,
      lsp: { findReferences: async () => null },
    });
    await bundle.index();
    const res = await bundle.callers("alpha");
    assert.equal(res.precision, "structural");
    assert.deepEqual(res.files, [bFile], "同名候选命中引用文件");
  } finally {
    cleanup();
  }
});

astTest("callers：未注入 LSP → 结构层（precision=structural）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const root = join(dir, "repo");
    writeFixture(root, "src/a.ts", "export function alpha() { return 1; }\n");
    writeFixture(root, "src/b.ts", "alpha();\n");
    const bundle = createCodeMapBundle({ root });
    await bundle.index();
    const res = await bundle.callers("alpha");
    assert.equal(res.precision, "structural");
    assert.equal(res.files.length, 1);
  } finally {
    cleanup();
  }
});
