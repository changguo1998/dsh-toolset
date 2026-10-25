// src/app/layout/pipeline/routeTable.ts — §3 分流的规则表（纯数据，route 消费）
//
// 追踪文档 T24：来源 × 块类型 × pane × 可见性 × 间隔以**数据表**承载，禁止散落在
// `panes.push` / `noteActKind` / `absorbActivityBlank` 等处。本文件只放数据与从数据
// 推导的纯函数，不实现任何循环 / 扫描逻辑。

import type { ActivitySwitches } from "../../state.ts";
import type { BlockSource } from "./ir.ts";

/** 活动区类别（/verbose 显示档 + /collapse 压缩档共用）：think / tool / reply */
export type ActivityCategory = "think" | "tool" | "reply";

/** 一条分流规则：来源（结合终态）→ pane / 类别 / 恒显 / 间隔档 */
export interface RouteRule {
  /** 归哪个 pane：session（会话区）/ turn（回合区） */
  pane: "session" | "turn";
  /** 活动档位与压缩类别（仅 turn pane；恒显项缺省） */
  category?: ActivityCategory;
  /** 恒显：不参与 /verbose 过滤、不参与 /collapse 压缩（notice / shell / 头 / 概要） */
  constant?: boolean;
  /** 回合区「思考 ↔ 正文」间隔判定档（仅 think / reply 参与；工具 / 恒显不参与） */
  gapKind?: "think" | "reply";
}

// ---------------- 规则数据表 ----------------

const SESSION_RULE: RouteRule = { pane: "session" };
const TURN_THINK: RouteRule = {
  pane: "turn",
  category: "think",
  gapKind: "think",
};
const TURN_REPLY: RouteRule = {
  pane: "turn",
  category: "reply",
  gapKind: "reply",
};
const TURN_TOOL: RouteRule = { pane: "turn", category: "tool" };
const TURN_CONSTANT: RouteRule = { pane: "turn", constant: true };

/**
 * 来源 + 终态 → 规则。
 * 会话区 = user 块 + final / history 交互的正文与工具批（旧 `isDialogue` 口径；
 * 追踪文档「偏差 ②」：以本实现为准）。
 */
export function ruleFor(source: BlockSource, final: boolean): RouteRule {
  switch (source) {
    case "user":
      return SESSION_RULE;
    case "reasoning":
      return TURN_THINK;
    case "assistant":
      return final ? SESSION_RULE : TURN_REPLY;
    case "tool":
      return final ? SESSION_RULE : TURN_TOOL;
    case "notice":
    case "shell":
      return TURN_CONSTANT;
    default:
      return TURN_CONSTANT;
  }
}

/**
 * 回合区留白规则表：上一档 × 当前档 → 是否插 1 行空行。
 *   思考 ↔ 正文互切插 1 行（工具不插：工具批 / 工具辅助行会把上一档重置成 tool，
 *   「思考 → 工具 → 正文」不留白——与旧 `noteActKind` / `pairBlank` 同口径）；
 *   恒显项（notice / shell / 头）不参与判定。
 */
export const TURN_BLANK: Record<
  "think" | "reply",
  Partial<Record<"think" | "reply", boolean>>
> = {
  think: { reply: true },
  reply: { think: true },
};

/** 回合区留白判定：上一档与当前档是否该插空行 */
export function turnBlankBetween(
  last: "think" | "reply" | undefined,
  current: "think" | "reply" | undefined,
): boolean {
  if (last === undefined || current === undefined || last === current)
    return false;
  return TURN_BLANK[last]?.[current] === true;
}

/** 会话区留白：user 块之后接正文排 1 行（旧 `spaceUserAssistant`） */
export const SESSION_BLANK_AFTER_USER = true;

// ---------------- 类别开关 ----------------

/** 网关：turn pane 的类别在显示档下是否可见（恒显项恒可见） */
export function categoryVisible(
  category: ActivityCategory | undefined,
  constant: boolean | undefined,
  show: Partial<ActivitySwitches>,
): boolean {
  if (constant === true || category === undefined) return true;
  if (category === "think") return show.think !== false;
  if (category === "tool") return show.tool !== false;
  return show.reply !== false;
}
