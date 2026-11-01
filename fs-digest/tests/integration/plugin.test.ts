/**
 * 集成层用例 (`fs-digest/tests/integration/plugin.test.ts`):
 * 用 `fs-digest/tests/assemble.ts` 的假工具面 / 假事件面 / 假服务面拼宿主并调用 `apply`,
 * 断言工具注册名、`execute` 的 canonical 值、`output.render` 投影与服务面接线.
 *
 * 需要真实文件的用例落在临时目录, 用后统一清理; LSP 符号经假服务面注入,
 * 不连真实宿主.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { assemble, renderText } from "../assemble.ts";
import type { AssembledHost, ToolDefLike } from "../assemble.ts";

/** 每个用例一份临时目录, 结束后统一清理. */
const dirs: string[] = [];
async function workspace(
  files: Record<string, string | Uint8Array> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fs-digest-it-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}
after(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Markdown 夹具: 一个标题 + 一个两列表块. */
const MD = ["# 标题", "", "段落", "", "- a", "- b", ""].join("\n");
/** TS 夹具: 单行函数 + 类方法. */
const TS = [
  "export function alpha(x: number): number { return x; }",
  "",
  "class Box {",
  "  method(): void {}",
  "}",
  "",
].join("\n");

function toolOf(host: AssembledHost): ToolDefLike {
  return host.tools.require("fs_digest");
}

describe("工具注册与宿主接线", () => {
  it("apply 注册单个 fs_digest, 参数面与三模式枚举不变", () => {
    const host = assemble();
    assert.deepEqual(host.tools.names(), ["fs_digest"]);
    const tool = toolOf(host);
    assert.deepEqual(tool.parameters.required, ["path", "mode"]);
    const properties = tool.parameters.properties as Record<
      string,
      { enum?: string[] }
    >;
    assert.deepEqual(properties.mode?.enum, [
      "outline",
      "signatures",
      "pruned",
    ]);
    assert.equal(
      (tool.output.schema as { type?: string }).type,
      "object",
      "output.schema 为宿主契约的 object 面",
    );
  });

  it("无事件消费者 (零订阅), apply 不向服务面写入", () => {
    const host = assemble();
    assert.equal(host.events.listenerCount(), 0);
    assert.deepEqual(host.services.names(), []);
  });

  it("config.maxBytes 透传到读取守卫", async () => {
    const dir = await workspace({ "doc.md": MD });
    const host = assemble({ config: { maxBytes: 8 } });
    const result = await toolOf(host).execute({
      path: join(dir, "doc.md"),
      mode: "outline",
    });
    assert.deepEqual(result, {
      ok: false,
      mode: "outline",
      path: join(dir, "doc.md"),
      error: "too_large",
      message: `文件大小 26B 超过上限 8B（可用 pruned 模式缩小输出或拆分文件）`,
    });
  });
});

describe("execute 的 canonical 值", () => {
  it("outline: Markdown 标题树带行范围, 块清单带节归属", async () => {
    const dir = await workspace({ "doc.md": MD });
    const result = await toolOf(assemble()).execute({
      path: join(dir, "doc.md"),
      mode: "outline",
    });
    assert.deepEqual(result, {
      ok: true,
      mode: "outline",
      path: join(dir, "doc.md"),
      language: "markdown",
      source: "markdown",
      depth: 3,
      nodes: [
        { kind: "heading", name: "标题", line: 1, endLine: 6, children: [] },
      ],
      blocks: [{ kind: "list", line: 5, endLine: 6, section: 1, count: 2 }],
    });
  });

  it("signatures: TS 启发式给函数与方法签名, 行号 1 基", async () => {
    const dir = await workspace({ "mod.ts": TS });
    const result = await toolOf(assemble()).execute({
      path: join(dir, "mod.ts"),
      mode: "signatures",
    });
    assert.deepEqual(result, {
      ok: true,
      mode: "signatures",
      path: join(dir, "mod.ts"),
      language: "typescript",
      source: "heuristic",
      signatures: [
        {
          kind: "function",
          name: "alpha",
          line: 1,
          signature: "export function alpha(x: number): number { return x; }",
        },
        {
          kind: "method",
          name: "method",
          line: 4,
          signature: "method(): void {}",
        },
      ],
    });
  });

  it("pruned: 预算内返回全文, 超预算保留头尾并给省略标记", async () => {
    const small = await workspace({ "small.md": "a\nb\nc\n" });
    const full = await toolOf(assemble()).execute({
      path: join(small, "small.md"),
      mode: "pruned",
    });
    assert.deepEqual(full, {
      ok: true,
      mode: "pruned",
      path: join(small, "small.md"),
      totalLines: 4,
      truncated: false,
      keptHead: 4,
      keptTail: 0,
      elidedLines: 0,
      estimatedTokens: 2,
      text: "a\nb\nc\n",
    });

    const tenLines = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join(
      "\n",
    );
    const big = await workspace({ "big.log": tenLines });
    const cut = await toolOf(assemble()).execute({
      path: join(big, "big.log"),
      mode: "pruned",
      maxLines: 4,
    });
    assert.deepEqual(cut, {
      ok: true,
      mode: "pruned",
      path: join(big, "big.log"),
      totalLines: 10,
      truncated: true,
      keptHead: 2,
      keptTail: 1,
      elidedLines: 6,
      estimatedTokens: 9,
      text: "l1\nl2\n... [6 行已省略，共 10 行] ...\nl10",
    });
  });

  it("错误面: 入参 / 文件守卫 / 语言 / requireLsp 的 code 与文案", async () => {
    const dir = await workspace({
      "bin.dat": Buffer.from([0x00, 0x01, 0xff]),
      "notes.zz": "## 标题\n",
    });
    const tool = toolOf(assemble());
    const invalid = await tool.execute({ path: "", mode: "unknown" });
    assert.equal((invalid as { error?: string }).error, "invalid_option");
    const missing = await tool.execute({
      path: join(dir, "no-such.md"),
      mode: "outline",
    });
    assert.equal((missing as { error?: string }).error, "file_not_found");
    const directory = await tool.execute({ path: dir, mode: "outline" });
    assert.equal((directory as { error?: string }).error, "not_a_file");
    const binary = await tool.execute({
      path: join(dir, "bin.dat"),
      mode: "pruned",
    });
    assert.equal((binary as { error?: string }).error, "binary");
    const unknownLanguage = await tool.execute({
      path: join(dir, "notes.zz"),
      mode: "outline",
    });
    assert.deepEqual(unknownLanguage, {
      ok: false,
      mode: "outline",
      path: join(dir, "notes.zz"),
      error: "unsupported_language",
      message: `语言无法识别（${join(dir, "notes.zz")}）且无可用 LSP 符号源；可用 language 选项提示语言`,
    });
    const hinted = await tool.execute({
      path: join(dir, "notes.zz"),
      mode: "outline",
      language: "markdown",
    });
    assert.equal((hinted as { source?: string }).source, "markdown");
    const ts = await workspace({ "mod.ts": TS });
    const noLsp = await tool.execute({
      path: join(ts, "mod.ts"),
      mode: "signatures",
      requireLsp: true,
    });
    assert.equal((noLsp as { error?: string }).error, "lsp_unavailable");
  });

  it("相对路径以会话 cwd 为基准, 无 exec 时回退进程 cwd", async () => {
    const dir = await workspace({
      "nested/mod.py": "def alpha():\n    pass\n",
    });
    const tool = toolOf(assemble());
    const ok = await tool.execute(
      { path: "nested/mod.py", mode: "signatures" },
      { agent: { session: { header: { cwd: dir } } } },
    );
    assert.deepEqual(ok, {
      ok: true,
      mode: "signatures",
      path: "nested/mod.py",
      language: "python",
      source: "heuristic",
      signatures: [
        { kind: "function", name: "alpha", line: 1, signature: "def alpha()" },
      ],
    });
    const fallback = await tool.execute({
      path: ".fs-digest-it-no-such.py",
      mode: "signatures",
    });
    assert.equal((fallback as { error?: string }).error, "file_not_found");
  });
});

describe("output.render 投影", () => {
  it("三模式投影: 标题树 / 签名行 / 裁剪正文", async () => {
    const dir = await workspace({ "doc.md": MD, "mod.ts": TS });
    const tool = toolOf(assemble());
    const outline = await tool.execute({
      path: join(dir, "doc.md"),
      mode: "outline",
    });
    assert.equal(
      renderText(tool, outline),
      "L1-6 heading 标题\n块结构（1 个）：\n§L1 L5-6 list·2项",
    );
    const signatures = await tool.execute({
      path: join(dir, "mod.ts"),
      mode: "signatures",
    });
    assert.equal(
      renderText(tool, signatures),
      [
        "L1 function export function alpha(x: number): number { return x; }",
        "L4 method method(): void {}",
      ].join("\n"),
    );
    const pruned = await tool.execute({
      path: join(dir, "doc.md"),
      mode: "pruned",
    });
    assert.equal(renderText(tool, pruned), MD);
  });

  it("失败结果与非法形状退回可读文本, 不抛错", () => {
    const tool = toolOf(assemble());
    assert.equal(
      renderText(tool, {
        ok: false,
        mode: "outline",
        path: "p.ts",
        error: "too_large",
        message: "文件过大",
      }),
      "fs_digest 失败：too_large — 文件过大",
    );
    assert.equal(renderText(tool, undefined), "undefined");
    assert.ok(
      renderText(tool, { ok: true, mode: "weird" }).includes('"weird"'),
      "非三模式结果退回 JSON 原文",
    );
    const longText = Array.from({ length: 90 }, (_, i) => `L${i + 1}`).join(
      "\n",
    );
    assert.match(
      renderText(tool, { ok: true, mode: "pruned", text: longText }),
      /…（其余 10 行）$/,
    );
  });
});

describe("假服务面: LSP 符号源", () => {
  const lspService = (symbols: unknown) => ({
    documentSymbols: async (): Promise<unknown> => symbols,
  });

  it("ctx.get('lsp') 的符号进入 signatures (source=lsp)", async () => {
    const dir = await workspace({ "mod.ts": TS });
    const host = assemble({
      services: {
        lsp: lspService([
          {
            name: "LspFunc",
            kind: "function",
            line: 1,
            signature: "f(): void",
          },
        ]),
      },
    });
    const result = await toolOf(host).execute({
      path: join(dir, "mod.ts"),
      mode: "signatures",
    });
    assert.deepEqual(result, {
      ok: true,
      mode: "signatures",
      path: join(dir, "mod.ts"),
      language: "typescript",
      source: "lsp",
      signatures: [
        { kind: "function", name: "LspFunc", line: 1, signature: "f(): void" },
      ],
    });
  });

  it("符号提供器调用失败: 降级启发式, requireLsp 时报调用失败原因", async () => {
    const dir = await workspace({ "mod.ts": TS });
    const host = assemble({
      services: {
        lsp: {
          documentSymbols: async (): Promise<unknown> => {
            throw new Error("lsp down");
          },
        },
      },
    });
    const tool = toolOf(host);
    const degraded = await tool.execute({
      path: join(dir, "mod.ts"),
      mode: "signatures",
    });
    assert.equal((degraded as { source?: string }).source, "heuristic");
    const strict = await tool.execute({
      path: join(dir, "mod.ts"),
      mode: "signatures",
      requireLsp: true,
    });
    assert.equal((strict as { error?: string }).error, "lsp_unavailable");
    assert.match((strict as { message: string }).message, /符号提供器调用失败/);
  });
});
