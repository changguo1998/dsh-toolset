// TUI/src/app/adapter/search-aggregate.ts — 多源搜索聚合与循环行 detail

import type { LoopSummaryLike, SearchSourceLike } from "./types.ts";

/** URL → host（搜索行 title 回落：无标题用域名展示；解析失败原样返回） */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** query → 归一化 token（小写、去空白、切词）；关联度排序用 */
function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((t) => t !== "");
}

/** 单一来源的关联度评分：token 在 title（2 倍权重）与 snippet 的命中数。
 *  皆为 0 时按合并顺序保住（provider 顺序稳定）。 */
function relevanceScore(hit: {
  title: string;
  snippet: string;
  tokens: string[];
}): number {
  let score = 0;
  const title = hit.title.toLowerCase();
  const snippet = hit.snippet.toLowerCase();
  for (const token of hit.tokens) {
    if (title.includes(token)) score += 2;
    if (snippet.includes(token)) score += 1;
  }
  return score;
}

/** 多 provider 搜索结果聚合（/search 核心，纯函数）：
 *  并行 allSettled → 成功 sources 逐个合并（记 provider id）→ 按 URL 去重（首现保留）→
 *  query-token 关联度降序（分数一致保 provider/来源顺序稳定）。返回行 + 成败统计；
 *  单个 provider 失败仅丢其数据（其余保留），全部失败由调用方据 failed===total 判 reject。 */
export function aggregateSearchSources(params: {
  providers: {
    id: string;
    search(): Promise<{ sources: readonly SearchSourceLike[] }>;
  }[];
  query: string;
  maxResults: number;
}): Promise<{
  rows: { title: string; detail: string; payload: string }[];
  success: number;
  failed: number;
  total: number;
}> {
  const tokens = queryTokens(params.query);
  const results = params.providers.map((p) =>
    Promise.resolve()
      .then(() => p.search())
      .then(
        (r) => ({ status: "fulfilled" as const, provider: p.id, r }),
        (err) => ({ status: "rejected" as const, provider: p.id, err }),
      ),
  );
  return Promise.all(results).then((settled) => {
    const seen = new Set<string>();
    const hits: {
      title: string;
      snippet: string;
      tokens: string[];
      source: SearchSourceLike;
      provider: string;
    }[] = [];
    let success = 0;
    let failed = 0;
    for (const s of settled) {
      if (s.status === "rejected") {
        failed++;
        continue;
      }
      success++;
      const sources = Array.isArray(s.r.sources) ? s.r.sources : [];
      for (const src of sources) {
        if (!src || typeof src.url !== "string" || src.url === "") continue;
        const key = src.url.toLowerCase();
        if (seen.has(key)) continue; // URL 去重：首现保留
        seen.add(key);
        hits.push({
          title: typeof src.title === "string" ? src.title : "",
          snippet: typeof src.snippet === "string" ? src.snippet : "",
          tokens,
          source: src,
          provider: s.provider,
        });
      }
    }
    const ordered = hits
      .map((h) => ({ h, score: relevanceScore(h) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, params.maxResults));
    const rows = ordered.map(({ h }) => ({
      title: (h.title !== "" ? h.title : "") || urlHost(h.source.url),
      detail: [
        `[${h.provider}]`,
        h.source.snippet ?? "",
        h.source.publishedAt ?? "",
      ]
        .filter((p) => p !== "")
        .join(" · "),
      payload: h.source.url,
    }));
    return { rows, success, failed, total: params.providers.length };
  });
}

/** 循环 updatedAt → HH:MM（本地时区，行 detail 展示用） */
function loopTime(ms: number | undefined): string {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "?";
  return new Date(ms).toTimeString().slice(0, 5);
}

/** 循环行 detail：状态 · 方向 · 轮数 · 历史最优 · 更新时间 */
export function loopRowDetail(s: LoopSummaryLike): string {
  const parts = [
    s.status === "running" ? "运行中" : "已停止",
    s.direction === "min" ? "最小化" : s.direction === "max" ? "最大化" : "",
    s.measureCmd ?? "",
    `轮 ${s.rounds ?? 0}/${s.maxRounds ?? "?"}`,
    typeof s.best === "number" ? `best ${s.best}` : "",
    `更新 ${loopTime(s.updatedAt)}`,
  ].filter((p) => p !== "");
  return parts.join(" · ");
}
