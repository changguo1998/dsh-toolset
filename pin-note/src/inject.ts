/**
 * pin-note/src/inject.ts — 注入消息的构造与相等判断（纯函数，零 IO）。
 *
 * 消息形状照 `escalation-hint/src/index.ts` 的先例（自定义 `source.kind` 运行时可用）；
 * 相等判断照宿主 `agent-instructions` 的口径（content + source 深比较），用于「同一份内容不重复插入」。
 */

import { randomUUID } from "node:crypto";

import type { PinRecord } from "./store.ts";

/** 消息来源标记（自定义 kind，运行时按字符串透传）。 */
export const PIN_SOURCE_KIND = "pin-note";

/** 注入消息的宿主形态（`UserMessage` 的结构子集）。 */
export interface PinMessageLike {
  id: string;
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  source: { kind: string };
}

/** 一条记录在消息里的最大字符数（超长逐条截断，避免单条挤占整段上下文）。 */
export const MAX_NOTE_CHARS = 4000;

/** 渲染注入正文；零条返回 undefined。 */
export function renderText(records: readonly PinRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  const total = records.reduce((sum, record) => sum + record.content.length, 0);
  const lines = [
    `[pin-note] 跨压缩保持项（${records.length} 条, 共 ${total} 字；本会话内一直有效）：`,
  ];
  records.forEach((record, index) => {
    const label = record.title.length > 0 ? record.title : `第 ${index + 1} 条`;
    lines.push(`${index + 1}. ${label}`);
    const body =
      record.content.length > MAX_NOTE_CHARS
        ? `${record.content.slice(0, MAX_NOTE_CHARS)}…`
        : record.content;
    for (const line of body.split("\n")) lines.push(`   ${line}`);
  });
  return lines.join("\n");
}

/** 构造注入消息；零条返回 undefined。 */
export function pinMessage(
  records: readonly PinRecord[],
): PinMessageLike | undefined {
  const text = renderText(records);
  if (text === undefined) return undefined;
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: PIN_SOURCE_KIND },
  };
}

/** 是否本插件产的消息（按 `source.kind`）。 */
export function isPinMessage(value: unknown): boolean {
  const source = (value as { source?: { kind?: unknown } } | undefined)?.source;
  return source?.kind === PIN_SOURCE_KIND;
}

/** 两条消息的 payload 是否相同（content 与 source 逐字段深比较）。 */
export function samePinPayload(
  left: PinMessageLike,
  right: PinMessageLike,
): boolean {
  return payloadKey(left) === payloadKey(right);
}

/** payload 的稳定字符串形（`content` + `source`）。 */
function payloadKey(message: PinMessageLike): string {
  return JSON.stringify([message.content, message.source]);
}
