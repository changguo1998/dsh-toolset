// src/app/components/ScrollView.ts — 流式区滚屏渲染（纯函数）
//
// 从已换行的数组中切出视口窗口 [start, end)，每行生成 RenderLine，
// 不够高的部分以空行补齐，占满 scroll 区域。

import type { RenderLine } from "../../renderer/index.ts";

/**
 * @param wrapped 全部换行后的行数组
 * @param start 视口起始下标（含）
 * @param end 视口结束下标（不含）
 * @param width 列宽（此行参数供长行截断保护，当前 wrapping 已先行处理）
 */
export function renderScrollView(
  wrapped: string[],
  start: number,
  end: number,
  width: number,
): RenderLine[] {
  const out: RenderLine[] = [];
  for (let i = start; i < end; i++) {
    const text = wrapped[i] ?? "";
    // 截断异常超宽行，防止破坏终端布局
    out.push({ text: text.slice(0, Math.max(0, width)) });
  }
  return out;
}
