// src/app/components/ApprovalPrompt.ts — 审批弹窗渲染（纯函数）
//
// 以文本面板呈现审批请求：标题 + 说明（换行适配）+ 操作提示。
// 输出恰好 height 行。

import type { FrameRow } from "../../renderer/index.ts";
import type { ApprovalItem } from "../adapter/dsh.ts";
import type { Box } from "../layout/box.ts";
import { v, styled } from "../layout/box.ts";
import { seg } from "../layout/primitives.ts";

/**
 * 审批面板 Box 生成器（DESIGN.md §7 / SPEC.md §7）：输出整棵 activity
 * 内容树替换，由 fill 统一摊平。叶子用 styled/text 段序（不做 markdown
 * 解析，避免 `[y]` 等被误解析）；body 在 build 内按现状 avail=width-4
 * 预折行再逐行产叶子；Box 声明显式高度使 fill 补白到恰好 height 行。
 */
export function buildApprovalBox(
  approval: ApprovalItem,
  height: number,
  width: number,
): Box {
  const avail = Math.max(4, width - 4);
  const maxBody = Math.max(0, height - 2); // 去掉标题行和操作提示行后的可装行数

  const lines: string[] = [];
  for (const part of approval.prompt.split("\n")) {
    if (part === "") continue;
    lines.push(...wrapByWidth(part, avail));
  }
  const body = lines.slice(0, maxBody);
  // 标题行 + body 叶子（已预折行，wrap:false 保序；不足 maxBody 补空行，
  // 对齐现状 render 逐行产 `" " + (body[i] ?? "")`——body 区恒 maxBody 行）
  const title = styled([seg(" ⚠ 等待审批 ", { fg: "yellow" as const })]);
  const bodyLeaves = Array.from({ length: maxBody }, (_, i) =>
    styled([seg(` ${body[i] ?? ""}`)]),
  );
  // 末行：多色 styled 段（y=红 / n=绿）
  const hint = styled([
    seg(" "),
    seg("[y]批准", { fg: "red" as const }),
    seg(" · "),
    seg("[n]拒绝", { fg: "green" as const }),
    seg(" · [Esc]退出 "),
  ]);
  return v([title, ...bodyLeaves, hint], {
    height: { mode: "fixed", rows: height },
  });
}

export function renderApprovalPrompt(
  approval: ApprovalItem,
  height: number,
  width: number,
): FrameRow[] {
  const avail = Math.max(4, width - 4);
  const maxBody = Math.max(0, height - 2); // 去掉标题行和操作提示行后的可装行数（高度 <3 时可为 0）

  const lines: string[] = [];
  for (const seg of approval.prompt.split("\n")) {
    if (seg === "") continue;
    lines.push(...wrapByWidth(seg, avail));
  }
  const out: FrameRow[] = [];
  out.push({ segments: [{ text: " ⚠ 等待审批 ", style: { fg: "yellow" } }] }); // 等待审批标题：黄（warn/进行中）
  // 主体内容（可能截断）
  const body = lines.slice(0, maxBody);
  for (let i = 0; i < maxBody; i++)
    out.push({ segments: [{ text: ` ${body[i] ?? ""}` }] });
  out.push({
    // y=批准 红、n=拒绝 绿（用户指定；其它部分不着色）
    segments: [
      { text: " " },
      { text: "[y]批准", style: { fg: "red" } },
      { text: " · " },
      { text: "[n]拒绝", style: { fg: "green" } },
      { text: " · [Esc]退出 " },
    ],
  });
  return out;
}

/** 按列适配宽度做简单换行（与 layout.wrapLine 语义一致，避免循环依赖） */
function wrapByWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = chrW(ch);
    if (curW > 0 && curW + w > width) {
      rows.push(cur);
      cur = ch;
      curW = w;
    } else {
      cur += ch;
      curW += w;
    }
  }
  rows.push(cur);
  return rows;
}

function chrW(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x2fffd)
  ) {
    return 2;
  }
  return 1;
}
