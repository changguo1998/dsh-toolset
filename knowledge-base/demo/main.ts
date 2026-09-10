/**
 * knowledge-base mock demo（无 DSH 宿主依赖）。
 * 演示：put/search（porter + CJK 兜底）、session/event 写直达、记忆 CRUD、
 * resume top-K 提升、批量写回。退出码 0 表示流程通过，供人工确认。
 */

import { openKnowledgeDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";
import { MemoryService } from "../src/memory.ts";
import { WritePolicy } from "../src/writepolicy.ts";
import { SessionHooks } from "../src/hooks.ts";

/** 极简 mock 宿主：可 emit session/event，验证写直达事件过滤器。 */
function makeHost() {
  const listeners: Array<
    (session: { id: string }, event: { type: string; data?: unknown }) => void
  > = [];
  return {
    on: (
      _event: string,
      cb: (
        session: { id: string },
        event: { type: string; data?: unknown },
      ) => void,
    ) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    emit: (
      session: { id: string },
      event: { type: string; data?: unknown },
    ) => {
      for (const cb of [...listeners]) cb(session, event);
    },
  };
}

async function main(): Promise<void> {
  const db = await openKnowledgeDatabase(":memory:");
  const kb = new KnowledgeService(db);
  const memory = new MemoryService(db);
  const policy = new WritePolicy(kb);

  // 1. put + search：porter 词干与中文 LIKE 兜底。
  const put = kb.put({
    project: "demo",
    title: "FTS5 检索",
    content:
      "node:sqlite 内置 FTS5，支持 porter 语义词干与 trigram 子串双索引，TRIGGER 写直达保持一致。",
    category: "note",
  });
  console.log("[1] put → ids=%j created=%d", put.ids, put.created);
  const hits = kb.search({ query: "词干", project: "demo" });
  console.log(
    '[1] search("词干") → %d 条：%j',
    hits.length,
    hits.map((h) => h.title),
  );

  // 2. session/event 写直达：白名单内事件自动沉淀。
  const host = makeHost();
  const detach = new SessionHooks(kb, { project: "demo" }).attach(host);
  host.emit(
    { id: "s1" },
    {
      type: "tool/result",
      data: {
        message: { content: [{ content: [{ text: "构建通过，零类型错误" }] }] },
      },
    },
  );
  host.emit(
    { id: "s1" },
    {
      type: "plan/mode",
      data: { title: "下一阶段计划", detail: "写回/淘汰/提升" },
    },
  );
  detach();
  const hookHits = kb.search({ query: "构建通过" });
  console.log(
    "[2] 事件写直达 → tool/result 沉淀可检索：%d 条",
    hookHits.length,
  );

  // 3. 持久记忆 CRUD。
  const mem = memory.add({
    target: "user",
    category: "preference",
    content: "偏好中文交流与中文提交信息",
  });
  memory.add({
    target: "project",
    project: "demo",
    category: "convention",
    content: "改动后跑 npm run check 与 test",
  });
  console.log("[3] memory.add → id=%d", mem.id);
  const memHits = memory.search({ query: "中文", tokenBudget: 100 });
  console.log(
    '[3] memory.search("中文") → %d 条，usedTokens=%d truncated=%s',
    memHits.hits.length,
    memHits.usedTokens,
    memHits.truncated,
  );
  const replaced = memory.replace({
    target: "user",
    oldText: "偏好中文交流",
    content: "偏好中文交流；文档中文，代码英文",
  });
  console.log("[3] memory.replace → %s", replaced);

  // 4. resume top-K 提升 + 批量写回。
  const top = kb.promote({ project: "demo", limit: 3 });
  console.log(
    "[4] promote → %d 条：%j",
    top.length,
    top.map((h) => `#${h.id} imp=${h.importance}`),
  );
  const wb = await policy.writeBack([
    { project: "demo", content: "批量写回示例：聚合会话经验" },
  ]);
  console.log("[4] writeBack → %j", wb);

  console.log("demo OK");
  db.close();
}

main().catch((error: unknown) => {
  console.error("demo failed:", error);
  process.exitCode = 1;
});
