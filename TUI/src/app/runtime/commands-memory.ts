// TUI/src/app/runtime/commands-memory.ts — 记忆命令: /memory 的概要、检索、列举、增删改
//
// 2026-11-04 拆分自 TUI/src/app/index.ts 的 App 类体: 方法体只做 this. -> ctx. 改写,
// 跨模块调用经 ctx.self, 公共状态在 ./context.ts.

import type { MemoryRowRef } from "../adapter/types.ts";
import { SESSION_TIER, isManagedTier } from "../adapter/types.ts";
import { MEMORY_USAGE } from "../exit-guards.ts";
import type { AppContext } from "./context.ts";

export function createCommandsMemoryPart(ctx: AppContext) {
  /** /memory：子命令分发——缺省概要；`review [tier]` 审阅面板；`search <query>
   *  [--all-projects]`；`add <tier> [--kind <k>] <content>`（origin: user 免审直达）。 */
  function handleMemoryCommand(line?: string): void {
    // dispatch 传入的 line 含 "/memory" 前缀（同 /session 的 slice 口径），先剥掉。
    const raw = (line ?? "").replace(/^\/memory/, "").trim();
    const sub = raw === "" ? "" : (raw.split(/\s+/)[0] ?? "");
    const rest = raw === "" ? "" : raw.slice(sub.length).trim();
    if (sub === "") {
      showMemorySummary();
      return;
    }
    if (sub === "review") {
      // 审阅面板随 memory-base 瘦身移除（候选队列 `candidates.*` 已删）：只留一句指引。
      ctx.self.notice(
        "审阅面板已移除：用 /memory list 定位条目、/memory remove|replace 修正（/memory search 检索）",
        "warn",
      );
      return;
    }
    if (sub === "search") {
      handleMemorySearchCommand(rest);
      return;
    }
    if (sub === "list") {
      handleMemoryListCommand(rest);
      return;
    }
    if (sub === "remove") {
      handleMemoryRemoveCommand(rest);
      return;
    }
    if (sub === "replace") {
      handleMemoryReplaceCommand(rest);
      return;
    }
    if (sub === "add") {
      handleMemoryAddCommand(rest);
      return;
    }
    ctx.self.notice(MEMORY_USAGE, "warn");
  }

  /** `/memory` 行的单行呈现：`· #id [tier/kind] 摘要（project）`（id 供 remove / replace 寻址）。 */
  function formatMemoryRow(hit: unknown): string {
    const row = hit as {
      id?: number;
      kind?: string;
      title?: string;
      content?: string;
      tier?: string;
      project?: string;
      doc?: { ref: string; lineStart: number; lineEnd: number };
    };
    const scope = row.tier ?? "?";
    const kind = row.kind ?? "?";
    const id = typeof row.id === "number" ? `#${row.id} ` : "";
    const head =
      row.title && row.title !== ""
        ? row.title
        : (row.content ?? "").slice(0, 60);
    const where =
      row.doc !== undefined
        ? ` → ${row.doc.ref}:${row.doc.lineStart}-${row.doc.lineEnd}`
        : "";
    return `· ${id}[${scope}/${kind}] ${head}${where}（${row.project ?? "-"}）`;
  }

  /** 解析管理面地址 `<tier> <kind> <id>`（只接受 project / user）。 */
  function parseMemoryRef(
    tokens: string[],
  ): { ref: MemoryRowRef; rest: string } | { reason: string } {
    const [tier, kind, idText] = tokens;
    if (!isManagedTier(tier)) {
      return {
        reason: `tier 只接受 project / user（收到 ${tier ?? "空"}；S 层按会话隔离，管理面不处理）`,
      };
    }
    if (kind === undefined || kind === "") return { reason: "缺 kind" };
    const id = Number(idText);
    if (!Number.isInteger(id) || id <= 0) {
      return { reason: `id 必须是正整数（收到 ${idText ?? "空"}）` };
    }
    return { ref: { tier, kind, id }, rest: tokens.slice(3).join(" ") };
  }

  /** 概要（notice 型）——就绪 → info 展示；未就绪 → info 说明；缺失/失败 → warn。 */
  function showMemorySummary(): void {
    const adapter = ctx.deps.adapter;
    const summary = adapter.memorySummary;
    if (!summary) {
      ctx.self.notice("knowledge 服务不可用", "warn");
      return;
    }
    void summary.call(adapter).then(
      (text) =>
        ctx.self.notice(
          text && text.trim() !== "" ? text : "知识库尚未就绪",
          "info",
        ),
      () => ctx.self.notice("knowledge 服务不可用", "warn"),
    );
  }

  /** `/memory search <query> [--all-projects]`：跨全域检索，notice 呈现。
   *  `--all-projects` 是**标注非开关**（设计 §7：跨项目读 = bundle 启动期配置的
   *  crossProjectRoots，配置后已自动参与检索；动态开口记观察项）。 */
  function handleMemorySearchCommand(rest: string): void {
    const allProjects = rest.includes("--all-projects");
    const query = rest.replace("--all-projects", "").trim();
    if (query === "") {
      ctx.self.notice("usage: /memory search <query> [--all-projects]", "warn");
      return;
    }
    const search = ctx.deps.adapter.memorySearch;
    if (!search) {
      ctx.self.notice("knowledge 服务不可用", "warn");
      return;
    }
    void search.call(ctx.deps.adapter, { query, limit: 10 }).then(
      (hits) => {
        if (!hits || hits.length === 0) {
          ctx.self.notice("无命中", "info");
          return;
        }
        const lines = hits.map((hit) => formatMemoryRow(hit));
        const tag = allProjects
          ? "--all-projects：检索范围 = 已配置的跨项目库（未配置则仅本域）\n"
          : "";
        ctx.self.notice(tag + lines.join("\n"), "info");
      },
      () => ctx.self.notice("检索失败", "warn"),
    );
  }

  /** `/memory list [project|user] [--kind <k>]`：管理面列举（`remove` / `replace` 的寻址入口）。 */
  function handleMemoryListCommand(rest: string): void {
    const tokens = rest.split(/\s+/).filter((token) => token !== "");
    let tier: "project" | "user" | undefined;
    let kind: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === "--kind") {
        kind = tokens[i + 1];
        i++;
        continue;
      }
      if (isManagedTier(token)) {
        tier = token;
        continue;
      }
      ctx.self.notice(
        "usage: /memory list [project|user] [--kind <k>]",
        "warn",
      );
      return;
    }
    const list = ctx.deps.adapter.memoryList;
    if (!list) {
      ctx.self.notice("knowledge 服务不可用（管理面）", "warn");
      return;
    }
    void list
      .call(ctx.deps.adapter, {
        ...(tier === undefined ? {} : { tier }),
        ...(kind === undefined ? {} : { kind }),
        limit: 20,
      })
      .then(
        (rows) => {
          if (rows === undefined) {
            ctx.self.notice(
              "管理面不可用（memory-base 未挂载或版本过旧）",
              "warn",
            );
            return;
          }
          if (rows.length === 0) {
            ctx.self.notice("（无条目；管理面只列 U / P 层）", "info");
            return;
          }
          ctx.self.notice(
            rows.map((row) => formatMemoryRow(row)).join("\n"),
            "info",
          );
        },
        () => ctx.self.notice("列举失败", "warn"),
      );
  }

  /** `/memory remove <tier> <kind> <id>`：管理面真删 U / P 条目。 */
  function handleMemoryRemoveCommand(rest: string): void {
    const parsed = parseMemoryRef(
      rest.split(/\s+/).filter((token) => token !== ""),
    );
    if ("reason" in parsed) {
      ctx.self.notice(`${parsed.reason}\n${MEMORY_USAGE}`, "warn");
      return;
    }
    const forget = ctx.deps.adapter.memoryForget;
    if (!forget) {
      ctx.self.notice("knowledge 服务不可用（管理面）", "warn");
      return;
    }
    const { ref } = parsed;
    void forget.call(ctx.deps.adapter, ref).then(
      (result) => {
        if (!result.ok) {
          ctx.self.notice(`删除失败：${result.reason ?? "未知原因"}`, "warn");
          return;
        }
        if (result.removed === 0) {
          ctx.self.notice(
            `未找到 ${ref.tier}/${ref.kind}#${ref.id}（未改动）`,
            "info",
          );
          return;
        }
        ctx.self.notice(
          `已删除 ${ref.tier}/${ref.kind}#${ref.id}（${result.removed} 条）`,
          "success",
        );
      },
      () => ctx.self.notice("删除失败（管理面抛错）", "warn"),
    );
  }

  /** `/memory replace <tier> <kind> <id> <content>`：管理面就地更新（失败时原行不动）。 */
  function handleMemoryReplaceCommand(rest: string): void {
    const parsed = parseMemoryRef(
      rest.split(/\s+/).filter((token) => token !== ""),
    );
    if ("reason" in parsed) {
      ctx.self.notice(`${parsed.reason}\n${MEMORY_USAGE}`, "warn");
      return;
    }
    const content = parsed.rest.trim();
    if (content === "") {
      ctx.self.notice(`缺替换内容\n${MEMORY_USAGE}`, "warn");
      return;
    }
    const replace = ctx.deps.adapter.memoryReplace;
    if (!replace) {
      ctx.self.notice("knowledge 服务不可用（管理面）", "warn");
      return;
    }
    const { ref } = parsed;
    void replace.call(ctx.deps.adapter, ref, { content }).then(
      (result) => {
        if (result.ok) {
          ctx.self.notice(
            `已更新 ${ref.tier}/${ref.kind}#${ref.id}`,
            "success",
          );
          return;
        }
        const reason =
          result.skipped === "duplicate"
            ? "内容与该分类另一条重复"
            : result.skipped === "missing"
              ? "条目不存在"
              : result.skipped === "kind"
                ? "分类未注册"
                : result.skipped === "hook"
                  ? "被该分类的写前钩子拒绝"
                  : (result.skipped ?? "未知原因");
        ctx.self.notice(`更新被拒（${reason}），原条目未改动`, "warn");
      },
      () => ctx.self.notice("更新失败（管理面抛错），原条目未改动", "warn"),
    );
  }

  /** `/memory add <project|user> --kind <k> <content>`：管理面用户直写（免审直达；
   *  数据面仍过内容闸门与 `preWrite`）。kind 必填（没有兜底分类），S 层按会话隔离不处理。 */
  function handleMemoryAddCommand(rest: string): void {
    const tokens = rest.split(/\s+/).filter((token) => token !== "");
    const tier = tokens[0];
    if (tier === SESSION_TIER) {
      ctx.self.notice(
        "管理面不处理会话层（S 层按会话隔离），请用 project / user",
        "warn",
      );
      return;
    }
    if (!isManagedTier(tier)) {
      ctx.self.notice(MEMORY_USAGE, "warn");
      return;
    }
    const kindFlag = tokens.indexOf("--kind");
    let kind: string | undefined;
    if (kindFlag >= 0) {
      kind = tokens[kindFlag + 1];
      tokens.splice(kindFlag, 2);
    }
    const content = tokens.slice(1).join(" ").trim();
    if (content === "") {
      ctx.self.notice(MEMORY_USAGE, "warn");
      return;
    }
    if (kind === undefined || kind === "") {
      ctx.self.notice("add 必须显式 --kind（没有兜底分类）", "warn");
      return;
    }
    const add = ctx.deps.adapter.memoryAdd;
    if (!add) {
      ctx.self.notice("knowledge 服务不可用", "warn");
      return;
    }
    void add.call(ctx.deps.adapter, { content, kind, tier }).then(
      (result) => {
        if (result.ok) {
          ctx.self.notice(`已记录（${tier} · ${kind}）`, "info");
        } else {
          ctx.self.notice(
            `写入被拒${result.skipped === undefined ? "" : `（${result.skipped}）`}`,
            "warn",
          );
        }
      },
      () => ctx.self.notice("写入失败", "warn"),
    );
  }

  return {
    handleMemoryCommand,
    formatMemoryRow,
    parseMemoryRef,
    showMemorySummary,
    handleMemorySearchCommand,
    handleMemoryListCommand,
    handleMemoryRemoveCommand,
    handleMemoryReplaceCommand,
    handleMemoryAddCommand,
  };
}
