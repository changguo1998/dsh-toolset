// fs-digest/tests/index.test.ts — index 层锚点: 工具入参校验分支、可选参数过滤、会话 cwd 回退.
// render 的兜底口径已由 fs-digest/tests/digest.test.ts 的全函数性用例覆盖, 这里只补入参路径.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../src/index.ts";
import type { DigestResult } from "../src/types.ts";

interface ToolLike {
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>;
}

/** 注册 fs_digest 并取工具定义 (apply 的最小宿主面). */
function registerTool(): ToolLike {
  const tools: ToolLike[] = [];
  apply(
    {
      tools: {
        register: (tool: ToolLike) => {
          tools.push(tool);
        },
      },
    } as never,
    {},
  );
  const tool = tools[0];
  assert.ok(tool !== undefined, "apply 应注册 fs_digest");
  return tool;
}

/** 临时目录 + 指定文件, 用例结束清理. */
async function withFile(
  name: string,
  content: string,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fs-digest-index-"));
  try {
    const path = join(dir, name);
    await writeFile(path, content);
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("工具入参校验", () => {
  const tool = registerTool();
  const probes: Array<{ label: string; args: Record<string, unknown> }> = [
    { label: "缺 path", args: { mode: "outline" } },
    { label: "path 非 string", args: { path: 42, mode: "outline" } },
    { label: "path 空串", args: { path: "", mode: "outline" } },
    { label: "缺 mode", args: { path: "a.md" } },
    { label: "mode 非 string", args: { path: "a.md", mode: 3 } },
    { label: "mode 非枚举", args: { path: "a.md", mode: "weird" } },
  ];

  it("schema 越界（缺参 / 类型错 / 非枚举）由包装层抛 INVALID_ARGS; 空串仍走工具软校验", async () => {
    for (const probe of probes) {
      if (probe.label === "path 空串") {
        const result = (await tool.execute(probe.args)) as DigestResult;
        assert.equal(result.ok, false, probe.label);
        if (!result.ok) {
          assert.equal(result.error, "invalid_option", probe.label);
        }
        continue;
      }
      await assert.rejects(
        () => tool.execute(probe.args),
        (error: unknown) =>
          (error as { code?: string }).code === "INVALID_ARGS",
        probe.label,
      );
    }
  });

  it("可选参数类型不符时由包装层拒绝（不再静默忽略）", async () => {
    await withFile("doc.md", "# H1\n\n### H3\n", async (path) => {
      await assert.rejects(
        () => tool.execute({ path, mode: "outline", depth: "1" }),
        (error: unknown) =>
          (error as { code?: string }).code === "INVALID_ARGS",
      );
      const pruned = (await tool.execute({
        path,
        mode: "pruned",
        maxLines: 2,
      })) as DigestResult;
      assert.equal(pruned.ok, true);
      if (pruned.ok && pruned.mode === "pruned") {
        assert.equal(pruned.truncated, true, "maxLines=2 触发裁剪");
      }
    });
  });

  it("language 提示覆盖扩展名推断; requireLsp 透传到符号检查", async () => {
    await withFile("notes.zz", "## 标题\n", async (path) => {
      const hinted = (await tool.execute({
        path,
        mode: "outline",
        language: "markdown",
      })) as DigestResult;
      assert.equal(hinted.ok, true);
      if (hinted.ok && hinted.mode === "outline") {
        assert.equal(hinted.language, "markdown");
        assert.equal(hinted.source, "markdown");
      }
    });
    await withFile("mod.ts", "export function f(): void {}\n", async (path) => {
      const strict = (await tool.execute({
        path,
        mode: "outline",
        requireLsp: true,
      })) as DigestResult;
      assert.equal(strict.ok, false);
      if (!strict.ok) assert.equal(strict.error, "lsp_unavailable");
    });
  });
});

describe("会话 cwd 回退", () => {
  it("cwd 为空串 / 非字符串时回退进程 cwd, 不抛错", async () => {
    const tool = registerTool();
    for (const exec of [
      { agent: { session: { header: { cwd: "" } } } },
      { agent: { session: { header: { cwd: 42 } } } },
    ]) {
      const result = (await tool.execute(
        { path: ".fs-digest-index-no-such-file.ts", mode: "outline" },
        exec,
      )) as DigestResult;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "file_not_found");
    }
  });
});
