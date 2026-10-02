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
      // Markdown 标题行带节行范围（L{起始}-{结束}）
      assert.match(rendered, /L1-\d+ heading 标题一/);
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

  it("render 形参顺序哨兵：渲染的必须是第二参（变异回单形参必失败）", () => {
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    assert.equal(
      registered.length,
      1,
      "fs_digest 单工具注册（探针须覆盖全部）",
    );
    const tool = registered[0];
    assert.ok(tool !== undefined);
    // 本包 render 只回显错误正文（error/message）或 mode 专有字段：探针仍取**合法形状**两组，
    // 分别覆盖失败分支与 pruned 分支。（旧实现下 `render({}, undefined)` 与 `{ok:true, mode:"pruned"}`
    // 会抛 TypeError，故当时不能用「任意最小结构」；该抛错已按 BACKLOG #1 修掉，
    // 全函数性另见下方「render 全函数性」用例。）
    // 两组同形 args/value 的哨兵都放 **value 位**、嵌在会被回显的字段里，
    // args 标记放同一字段（③因此有牙）；形参写反 / 少参（单形参实现）时渲染器拿到 args
    // → 两分支下 ②③ 双双失败。
    const probes = [
      {
        label: "失败分支",
        argsShaped: {
          ok: false,
          error: "ARGS_MARKER_NOT_RENDERED",
          message: "m",
        },
        valueShaped: {
          ok: false,
          error: "SENTINEL_VALUE_MARKER",
          message: "m",
        },
      },
      {
        label: "pruned 分支",
        argsShaped: {
          ok: true,
          mode: "pruned",
          text: "ARGS_MARKER_NOT_RENDERED",
        },
        valueShaped: {
          ok: true,
          mode: "pruned",
          text: "SENTINEL_VALUE_MARKER",
        },
      },
    ];
    for (const probe of probes) {
      const blocks = tool.output.render(
        probe.argsShaped,
        probe.valueShaped,
      ) as Array<{ type?: string; text?: unknown }>;
      const text = blocks[0]?.text;
      assert.equal(
        typeof text,
        "string",
        `${probe.label}：blocks[0].text 必须是 string`,
      );
      assert.ok(
        String(text).includes("SENTINEL_VALUE_MARKER"),
        `${probe.label}：渲染的必须是第二参（value）`,
      );
      assert.ok(
        !String(text).includes("ARGS_MARKER_NOT_RENDERED"),
        `${probe.label}：第一参（args）不该被当成 value 渲染`,
      );
    }
  });

  // ---- render 全函数性（BACKLOG #1）：任意 value 都返回可读文本，绝不抛错 ----

  /** 注册工具并调用 render({}, value)（第二参才是结果值），校验内容块契约后返回 text。 */
  function renderOf(value: unknown): string {
    const { ctx, registered } = mockCtx();
    apply(ctx as never, {});
    const tool = registered[0];
    assert.ok(tool !== undefined);
    const blocks = tool.output.render({}, value);
    assert.ok(Array.isArray(blocks), "render 必须返回内容块数组");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, "text");
    const text = blocks[0]?.text;
    assert.equal(typeof text, "string", "render 的 text 必须恒为 string");
    return String(text);
  }

  it("render({}, undefined) → text 是 string（旧实现抛 TypeError）", () => {
    // 兜底口径与同批 7 包一致（jsonText）：undefined → String(undefined)
    assert.equal(renderOf(undefined), "undefined");
    // 非对象 / 空对象同样不抛
    assert.equal(typeof renderOf(null), "string");
    assert.equal(typeof renderOf({}), "string");
  });

  it("四分支缺字段 / 字段类型错 → 不抛，退回 JSON 原文（可读且可定位）", () => {
    const probes: Array<{ label: string; value: unknown; marker: string }> = [
      {
        label: "失败分支缺 error/message",
        value: { ok: false },
        marker: '"ok"',
      },
      {
        label: "outline 缺 nodes",
        value: { ok: true, mode: "outline" },
        marker: '"outline"',
      },
      {
        label: "outline nodes 非数组",
        value: { ok: true, mode: "outline", nodes: "x" },
        marker: '"nodes"',
      },
      {
        label: "outline blocks 类型错",
        value: { ok: true, mode: "outline", nodes: [], blocks: "x" },
        marker: '"blocks"',
      },
      {
        label: "signatures 缺 signatures",
        value: { ok: true, mode: "signatures" },
        marker: '"signatures"',
      },
      {
        label: "signatures 非数组",
        value: { ok: true, mode: "signatures", signatures: "x" },
        marker: '"signatures"',
      },
      {
        label: "pruned 缺 text",
        value: { ok: true, mode: "pruned" },
        marker: '"pruned"',
      },
      {
        label: "pruned text 非字符串",
        value: { ok: true, mode: "pruned", text: 42 },
        marker: '"text"',
      },
      {
        label: "mode 非三模式",
        value: { ok: true, mode: "weird", text: "x" },
        marker: '"weird"',
      },
    ];
    for (const probe of probes) {
      const text = renderOf(probe.value);
      assert.ok(
        text.includes(probe.marker),
        `${probe.label}：兜底文本应含原值（${probe.marker}），实得 ${JSON.stringify(text)}`,
      );
    }
  });

  it("守卫够不到的深层畸形走异常兜底（不抛）", () => {
    // nodes 元素非对象 → renderOutline 读 node.line 抛错；blocks 元素为 null → formatBlock 读 block.section 抛错
    const deepNodes = renderOf({ ok: true, mode: "outline", nodes: [null] });
    assert.ok(
      deepNodes.includes('"nodes"'),
      `实得 ${JSON.stringify(deepNodes)}`,
    );
    const deepBlocks = renderOf({
      ok: true,
      mode: "outline",
      nodes: [],
      blocks: [null],
    });
    assert.ok(
      deepBlocks.includes('"blocks"'),
      `实得 ${JSON.stringify(deepBlocks)}`,
    );
    // jsonText 自身的兜底路径：BigInt / 循环引用不可序列化
    assert.equal(renderOf(1n), "1");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(typeof renderOf(cyclic), "string");
  });

  it("正常形状输出逐字不变（四分支；既有断言不改数字）", () => {
    // 失败分支
    assert.equal(
      renderOf({
        ok: false,
        mode: "outline",
        path: "p.ts",
        error: "too_large",
        message: "文件过大",
      }),
      "fs_digest 失败：too_large — 文件过大",
    );
    // outline：标题树 + 块清单（同一渲染器、同一预算与文案）
    assert.equal(
      renderOf({
        ok: true,
        mode: "outline",
        path: "p.md",
        language: "markdown",
        source: "markdown",
        depth: 3,
        nodes: [
          {
            kind: "heading",
            name: "标题一",
            line: 1,
            endLine: 2,
            children: [],
          },
        ],
        blocks: [{ kind: "list", line: 3, endLine: 5, section: 1, count: 2 }],
      }),
      "L1-2 heading 标题一\n块结构（1 个）：\n§L1 L3-5 list·2项",
    );
    // outline 空节点列表 → 既有文案
    assert.equal(
      renderOf({ ok: true, mode: "outline", nodes: [] }),
      "(空大纲)",
    );
    // signatures：L<n> kind signature；空列表 → 既有文案
    assert.equal(
      renderOf({
        ok: true,
        mode: "signatures",
        path: "p.ts",
        language: "typescript",
        source: "heuristic",
        signatures: [
          { kind: "function", name: "f", line: 3, signature: "f(): void" },
        ],
      }),
      "L3 function f(): void",
    );
    assert.equal(
      renderOf({ ok: true, mode: "signatures", signatures: [] }),
      "(无函数签名)",
    );
    // pruned：正文截断 80 行 + 省略行；空串 → 空串（既有语义）
    const longText = Array.from({ length: 90 }, (_, i) => `L${i + 1}`).join(
      "\n",
    );
    assert.equal(
      renderOf({ ok: true, mode: "pruned", text: longText }),
      `${Array.from({ length: 80 }, (_, i) => `L${i + 1}`).join("\n")}\n…（其余 10 行）`,
    );
    assert.equal(renderOf({ ok: true, mode: "pruned", text: "" }), "");
  });
});
