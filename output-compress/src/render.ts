/**
 * 摘要记录渲染：确定性 markdown（同一 SummaryJson + 元数据 → 同一文本）。
 * 不含时间戳等运行期变量；原始字节绝不内联，只留 spill locator 与切片索引。
 * （自 kb-write.ts 迁出——共库写入拆除后渲染是唯一的遗留职责。）
 */
import type { SummaryJson } from "./summary-program.ts";

export function renderSummaryRecord(params: {
  sessionId: string;
  seq: number | null;
  toolName: string | null;
  /** 完整输出的落盘位置；无 spill 通知时为 null（源即事件文本）。 */
  locator: string | null;
  retrievalHint: string;
  /** 完整输出的总字节数（通知的 omittedBytes 或事件文本字节数）。 */
  totalBytes: number;
  /** 实际参与派生的字节数（maxSourceBytes 截断后）。 */
  scannedBytes: number;
  truncated: boolean;
  summary: SummaryJson;
}): string {
  const {
    sessionId,
    seq,
    toolName,
    locator,
    retrievalHint,
    totalBytes,
    scannedBytes,
    truncated,
    summary,
  } = params;
  const lines: string[] = [];
  lines.push("# output-compress 摘要");
  lines.push("");
  lines.push(`- session: ${sessionId}`);
  lines.push(`- seq: ${seq ?? "unknown"}`);
  lines.push(`- tool: ${toolName ?? "unknown"}`);
  lines.push(
    locator !== null
      ? `- source: ${locator}`
      : "- source: inline-event-text（无 spill 通知，按阈值触发）",
  );
  if (retrievalHint.length > 0) lines.push(`- retrieval: ${retrievalHint}`);
  lines.push(`- totalBytes: ${totalBytes}`);
  lines.push(
    `- scannedBytes: ${scannedBytes}${truncated ? "（已按 maxSourceBytes 截断）" : ""}`,
  );
  lines.push(`- fingerprint(fnv1a32): ${summary.textFnv}`);
  lines.push(
    `- stats: lines=${summary.stats.lines} bytes=${summary.stats.bytes} ` +
      `maxLine=${summary.stats.maxLineLen} avgLine=${summary.stats.avgLineLen}`,
  );
  lines.push("");
  lines.push(`## sections (${summary.headings.length})`);
  if (summary.headings.length === 0) lines.push("（无 markdown 标题）");
  for (const h of summary.headings) {
    lines.push(`- L${h.line} [h${h.level}] ${h.text}`);
  }
  lines.push("");
  lines.push(`## key lines (${summary.keyLines.length})`);
  if (summary.keyLines.length === 0) lines.push("（无错误类关键行）");
  for (const k of summary.keyLines) {
    lines.push(`- L${k.line}: ${k.text}`);
  }
  lines.push("");
  lines.push(`## slices (${summary.slices.length})`);
  for (const s of summary.slices) {
    lines.push(
      `- #${String(s.index).padStart(2, "0")} L${s.startLine}-${s.endLine} ` +
        `C${s.startChar}-${s.endChar} fnv=${s.fnv} "${s.preview}"`,
    );
  }
  return lines.join("\n");
}
