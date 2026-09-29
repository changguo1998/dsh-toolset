// tests/digest.test.ts — digest 编排层端到端：错误路径 / LSP 降级 / 工具注册
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, name, inject, digest } from "../src/main.ts";
import type { LspDocumentSymbol, SymbolProvider } from "../src/lsp.ts";
import type { DigestResult } from "../src/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const TS_FILE = join(FIXTURES, "sample.ts");
const MD_FILE = join(FIXTURES, "sample.md");
const PY_FILE = join(FIXTURES, "sample.py");
const GO_FILE = join(FIXTURES, "sample.go");
const BIG_FILE = join(FIXTURES, "big.log");

describe("digest 错误路径", () => {
  it("文件不存在 → file_not_found", async () => {
    const r = await digest(null, "/no/such/file.ts", { mode: "outline" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "file_not_found");
  });

  it("目录 → not_a_file", async () => {
    const r = await digest(null, FIXTURES, { mode: "outline" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "not_a_file");
  });

  it("二进制文件（NUL 字节）→ binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-digest-"));
    try {
      const p = join(dir, "bin.dat");
      await writeFile(p, Buffer.from([0x00, 0x01, 0x02, 0xff]));
      const r = await digest(null, p, { mode: "outline" });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, "binary");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("超过 maxBytes → too_large", async () => {
    const r = await digest(
      null,
      BIG_FILE,
      { mode: "pruned" },
      { maxBytes: 10 },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "too_large");
  });

  it("非法 depth → invalid_option", async () => {
    const r = await digest(null, TS_FILE, { mode: "outline", depth: 0 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "invalid_option");
  });
});

describe("LSP 降级与 requireLsp", () => {
  const lspProvider: SymbolProvider = {
    documentSymbols: async (): Promise<LspDocumentSymbol[]> => [
      { name: "LspFunc", kind: "function", line: 1 },
    ],
  };
  const failingProvider: SymbolProvider = {
    documentSymbols: async (): Promise<null> => {
      throw new Error("lsp down");
    },
  };

  it("无 LSP 的 TS 文件降级启发式（source=heuristic）", async () => {
    const r = await digest(null, TS_FILE, { mode: "outline" });
    assert.equal(r.ok, true);
    if (!r.ok || r.mode !== "outline") throw new Error("unreachable");
    assert.equal(r.source, "heuristic");
    assert.ok(r.nodes.length >= 5);
  });

  it("注入 provider 时优先 LSP（source=lsp）", async () => {
    const r = await digest(
      null,
      TS_FILE,
      { mode: "outline" },
      { provider: lspProvider },
    );
    if (!r.ok || r.mode !== "outline")
      throw new Error(`应成功，得到 ${JSON.stringify(r)}`);
    assert.equal(r.source, "lsp");
    assert.equal(r.nodes[0]?.name, "LspFunc");
  });

  it("provider 返回 null → 降级启发式；失败 → 同样降级", async () => {
    const nullProvider: SymbolProvider = { documentSymbols: async () => null };
    const r1 = await digest(
      null,
      TS_FILE,
      { mode: "outline" },
      { provider: nullProvider },
    );
    if (!r1.ok || r1.mode !== "outline") throw new Error("unreachable");
    assert.equal(r1.source, "heuristic");
    const r2 = await digest(
      null,
      TS_FILE,
      { mode: "outline" },
      { provider: failingProvider },
    );
    if (!r2.ok || r2.mode !== "outline") throw new Error("unreachable");
    assert.equal(r2.source, "heuristic");
  });

  it("requireLsp=true 且无可用 LSP → lsp_unavailable", async () => {
    const r1 = await digest(null, TS_FILE, {
      mode: "outline",
      requireLsp: true,
    });
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.error, "lsp_unavailable");
    const r2 = await digest(
      null,
      TS_FILE,
      { mode: "signatures", requireLsp: true },
      { provider: failingProvider },
    );
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.error, "lsp_unavailable");
  });

  it("requireLsp=true 且 LSP 可用 → 正常返回", async () => {
    const r = await digest(
      null,
      TS_FILE,
      { mode: "outline", requireLsp: true },
      { provider: lspProvider },
    );
    assert.equal(r.ok, true);
  });

  it("unknown 语言无 LSP → unsupported_language；language 提示后恢复", async () => {
    const r1 = await digest(null, GO_FILE, { mode: "outline" });
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.error, "unsupported_language");
    // 提示语言为 typescript 后走启发式
    const r2 = await digest(null, GO_FILE, {
      mode: "outline",
      language: "typescript",
    });
    assert.equal(r2.ok, true);
  });
});

describe("宿主 ctx 结构面 LSP 解析", () => {
  it("ctx.lsp.documentSymbols 被识别", async () => {
    const ctx = {
      lsp: {
        documentSymbols: async () => [
          { name: "CtxFunc", kind: "function", line: 2 },
        ],
      },
    };
    const r = await digest(ctx, TS_FILE, { mode: "outline" });
    if (!r.ok || r.mode !== "outline") throw new Error("unreachable");
    assert.equal(r.source, "lsp");
    assert.equal(r.nodes[0]?.name, "CtxFunc");
  });

  it("ctx.get('lsp').symbols 别名方法被识别", async () => {
    const ctx = {
      get: (k: string) =>
        k === "lsp"
          ? {
              symbols: async () => [
                { name: "Alias", kind: "function", line: 1 },
              ],
            }
          : null,
    };
    const r = await digest(ctx, TS_FILE, { mode: "outline" });
    if (!r.ok || r.mode !== "outline") throw new Error("unreachable");
    assert.equal(r.source, "lsp");
  });

  it("cordis 代理语义：直读 ctx.lsp 抛错时不透传，降级启发式（#53）", async () => {
    // 模拟真实 cordis ctx：未 inject 的服务属性直读抛错，get() 返回 undefined
    const ctx = {
      get: (_k: string) => undefined,
      get lsp(): never {
        throw new Error('cannot get property "lsp" without inject');
      },
    };
    const r = await digest(ctx, TS_FILE, { mode: "outline" });
    if (!r.ok || r.mode !== "outline") throw new Error("unreachable");
    assert.equal(r.source, "heuristic", "LSP 不可读 → 启发式，不抛错");
  });
});

describe("工具注册（mock ctx）", () => {
  // 假 ctx **无 cwd 属性**：对齐 cordis 语义（未 inject 的 `ctx.cwd` 读取会直接抛错，
  // 旧实现曾靠它兜底 → D1）；相对路径基准改为工具执行上下文（第二个实参）。
  function mockCtx() {
    const registered: Array<{
      name: string;
      execute: (
        args: Record<string, unknown>,
        exec?: unknown,
      ) => Promise<unknown>;
      output: {
        schema: Record<string, unknown>;
        render: (
          args: unknown,
          value: unknown,
        ) => Array<{ type: string; text: string }>;
      };
    }> = [];
    const ctx = {
      tools: {
        register: (t: (typeof registered)[number]) => registered.push(t),
      },
    };
    return { ctx, registered };
  }

  it("apply 注册 fs_digest 工具，name/inject 常量正确", () => {
    assert.equal(name, "fs-digest");
    assert.deepEqual(inject, ["tools"]);
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.name, "fs_digest");
  });

  it("无 tools 面时 apply 不抛错", () => {
    apply({} as never, {});
  });

  it("config 缺省（profile 未声明 config → undefined）时 apply 不抛错且注册工具", () => {
    // 回归：曾因 config.maxBytes 直读 undefined 属性导致 apply 抛错，
    // 触发 cordis 回滚整棵插件树（dsh 启动后立即退出）。
    const { ctx, registered } = mockCtx();
    apply(ctx as never, undefined as never);
    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.name, "fs_digest");
  });

  it("execute：pruned 大文件 + render 摘要", async () => {
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    const tool = registered[0];
    assert.ok(tool !== undefined);
    const result = (await tool.execute({
      path: BIG_FILE,
      mode: "pruned",
      maxLines: 40,
    })) as DigestResult;
    assert.equal(result.ok, true);
    if (result.ok && result.mode === "pruned") {
      assert.equal(result.truncated, true);
      const lines = result.text.split("\n");
      assert.ok(lines.length <= 40);
      assert.ok(result.text.includes("... ["));
      const rendered = tool.output.render({}, result)[0]?.text ?? "";
      assert.ok(rendered.includes("... ["), "render 应包含省略标记");
      assert.ok(
        rendered.length <= result.text.length + 5,
        "render 不应长于原文",
      );
    } else {
      throw new Error(`非预期结果：${JSON.stringify(result)}`);
    }
  });

  it("execute：缺参 → invalid_option 错误结果", async () => {
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    const tool = registered[0];
    assert.ok(tool !== undefined);
    const result = (await tool.execute({ mode: "outline" })) as DigestResult;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "invalid_option");
  });

  it("execute：markdown outline + render 树", async () => {
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    const tool = registered[0];
    assert.ok(tool !== undefined);
    const result = (await tool.execute({
      path: MD_FILE,
      mode: "outline",
    })) as DigestResult;
    assert.equal(result.ok, true);
    if (result.ok && result.mode === "outline") {
      assert.equal(result.source, "markdown");
      const rendered = tool.output.render({}, result)[0]?.text ?? "";
      assert.ok(rendered.includes("标题一"));
      assert.ok(rendered.includes("L1 heading"));
    } else {
      throw new Error(`非预期结果：${JSON.stringify(result)}`);
    }
  });

  it("output.render 返回内容块数组（宿主契约，防 content.some 报错）", async () => {
    // 回归 D2：render 曾返回字符串，宿主对 content 调 .some 抛
    // `content.some is not a function`，工具在本机完全不可用。
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    const tool = registered[0];
    assert.ok(tool !== undefined);
    const result = (await tool.execute({
      path: MD_FILE,
      mode: "outline",
    })) as DigestResult;
    const blocks = tool.output.render({}, result);
    assert.ok(Array.isArray(blocks), "render 应返回数组");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, "text");
    assert.ok((blocks[0]?.text ?? "").includes("标题一"));
  });

  it("execute：python signatures 启发式", async () => {
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    const tool = registered[0];
    assert.ok(tool !== undefined);
    const result = (await tool.execute({
      path: PY_FILE,
      mode: "signatures",
    })) as DigestResult;
    assert.equal(result.ok, true);
    if (result.ok && result.mode === "signatures") {
      assert.equal(result.source, "heuristic");
      const names = result.signatures.map((s) => s.name);
      assert.ok(names.includes("top_level"));
      assert.ok(names.includes("start"));
    } else {
      throw new Error(`非预期结果：${JSON.stringify(result)}`);
    }
  });

  it("execute：工具签名可接收 exec（宿主调用形态 execute(args, exec)）", () => {
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    const tool = registered[0];
    assert.ok(tool !== undefined);
    assert.equal(
      tool.execute.length,
      2,
      "第二个形参为宿主传入的工具执行上下文（会话 cwd 来源）",
    );
  });

  it("execute：相对路径以会话 cwd 为基准（D1 回归：同一输入在两个基准下解析到不同文件）", async () => {
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    const tool = registered[0];
    assert.ok(tool !== undefined);
    const dirA = await mkdtemp(join(tmpdir(), "fs-digest-cwd-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "fs-digest-cwd-b-"));
    try {
      const rel = join("nested", "a.ts");
      await mkdir(join(dirA, "nested"), { recursive: true });
      await mkdir(join(dirB, "nested"), { recursive: true });
      await writeFile(join(dirA, rel), "export function alpha(): void {}\n");
      await writeFile(join(dirB, rel), "export function beta(): void {}\n");
      const run = async (cwd: string) =>
        (await tool.execute(
          { path: rel, mode: "outline" },
          {
            agent: { session: { header: { cwd } } },
          },
        )) as DigestResult;
      const ra = await run(dirA);
      const rb = await run(dirB);
      assert.equal(ra.ok, true, JSON.stringify(ra));
      assert.equal(rb.ok, true, JSON.stringify(rb));
      assert.equal(ra.path, rel);
      const namesOf = (
        nodes: readonly { name: string; children: readonly unknown[] }[],
      ): string[] =>
        nodes.flatMap((n) => [
          n.name,
          ...namesOf(
            n.children as readonly {
              name: string;
              children: readonly unknown[];
            }[],
          ),
        ]);
      if (ra.ok && ra.mode === "outline") {
        const names = namesOf(ra.nodes);
        assert.ok(names.includes("alpha"), "dirA 基准应读到 alpha");
        assert.ok(!names.includes("beta"), "不应读到另一个基准的文件");
      }
      if (rb.ok && rb.mode === "outline") {
        assert.ok(namesOf(rb.nodes).includes("beta"), "dirB 基准应读到 beta");
      }
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it("execute：signatures 与 pruned 同样认会话 cwd（相对路径，三模式口径一致）", async () => {
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    const tool = registered[0];
    assert.ok(tool !== undefined);
    const dir = await mkdtemp(join(tmpdir(), "fs-digest-cwd-"));
    try {
      await writeFile(
        join(dir, "mod.py"),
        [
          "def alpha(x):",
          "    return x",
          "",
          "class Box:",
          "    pass",
          "",
        ].join("\n"),
      );
      const exec = { agent: { session: { header: { cwd: dir } } } };
      const sig = (await tool.execute(
        { path: "mod.py", mode: "signatures" },
        exec,
      )) as DigestResult;
      assert.equal(sig.ok, true, JSON.stringify(sig));
      if (sig.ok && sig.mode === "signatures") {
        assert.ok(sig.signatures.some((s) => s.name === "alpha"));
      }
      const pruned = (await tool.execute(
        { path: "mod.py", mode: "pruned" },
        exec,
      )) as DigestResult;
      assert.equal(pruned.ok, true, JSON.stringify(pruned));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("execute：无 exec / 无会话 cwd 时回退进程 cwd（明确失败，不抛 cwd 异常）", async () => {
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    const tool = registered[0];
    assert.ok(tool !== undefined);
    // 进程 cwd（包根）下不存在该相对路径；断言「不抛错 + 明确 file_not_found」
    const noExec = (await tool.execute({
      path: ".tmp-no-such-file.ts",
      mode: "outline",
    })) as DigestResult;
    assert.equal(noExec.ok, false);
    if (!noExec.ok) assert.equal(noExec.error, "file_not_found");
    const emptyCwd = (await tool.execute(
      { path: ".tmp-no-such-file.ts", mode: "outline" },
      { agent: { session: { header: {} } } },
    )) as DigestResult;
    assert.equal(emptyCwd.ok, false);
    if (!emptyCwd.ok) assert.equal(emptyCwd.error, "file_not_found");
  });
});
