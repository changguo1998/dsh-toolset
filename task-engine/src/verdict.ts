// task-engine/src/verdict.ts — 裁决面：audit / entail 的提示词、信封 schema 与取值
//
// 裁决 run 只输出一个 JSON 对象（宿主 outputSchema 校验过的 structured 优先），
// 解析失败一律由调用方按各自口径降级（audit fail-closed / entail 跳过）。

import type { AuditRequest } from "./acceptance.ts";
import { truncateEvidence } from "./evidence.ts";
import type { ChildRunOutcome } from "./subagent.ts";
import type { Acceptance, ChildSpec } from "./types.ts";

/** 从裁决文本取 JSON 对象（先剥 ``` 围栏）；不可解析返回 undefined。 */
export function parseVerdictJson(
  text: string,
): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const direct = asJsonObject(body);
  if (direct !== undefined) return direct;
  // 回退：扫第一个平衡括号对象（容忍「说明 + 围栏 + JSON」/ 前后缀散文）
  const braceStart = body.indexOf("{");
  if (braceStart < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceStart; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return asJsonObject(body.slice(braceStart, i + 1));
    }
  }
  return undefined;
}

/** JSON 文本 → 对象（非对象 / 坏 JSON → undefined）。 */
function asJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 裁决信封 schema（交给宿主 `outputSchema` 校验；子会话经 `structured_output` 工具上报）：
 * `{ <kind>: boolean, feedback?: string, structured?: <声明 schema> }`。
 */
export function verdictEnvelope(
  kind: "pass" | "ok",
  schema?: unknown,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [kind]: { type: "boolean" },
      feedback: { type: "string" },
      ...(schema === undefined ? {} : { structured: schema }),
    },
    required: schema === undefined ? [kind] : [kind, "structured"],
  };
}

/** 裁决值：优先宿主校验过的 `structured`（避免自报假保证），否则回退文本解析。 */
export function readVerdictValue(
  out: ChildRunOutcome,
): Record<string, unknown> | undefined {
  if (!out.ok) return undefined;
  const structured = out.structured;
  if (
    structured !== null &&
    typeof structured === "object" &&
    !Array.isArray(structured)
  ) {
    return structured as Record<string, unknown>;
  }
  return parseVerdictJson(out.text);
}

/** audit run 提示词（§16.2）：只输出一个 JSON 对象。 */
export function auditPrompt(req: AuditRequest): string {
  const lines = [
    "你是独立验收裁决者。请只依据下面给出的产出判断该验收项是否通过，不要调用工具。",
    "",
    `验收项：${req.check}`,
    "",
    "被审产出：",
    req.result === undefined ? "（无产出文本）" : truncateEvidence(req.result),
  ];
  if (req.outputSchema !== undefined) {
    lines.push(
      "",
      "结构化裁决要求：在 JSON 中额外给出 `structured` 字段，其形状必须严格符合下面的 JSON Schema：",
      JSON.stringify(req.outputSchema),
    );
  }
  lines.push(
    "",
    '只输出一个 JSON 对象，形如 {"pass": true, "feedback": "理由"}（pass 为布尔值，feedback 为简洁理由' +
      (req.outputSchema === undefined ? "）" : '，另加 "structured"）'),
  );
  return lines.join("\n");
}

/** entail run 提示词（§17.2）：只输出一个 JSON 对象。 */
export function entailPrompt(
  parent: {
    id: string;
    title?: string;
    spec?: string;
    acceptance: Acceptance[];
  },
  children: ChildSpec[],
): string {
  const lines = [
    "你是拆解门禁的语义裁决者。请判断：若下面每个子任务的验收都通过，父任务的验收是否必然成立？",
    "只做逻辑判断，不要调用工具。",
    "",
    `父任务：${parent.title ?? parent.id}`,
    ...(parent.spec === undefined || parent.spec === ""
      ? []
      : [`父任务规格：${parent.spec}`]),
    "父任务验收：",
    ...parent.acceptance.map((a) => `- [${a.level}] ${a.check}`),
    "",
    "子任务：",
  ];
  for (const child of children) {
    lines.push(`- ${child.id}：${child.title}`);
    lines.push(`  规格：${child.spec}`);
    for (const a of child.acceptance)
      lines.push(`  验收 [${a.level}]：${a.check}`);
  }
  lines.push(
    "",
    '只输出一个 JSON 对象，形如 {"ok": true, "feedback": "理由"}（ok 为布尔值：true 表示蕴含成立）',
  );
  return lines.join("\n");
}
