// src/app/adapter/normalize.ts — DSH 纯归一化函数（自 dsh.ts 拆出，无副作用）
//
// 只依赖 ./types.ts 的纯类型；dsh.ts 内部调用并以具名重导保持原导出不变。

import { randomUUID } from "node:crypto";
import type {
  AgentDefaultModelLike,
  AgentStatus,
  ApprovalRequest,
  DshUserMessageLike,
  ModelSelection,
} from "./types.ts";

/** 从宿主选择读数（结构面防御：服务缺失/字段缺失均容错） */
export function readDefaultSelection(
  svc: AgentDefaultModelLike | undefined,
): ModelSelection | undefined {
  if (!svc || typeof svc.currentSelection !== "function") return undefined;
  const cur = svc.currentSelection();
  if (!cur?.provider || !cur.model) return undefined;
  return {
    provider: cur.provider,
    model: cur.model,
    ...(cur.reasoningEffort ? { reasoningEffort: cur.reasoningEffort } : {}),
  };
}

/**
 * 解析 slash 命令行首段命令名。与官方 client 共用同一语法：
 * 小写字母开头[a-z][a-z0-9_-]*，后跟空白或行尾。非法返回 null。
 */
export function parseSlashCommand(line: string): string | null {
  const m = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/.exec(line);
  return m ? m[1]! : null;
}

/** 从表面事件 content 块数组提取纯文本（v1 仅取 text 块；reasoning/tool-result 省略） */
export function extractTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b && b.type === "text" && typeof b.text === "string")
      parts.push(b.text);
  }
  return parts.join("\n");
}

/** notice 摘要上限（对齐宿主 CONTEXT_SUMMARY_MAX_CHARS，超出截断） */
const NOTICE_SUMMARY_MAX = 120;

/**
 * 注入消息的 notice 形态判定（BACKLOG TUI#17）：`source.form === "notice"` 时返回
 * **一行摘要**——`summary` 优先；缺失或空白时取正文首个非空行（截断 ≤120 字符）。
 * 非 notice 形态 / 无法判定 → undefined（调用方按普通消息处理）。
 */
export function noticeSummaryOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const msg = message as Record<string, unknown>;
  const source = msg["source"] as Record<string, unknown> | undefined;
  if (source?.["form"] !== "notice") return undefined;
  const summary =
    typeof source["summary"] === "string" ? source["summary"].trim() : "";
  if (summary !== "") return summary;
  const line = extractTextBlocks(msg["content"])
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return undefined;
  return line.length > NOTICE_SUMMARY_MAX
    ? line.slice(0, NOTICE_SUMMARY_MAX)
    : line;
}

/**
 * rule-engine 注入消息判定（BACKLOG TUI#49）：`source.kind === "rule-engine"` 时返回
 * 正文文本（用户块显示用，保留原样不截断）；非该来源 / 无可读正文 → undefined。
 * 与 `noticeSummaryOf` 独立：rule-engine 自 #49 起不再走 notice 形态。
 */
export function ruleInjectionTextOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const msg = message as Record<string, unknown>;
  const source = msg["source"] as Record<string, unknown> | undefined;
  if (source?.["kind"] !== "rule-engine") return undefined;
  const text = extractTextBlocks(msg["content"]).trim();
  return text === "" ? undefined : text;
}

/** 审批草稿明细（由 tool/call 参数抽取；3.3.3） */
export interface ApprovalDetail {
  /** 工具名（与 req.toolName 同源，供明细行核对） */
  tool: string;
  /** 命令全文（arguments.command；多行保留换行，便于审批者通读） */
  command?: string;
  /** 单行参数摘要（summarizeToolArguments 结果，命令缺失时兜底） */
  summary?: string;
}

/**
 * 从 DSH ApprovalRequest 构造 app 审批提示文案（3.3.3 起支持多行）：
 * 首行沿用「允许工具 X 执行?<reason>」；带明细时追加「命令：」段（命令全文另起一行）
 * 与「参数：」单行摘要。明细缺失（宿主未给 callId / 已过期）时退化为单行旧文案。
 */
export function buildApprovalPrompt(
  req: ApprovalRequest,
  detail?: ApprovalDetail,
): string {
  const reason = req.reason ? "：" + req.reason : "";
  const head = `允许工具 ${req.toolName} 执行?${reason}`;
  const lines: string[] = [];
  const command = detail?.command?.trim();
  if (command) lines.push("命令：", command);
  const summary = detail?.summary?.trim();
  if (summary && summary !== command) lines.push("参数：" + summary);
  if (lines.length === 0) return head;
  return [head, ...lines].join("\n");
}

/**
 * 构造结构型用户消息（真机字段同 createUserMessage 输出）。
 * 必须带唯一 id：DSH 持久化校验以消息 id 判定 identified（agent/inbox/spliced
 * 与 user/message 缺 id 会导致后续 resume 时 SessionPersistenceCorruptionError：
 * "session event at seq N lacks an identified message"）。
 */
export function buildUserMessage(text: string): DshUserMessageLike {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

/**
 * 本地兜底会话标题核心：空白折叠 + 截断到 ≤30 显示字符。
 * 空/空白输入返回 undefined（列表行占位（新会话）由渲染层补）。
 * 供列表行与 resume 切换后状态栏标题在无官方标题事件时兜底。
 */
export function localTitleFromText(
  text: string | undefined,
): string | undefined {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > 30 ? t.slice(0, 30) + "..." : t;
}

/** DSH 'running'|'idle' → app AgentStatus */
export function normalizeAgentStatus(s: string | undefined): AgentStatus {
  switch (s) {
    case "running":
      return "thinking";
    case "tool":
      return "tool";
    case "idle":
      return "idle";
    default:
      return "idle";
  }
}
