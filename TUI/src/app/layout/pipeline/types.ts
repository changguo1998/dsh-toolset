// src/app/layout/pipeline/types.ts — 六步流水线的类型骨架（第 1 / 2 步）
//
// 口径见 TUI/docs/implementation/2026-10-09-layout-segment-cache.md「设计」：
//   ① 接收（宿主事件 → 节缓存）② 结构（节 → box 序列，宽无关）
// 本文件只放「宽无关」的两级；第 3 步起（pane / row / 行数表）的吃宽度类型
// 待各批实现时补，避免先写出用不上的形状。
//
// 术语：**块** = 宿主的内容单元（turn / step / index 作用域）；**节** = 项目的划分。

import type { NoticeTone } from "../../adapter/types.ts";

/** 内容来源（节的条目类型标记；与状态层 BufferKind 的对应：reasoning → thinking） */
export type Source =
  "user" | "assistant" | "reasoning" | "tool" | "notice" | "shell";

/** 工具调用（参数按 delta 累计后的终值） */
export interface ToolCall {
  callId: string;
  name: string;
  args: string;
}

/** 工具结果（`callId` 缺失时只能按到达顺序配对） */
export interface ToolResult {
  callId?: string;
  ok: boolean;
  detail: string;
}

/** 节内条目：同类型归并后的结果（文本直拼；工具调用 / 结果成组） */
export interface Item {
  source: Source;
  /** 文本类条目（user / assistant / reasoning / notice / shell）的归并文本 */
  text?: string;
  /** 工具批：调用与结果各成组 */
  calls?: ToolCall[];
  results?: ToolResult[];
  tone?: NoticeTone;
}

/** 节：元数据（turn / step / 时间）+ 条目；`frozen` 由帧边界统一置位 */
export interface Section {
  turn: number;
  step: number;
  /** step 头显示用的时间戳（epoch ms；缺省不显示） */
  time?: number;
  items: Item[];
  frozen: boolean;
}

/**
 * 归一化「块交付」——第 1 步的输入。
 *
 * 两种来源同构：宿主持久线（结算）与实时线（增量）都归一到此，去重由接收层负责，
 * 故调用方不必自己判重（只按事件语义投递即可）。
 */
export type BlockDelivery =
  /** 用户输入：封闭当前节，自成节 */
  | {
      kind: "user";
      turn: number;
      step: number;
      text: string;
      queued?: "followup" | "steer";
    }
  /** notice（提示 / 自造输出）：行为同用户输入 */
  | { kind: "notice"; text: string; tone?: NoticeTone }
  /** 本地 shell 输出（`$` 模式）：与 notice 同族，独立成节 */
  | { kind: "shell"; text: string }
  /** step 开始：节边界（本身不开节——无内容不建节） */
  | { kind: "step-start"; turn: number; step: number; time?: number }
  /** 文本块增量或整块（`full` = 整块结算，接收层负责与已交付前缀对齐） */
  | {
      kind: "text";
      turn: number;
      step: number;
      index: number;
      source: "assistant" | "reasoning";
      text: string;
      full?: boolean;
    }
  /** 工具调用（`callId` 为配对键；`args` 为增量或整块） */
  | {
      kind: "tool-call";
      turn: number;
      step: number;
      callId: string;
      name: string;
      args: string;
    }
  /** 工具结果 */
  | {
      kind: "tool-result";
      turn: number;
      step: number;
      callId?: string;
      ok: boolean;
      detail: string;
    }
  /** 该 step 被打断（结果可能永不到齐 → 不再等批结果） */
  | { kind: "interrupted"; turn: number; step: number }
  /** 定型信号（宿主 `assistant/message`）：标记该 step 可冻结 */
  | { kind: "finalize"; turn: number; step: number };

/** 交付账键：块身份（session 由每会话一份接收状态隐含） */
export function blockKey(turn: number, step: number, index: number): string {
  return turn + ":" + step + ":" + index;
}

/** step 键：中断 / 定型标记用 */
export function stepKey(turn: number, step: number): string {
  return turn + ":" + step;
}
