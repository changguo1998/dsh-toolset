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

/** 从 DSH ApprovalRequest 构造 app 审批提示文案 */
export function buildApprovalPrompt(req: ApprovalRequest): string {
  const reason = req.reason ? "：" + req.reason : "";
  return `允许工具 ${req.toolName} 执行?${reason}`;
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
  return t.length > 30 ? t.slice(0, 30) + "…" : t;
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
