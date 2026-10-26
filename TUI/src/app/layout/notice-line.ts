// TUI/src/app/layout/notice-line.ts — notice 行的呈现参数
//
// notice 行的 tone 着色与 `hanging` 悬挂缩进：活动区盒子与底部 notice 视图**共用**
// （BACKLOG 3.1.1）——两处口径必须一致，否则 `/help` 这类双列表格 notice 在底部会
// 丢缩进或丢色。`compact` 只影响活动区：紧凑模式把条目压成 1 行并取消 hanging，
// `noCompact` 行（/help）豁免、保持完整折行。
//
// 历史：本函数原在 `build-box.ts`（旧缓冲行渲染栈）。内容渲染迁到新流水线后，旧栈里
// 只剩这一处仍在生产使用，故独立成文件。

import type { ColorName } from "../../renderer/theme.ts";
import type { HistoryRow } from "../state.ts";
import { NOTICE_TONE_COLOR } from "./content-rules.ts";

export function noticeLinePresentation(
  line: HistoryRow,
  compact: boolean,
): { fg?: ColorName; hanging?: number } {
  const tone = line.tone;
  const keepFull = compact && line.noCompact === true;
  const hanging =
    (!compact || keepFull) && line.hanging !== undefined
      ? line.hanging
      : undefined;
  return {
    ...(tone !== undefined ? { fg: NOTICE_TONE_COLOR[tone] as ColorName } : {}),
    ...(hanging !== undefined ? { hanging } : {}),
  };
}
