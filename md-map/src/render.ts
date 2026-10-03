// src/render.ts — 工具面文本渲染（模型侧唯一可见面）：紧凑文本、行号 1 基、每类 80 行预算。

import type {
  MdBrockenLink,
  MdCaller,
  MdImpactLayer,
  MdMapIndex,
  MdMapReport,
} from "./types.ts";

/** 每类渲染的行上限。 */
export const RENDER_LIMIT = 80;

/** 截断收尾。 */
function cap(lines: string[]): string[] {
  if (lines.length <= RENDER_LIMIT) return lines;
  return [
    ...lines.slice(0, RENDER_LIMIT),
    `…（其余 ${lines.length - RENDER_LIMIT} 条略）`,
  ];
}

/** 索引 / 刷新结果。 */
export function renderIndex(index: MdMapIndex, action: string): string {
  const anchors = index.docs.reduce((sum, doc) => sum + doc.anchors.length, 0);
  return [
    `${action === "refresh" ? "已刷新" : "已索引"}：${index.docs.length} 个文档 / ${anchors} 个锚点 / ${index.edges} 条内部边 / ${index.broken.length} 条断链（${index.elapsedMs} ms${index.truncated ? "，已截断" : ""}）`,
    `root：${index.root}`,
  ].join("\n");
}

/** callers 结果（kinds 给出时标注过滤口径）。 */
export function renderCallers(
  target: string,
  callers: MdCaller[],
  anchor?: string,
  kinds?: readonly string[],
): string {
  const filter =
    kinds === undefined || kinds.length === 0
      ? ""
      : `（kind 过滤：${kinds.join("/")}）`;
  if (callers.length === 0) {
    return `(无引用：${target}${anchor === undefined ? "" : `#${anchor}`}${filter})`;
  }
  const head = `引用 ${target}${anchor === undefined ? "" : `#${anchor}`} 共 ${callers.length} 处${filter}：`;
  const lines = callers.map((caller) => {
    const at = caller.anchor === undefined ? "" : `#${caller.anchor}`;
    const text = caller.text === undefined ? "" : ` “${caller.text}”`;
    return `${caller.from}:${caller.line} → ${caller.kind}${at}${text}`;
  });
  return [head, ...cap(lines)].join("\n");
}

/** impact 结果（kinds 给出时标注过滤口径：逐层过滤，中间跳被过滤则后继消失）。 */
export function renderImpact(
  target: string,
  layers: MdImpactLayer[],
  kinds?: readonly string[],
): string {
  const filter =
    kinds === undefined || kinds.length === 0
      ? ""
      : `（kind 过滤：${kinds.join("/")}）`;
  if (layers.length === 0) return `(无上游引用：${target}${filter})`;
  const total = layers.reduce((sum, layer) => sum + layer.docs.length, 0);
  // 每层条目上限：避免单行过长（真实仓库实测一层可塞满上百个路径 → 单行 20KB+）
  const perLayer = 20;
  const lines = [`改动 ${target} 的上游影响（${total} 个文档）${filter}：`];
  for (const layer of layers) {
    const shown = layer.docs.slice(0, perLayer);
    const rest =
      layer.docs.length > shown.length
        ? ` …其余 ${layer.docs.length - shown.length} 个`
        : "";
    lines.push(
      `  L${layer.depth}（${layer.docs.length}）：${shown.join("、")}${rest}`,
    );
  }
  return cap(lines).join("\n");
}

/** orphans 结果（入参是零入边文档的路径清单）。 */
export function renderOrphans(paths: readonly string[]): string {
  if (paths.length === 0) return "(无孤儿文档)";
  return cap([`零入边文档 ${paths.length} 个：`, ...paths]).join("\n");
}

/** 断链清单。 */
export function renderBroken(broken: MdBrockenLink[]): string[] {
  if (broken.length === 0) return ["断链：无"];
  const lines = [`断链 ${broken.length} 条：`];
  for (const item of broken) {
    const reasonText =
      item.reason === "missing-file"
        ? "目标不存在"
        : item.reason === "missing-anchor"
          ? "锚点不存在"
          : "指向仓库外";
    lines.push(`${item.from}:${item.line} → ${item.target}（${reasonText}）`);
  }
  return cap(lines);
}

/** report 结果。 */
export function renderReport(reportData: MdMapReport): string {
  const head = [
    `文档地图报告（root：${reportData.root}，${reportData.elapsedMs} ms${reportData.truncated ? "，已截断" : ""}）`,
    `文档 ${reportData.docs} / 锚点 ${reportData.anchors} / 内部边 ${reportData.edges} / 文件引用 ${reportData.fileEdges} / 站外链接 ${reportData.externalEdges}`,
    `另有 ${reportData.refEdges ?? 0} 条行内代码路径引用（kind=ref，已计入内部边，不计断链）`,
    `未解析的行内代码路径 token：${reportData.refUnresolved ?? 0} 行（其中以 .md 结尾 ${reportData.refUnresolvedMd ?? 0}；仅计数、不进断链——文档改名 / 写错路径时升高）`,
  ];
  // 报告里只预览前若干个孤儿（真实仓库动辄上百个，整行输出会撑爆上下文）
  const orphanPreview = reportData.orphans.slice(0, 15);
  const orphanLines =
    reportData.orphans.length === 0
      ? ["孤儿文档：无"]
      : [
          `孤儿文档 ${reportData.orphans.length} 个（按路径字典序取前 ${orphanPreview.length} 个；入口文档已排除）：`,
          ...orphanPreview.map((path) => `  ${path}`),
          ...(reportData.orphans.length > orphanPreview.length
            ? [
                `  …其余 ${reportData.orphans.length - orphanPreview.length} 个（action=orphans 看全量）`,
              ]
            : []),
        ];
  const topLines =
    reportData.topBacklinks.length === 0
      ? ["被引最多：无"]
      : [
          "被引最多：",
          ...reportData.topBacklinks
            .slice(0, 10)
            .map((item) => `  ${item.path} ← ${item.backlinks} 处`),
        ];
  return [
    ...head,
    ...orphanLines,
    ...topLines,
    ...renderBroken(reportData.broken),
  ].join("\n");
}

/** summary 结果（未索引时给提示）。 */
export function renderSummary(
  value:
    | { ready: false }
    | {
        ready: true;
        root: string;
        docs: number;
        anchors: number;
        edges: number;
        /** 行内代码路径引用边数（与 report 对称；已计入 edges；旧值缺省按 0） */
        refEdges?: number;
        broken: number;
        truncated: boolean;
        builtAt: string;
      },
): string {
  if (value.ready !== true) return "未索引（先调用 md_map action=index）";
  return [
    `索引就绪：${value.docs} 个文档 / ${value.anchors} 个锚点 / ${value.edges} 条内部边 / ${value.broken} 条断链${value.truncated ? "（已截断）" : ""}`,
    `行内代码路径引用（kind=ref）：${value.refEdges ?? 0} 条（已计入内部边）`,
    `root：${value.root}（构建于 ${value.builtAt}）`,
  ].join("\n");
}
