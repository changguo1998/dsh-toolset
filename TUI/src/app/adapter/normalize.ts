// src/app/adapter/normalize.ts — DSH 纯归一化函数（自 dsh.ts 拆出，无副作用）
//
// 只依赖 ./types.ts 的纯类型；dsh.ts 内部调用并以具名重导保持原导出不变。

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

/** 构造结构型用户消息（真机字段同 createUserMessage 输出） */
export function buildUserMessage(text: string): DshUserMessageLike {
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
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
