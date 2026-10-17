/**
 * memory-base mock demo（无 DSH 宿主依赖）：分层落点、作用域句柄写入、
 * 内容闸门（隐私 / preWrite / 越权层）、跨层检索与列举、真删、模型侧工具渲染。
 * 退出码 0 表示流程通过，供人工确认。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGlobalService,
  createMemoryBundle,
  type KnowledgeConfig,
} from "../src/index.ts";
import { memoryQueryTool, type MemoryQueryExecutor } from "../src/tools.ts";

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kb-demo-"));
  const config: KnowledgeConfig = {
    dshHome: join(dir, "dsh"),
    projectRoot: join(dir, "repo"),
    project: "demo",
  };
  const sessionPaths = {
    sessionDirFor: (id: string) => join(dir, "sessions", "demo", id),
  };
  const bundle = createMemoryBundle({ config, sessionPaths });
  const memory = createGlobalService(bundle, config);
  try {
    // 1. 注册分类拿句柄：缺省只可写会话层，显式声明才可写 P / U 层。
    const note = memory.registerKind({
      kind: "note",
      writableTiers: ["session", "project"],
    });
    const pref = memory.registerKind({
      kind: "pref",
      writableTiers: ["user"],
      preWrite: (input) =>
        input.content.startsWith("拒绝")
          ? { accept: false, reason: "demo 钩子拒写" }
          : { accept: true, importance: 4 },
    });
    console.log(
      "[1] 句柄 note=%j pref=%j",
      note.writableTiers,
      pref.writableTiers,
    );

    // 2. 写入：会话层要 sessionId；项目 / 用户层按声明直落。
    const s = await note.put({
      content: "node:sqlite 内置 FTS5，porter 词干与 trigram 子串双索引。",
      title: "FTS5 检索",
      sessionId: "s1",
    });
    const p = await note.put({
      content: "闸门在库核心：隐私闸 → 注册方 preWrite → INSERT。",
      tier: "project",
    });
    console.log(
      "[2] 会话层写入 ids=%j created=%d；项目层写入 ids=%j",
      s.ids,
      s.created,
      p.ids,
    );

    const u = await pref.put({
      content: "用户偏好：提交信息用中文。",
      tier: "user",
    });
    console.log("[3] 用户层写入 ids=%j（importance 由钩子建议为 4）", u.ids);

    // 3. 内容闸门：隐私形态与 preWrite 都走 skipped，不抛错。
    const privacy = await pref.put({
      content: "password: supersecretvalue",
      tier: "user",
    });
    const denied = await pref.put({ content: "拒绝这条", tier: "user" });
    console.log(
      "[4] 隐私闸 skipped=%s，钩子 skipped=%s",
      privacy.skipped,
      denied.skipped,
    );

    // 4. 越权层写入抛明示例外。
    try {
      await pref.put({ content: "越权写会话层" });
      console.log("[5] 越权写入未被拒绝（不符合预期）");
    } catch (error: unknown) {
      console.log("[5] 越权写入被拒：%s", (error as Error).message);
    }

    // 5. 查询：跨层检索（U > P > S 加权）、按 kind 列举、用量与摘要。
    const hits = await memory.search({ query: "闸门 OR 偏好 OR FTS5" });
    console.log(
      "[6] search → %d 条：%j",
      hits.length,
      hits.map((hit) => `${hit.kind}@${hit.tier}`),
    );
    const rows = await memory.list({ kind: "note" });
    console.log(
      "[7] list(note) → %d 条：%j",
      rows.length,
      rows.map((row) => row.title),
    );
    const summary = memory.getSummary();
    console.log("[8] 摘要 → %j", {
      kinds: summary.kinds.map((kind) => `${kind.kind}:${kind.rows}`),
      tiers: summary.tiers.map(
        (entry) => `${entry.tier}:${entry.created ? "已建" : "未建"}`,
      ),
      usage: (await memory.usage()).map((entry) => entry.tier),
    });

    // 6. 真删：返回条数（旧口径的单库恒返 0 已修）。
    const removed = await pref.forget([{ tier: "user", ids: u.ids }]);
    console.log(
      "[9] forget → 删除 %d 条，剩余检索 %d",
      removed,
      (await memory.search({ query: "偏好" })).length,
    );

    // 7. 模型侧工具：只读查询的渲染形态。
    const executor: MemoryQueryExecutor = {
      list: (opts) => memory.list(opts),
      search: (opts) => memory.search(opts),
    };
    const tool = memoryQueryTool(executor) as {
      execute(args: Record<string, unknown>): Promise<unknown>;
      output: {
        render(args: unknown, value: unknown): Array<{ text: string }>;
      };
    };
    const value = await tool.execute({
      action: "list",
      kind: "note",
      limit: 2,
    });
    console.log("[10] memory_query 渲染：");
    console.log(tool.output.render({}, value)[0]?.text);

    console.log("demo OK");
  } finally {
    bundle.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error("demo failed:", error);
  process.exitCode = 1;
});
