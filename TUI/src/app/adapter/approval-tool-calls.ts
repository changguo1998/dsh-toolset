// src/app/adapter/approval-tool-calls.ts — 审批链的 tool/call 参数短期登记表
//
// 3.3.3：tool/call 事件把宿主 callId → 审批草稿明细（工具名 / 摘要 / 命令全文）
// 登记进有容量上限的短期表；审批应答者按 req.callId 取回，裁定 / 超时 / abort
// 后立即删除，避免长会话堆积。纯数据登记，不依赖适配器闭包状态。

import type { ApprovalDetail } from "./normalize.ts";

/** 登记表容量上限（超出按插入顺序淘汰最旧条目） */
export const TOOL_CALL_CACHE_MAX = 64;

/** 由原始 arguments 抽审批草稿明细：command 字段取全文，非 JSON 原样，摘要兜底 */
export function approvalDetailOf(
  name: string,
  argsRaw: string,
  summary: string,
): ApprovalDetail {
  const detail: ApprovalDetail = { tool: name, summary };
  const raw = argsRaw.trim();
  if (raw === "") return detail;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj.command === "string" && obj.command.trim() !== "") {
      detail.command = obj.command;
    }
  } catch {
    detail.command = raw;
  }
  return detail;
}

/** tool/call 参数短期登记表（键 = 宿主 callId） */
export class ToolCallCache {
  private readonly byCallId = new Map<string, ApprovalDetail>();

  /** 登记一条；同一 callId 重放时移到队尾（LRU 近似） */
  remember(
    callId: unknown,
    name: string,
    argsRaw: string,
    summary: string,
  ): void {
    if (typeof callId !== "string" || callId === "") return;
    this.byCallId.delete(callId);
    this.byCallId.set(callId, approvalDetailOf(name, argsRaw, summary));
    while (this.byCallId.size > TOOL_CALL_CACHE_MAX) {
      const oldest = this.byCallId.keys().next().value;
      if (oldest === undefined) break;
      this.byCallId.delete(oldest);
    }
  }

  get(callId: string): ApprovalDetail | undefined {
    return this.byCallId.get(callId);
  }

  delete(callId: string): void {
    this.byCallId.delete(callId);
  }
}
