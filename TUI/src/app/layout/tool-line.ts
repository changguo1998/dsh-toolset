// src/app/layout/tool-line.ts — 工具行展示纯函数
//
// 状态层（state.ts）用它构建工具调用/结果行的 buffer 文本（工具调用 ○ / 结果 ✓|✗ 前缀），
// 渲染层按 BufferKind="tool" + tone 着色。summary/detail 的启发式提取已由
// adapter（dsh.ts）在归一化时产出（tool/call → summary、tool/result → detail），
// 本文件只负责展示行组装，避免重复解析。零运行时依赖。

/** 工具调用行：<name> <summary>（summary 为空时省略；无前导图标前缀） */
export function toolCallLine(name: string, summary: string): string {
  return name + (summary ? " " + summary : "");
}

/** 工具结果行：成功 ✓ <detail> / 失败 ✗ <detail>（detail 为空给占位）。
 * meta 命中 {before, after} 字符串对时追加行级 diff 摘要 `(+N/-M)`，其他形状降级不显示。
 *  ponytail: 行集差近似（非 LCS）；展示级足够，编辑类工具精确 diff 由其消费者自算。 */
export function toolResultLine(
  ok: boolean,
  detail: string,
  meta?: unknown,
): string {
  const base = (ok ? "✓ " : "✗ ") + (detail || "(无结果)");
  const d = diffSummary(meta);
  return d ? `${base} ${d}` : base;
}

/** 行级 diff 摘要：before/after 行集差计 added/removed；非字符串对或零变化返回 undefined */
function diffSummary(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const { before, after } = meta as { before?: unknown; after?: unknown };
  if (typeof before !== "string" || typeof after !== "string") return undefined;
  const b = before.split("\n");
  const a = after.split("\n");
  const added = a.filter((l) => !b.includes(l)).length;
  const removed = b.filter((l) => !a.includes(l)).length;
  return added + removed === 0 ? undefined : `(+${added}/-${removed})`;
}

/** step 分组头：`step N`（B3，步内首条工具行前插入；N 取事件 step 字段） */
export function stepHeaderLine(step: number): string {
  return "step " + step;
}

/**
 * subagent 行：`@ <label> <os|ct>`（B4，append-only 不配对不折叠）。
 * label 由 adapter 归一化时保证非空（无 label 回落 provider）；mode 缩略 one-shot→os / continuable→ct。
 */
export function subagentLine(
  label: string,
  mode: "one-shot" | "continuable",
): string {
  return "@ " + label + " " + (mode === "one-shot" ? "os" : "ct");
}
/** 重试启动行（llm/retry-started）：`↻ 重试中 (N)`，低调灰行（与 retry toast 互补不重复） */
export function retryStartedLine(attempt: number): string {
  return "↻ 重试中 (" + attempt + ")";
}

/**
 * workflow 运行行：run-start `⚑ workflow: <name>`；agent-start `⤷ <label>`（缺 label 回落 #<detail>）；
 * agent-end `↩ #<detail>`（muted）。run-end 走 notice（不进本文件）。
 */
export function workflowLine(
  phase: "run-start" | "agent-start" | "agent-end",
  label: string,
  detail?: string,
): string {
  switch (phase) {
    case "run-start":
      return "⚑ workflow: " + (label || "(未命名)");
    case "agent-start":
      return "⤷ " + (label || "#" + (detail || "?"));
    case "agent-end":
      return (
        "↩ " +
        (detail && detail.trim() !== "" ? "#" + detail : label || "(成员)")
      );
  }
}

/** 命令执行行（command/run）：`/> <name>`，低调灰行 */
export function commandRunLine(name: string): string {
  return "/> " + name;
}

/** 命令失败行（command/done kind=error）：`✗ /<name>: <text>`（红） */
export function commandErrorLine(name: string, text: string): string {
  return "✗ /" + name + (text ? ": " + text : "");
}

/** code-dispatch 起始行：`⇥ <name> <summary>`（run_code 内子派发） */
export function codeDispatchLine(name: string, summary: string): string {
  return "⇥ " + name + (summary ? " " + summary : "");
}

/** hook 行：invoked `⌗ <point>`（muted）；result `✓|✗ <point> (<decision>)`（失败红） */
export function hookLine(
  phase: "invoked" | "result",
  point: string,
  decision?: string,
  ok = true,
): string {
  if (phase === "invoked") return "⌗ " + (point || "?");
  return (
    (ok ? "✓ " : "✗ ") +
    (point || "?") +
    (decision ? " (" + decision + ")" : "")
  );
}
