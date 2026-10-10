// src/app/layout/pipeline/types.ts — 六步流水线的类型骨架（第 1 / 2 步）
//
// 口径见 TUI/docs/archived/2026-10-09-layout-segment-cache.md「设计」：
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
  readonly callId: string;
  readonly name: string;
  readonly args: string;
}

/** 工具结果（`callId` 缺失时按到达顺序配对） */
export interface ToolResult {
  readonly callId?: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** 节内条目：同类型归并后的结果（文本直拼；工具调用 / 结果成组） */
export interface Item {
  readonly source: Source;
  /** 文本类条目（user / assistant / reasoning / notice / shell）的归并文本 */
  readonly text?: string;
  /** 工具批：调用与结果各成组 */
  readonly calls?: readonly ToolCall[];
  readonly results?: readonly ToolResult[];
  readonly tone?: NoticeTone;
  /** 该条目覆盖的宿主事件号（压缩剪枝的 `shadowedSeqs` 按交集打遮蔽标记用） */
  readonly seqs?: readonly number[];
  /**
   * 文本**块身份**（同节内的块序号，来自交付的 `index`）：流式续写（同块）才并成一条，
   * 跨块不并——否则「正文甲 → 工具调用 → 正文乙」会被粘成一条无分隔的长行
   * （BACKLOG「同一步内『工具调用前后的正文』被粘成一行」）
   */
  readonly block?: number;
  /**
   * 用户块终态（条目 7 批 B1）：`turn-end` 的原因落到该回合最后一个用户**条目**上 →
   * 行层直接写 `status`，符号渲染不再按 `seq` 回查 buffer；已有终态不覆盖
   */
  readonly userStatus?: "success" | "failure" | "aborted";
  /**
   * 交付时的**回合世代**（上一次 `turn-end` 之后为一代，见 `SectionsState.turnEnds`）：
   * `turn-end` 只允许标记本世代的用户条目——回合号匹配不可靠（用户块由 App 按本地
   * **预测**回合号交付，宿主的 `turn-end` 用它自己的号），而「往回合号之外回溯」又会把
   * 上一个以非终态原因（interrupted / max-tokens / blocked）收尾的用户块误标。
   */
  readonly generation?: number;
  /**
   * 被 steer 续接过的用户输入（`user-flag` 交付置位）：永久 `←` 符号，优先于终态与
   * 运行态（用户 2026-10-01 裁定）；同批 B1：符号渲染不再按 `seq` 回查 buffer
   */
  readonly steerContinued?: boolean;
  /**
   * notice 呈现参数（条目 7 选项 1）：本地写入的 notice 行自带的两项排版元数据，随交付
   * 带进节模型——`hanging` = 折行续行停靠列（/help 双列表格），`noCompact` = 紧凑模式
   * 豁免（/help 仍完整折行）。旧路径这两项长在缓冲行上，行不再是内容来源后必须随条目
   * 走，否则生产路径（内容单源 = 节缓存）丢悬挂缩进与紧凑豁免。
   */
  readonly hanging?: number;
  readonly noCompact?: boolean;
}

/** 节：元数据（turn / step / 时间）+ 条目；`frozen` 由帧边界统一置位 */
export interface Section {
  readonly turn: number;
  readonly step: number;
  /** step 头显示用的时间戳（epoch ms；缺省不显示） */
  readonly time?: number;
  readonly items: readonly Item[];
  readonly frozen: boolean;
  /** 回合最终总结（turn-end 时给该回合最后一个 assistant 节打标）→ 会话区归属判据 */
  readonly final?: boolean;
  /** **历史节**（恢复重放产出：整节都是历史）→ 该节的正文与工具批都归会话区，
   *  回合区只承载当前回合的活动（用户裁定：恢复的工具结果放会话区） */
  readonly history?: true;
  /** 独立自足节（用户输入 / notice / shell 各自成节）：不再接受迟到内容（回写会串节） */
  readonly standalone?: boolean;
  /** steer 插队送达的用户输入（与上一条输入之间留空行；旧口径由 `markSteerClaim` 加） */
  readonly steer?: boolean;
  /** P9 恢复会话的 step 概要行文本（会话区 `╌╌ <text> ` + 尾部 ╌ 铺满；无条目） */
  readonly stepSummary?: string;
}

/** 交付公共字段（`seq` = 宿主持久线事件号，接收层据此去重；实时线增量不带） */
interface Delivery {
  readonly seq?: number;
}

/**
 * 归一化「块交付」——第 1 步的输入。
 *
 * 两种来源同构：宿主持久线（结算）与实时线（增量）都归一到此，去重由接收层负责。
 * **增量只来自实时线**；结算线按块聚合成一次 `full`（见 `text` / `tool-call`）。
 */
export type BlockDelivery =
  /** 用户输入：封闭当前节，自成节 */
  | (Delivery & {
      kind: "user";
      turn: number;
      step: number;
      text: string;
      queued?: "followup" | "steer";
      /** 该输入之前留一个空行（恢复路径的 `spaceBefore`；steer 插队送达的可见效果） */
      spaceBefore?: boolean;
      /** 终态（恢复路径按缓冲行原样透传；实时线由 `turn-end` 的原因另发） */
      status?: "success" | "failure" | "aborted";
      /** 被 steer 续接（恢复路径按缓冲行原样透传）→ 永久 `←` */
      steerContinued?: boolean;
    })
  /** notice（提示 / 自造输出）：行为同用户输入（无 turn/step 时沿用最近一次归属） */
  | (Delivery & {
      kind: "notice";
      text: string;
      tone?: NoticeTone;
      /** 折行续行停靠列（/help 双列表格；缺省不悬挂） */
      hanging?: number;
      /** 紧凑模式（/collapse on）豁免：本行仍完整折行（/help 用） */
      noCompact?: boolean;
    })
  /** 本地 shell 输出（`$` 模式）：与 notice 同族，独立成节 */
  | (Delivery & { kind: "shell"; text: string })
  /** P9 恢复会话的 step 概要行（`╌╌ hh:mm:ss #N ╌╌ read ×2 …`；独立成节） */
  | (Delivery & {
      kind: "step-summary";
      turn: number;
      step: number;
      text: string;
    })
  /** step 开始：节边界（本身不开节——无内容不建节；同 (turn, step) 重复 / 迟到不切节） */
  | (Delivery & {
      kind: "step-start";
      turn: number;
      step: number;
      time?: number;
    })
  /**
   * 文本块。`index = -1` = step 级结算（宿主 `assistant/message` 的完整正文）。
   * `full` = 整块（结算线），缺省 = 增量（实时线）。
   */
  | (Delivery & {
      kind: "text";
      turn: number;
      step: number;
      index: number;
      /**
       * `assistant` / `reasoning` = 模型输出；`tool` = **本地辅助行**（subagent / hook /
       * command / 重试提示等，状态层按工具行落 buffer），与工具批同 pane 但无配对语义。
       */
      source: "assistant" | "reasoning" | "tool";
      text: string;
      /** 辅助行分级（notice 同族配色；`tool` 来源用） */
      tone?: import("../../adapter/types.ts").NoticeTone;
      full?: boolean;
    })
  /** 工具调用（`callId` 为配对键；`full` = 整块参数，缺省 = 增量分片） */
  | (Delivery & {
      kind: "tool-call";
      turn: number;
      step: number;
      callId: string;
      name: string;
      args: string;
      full?: boolean;
    })
  /** 工具结果（`callId` 缺省时按到达顺序消费本 step 第一个待配对调用） */
  | (Delivery & {
      kind: "tool-result";
      turn: number;
      step: number;
      callId?: string;
      ok: boolean;
      detail: string;
    })
  /** 该 step 被打断（结果可能永不到齐 → 不再等批结果） */
  | (Delivery & { kind: "interrupted"; turn: number; step: number })
  /** 定型信号（宿主 `assistant/message`）：标记该 step 可冻结 */
  | (Delivery & { kind: "finalize"; turn: number; step: number })
  /** 回合结束：封闭当前节 + 给该回合最后一个 assistant 节打「最终总结」标记 */
  | (Delivery & {
      kind: "turn-end";
      turn: number;
      step: number;
      reason?: string;
    })
  /** 用户块标记（批 B1）：steer 认领后给**上一条**用户输入置「被续接」→ 永久 `←` */
  | (Delivery & { kind: "user-flag"; steerContinued?: boolean })
  /** 压缩剪枝（`compaction/prune`）：被遮蔽的宿主事件号 → box 层按交集打灰 */
  | (Delivery & { kind: "shadow"; seqs: readonly number[] })
  /**
   * 回合开始（App 在回合首行内容前画分隔线时同步交付）：回合分隔线的绘制信号与时间真源。
   * `time` 缺省 = 时间未知（恢复路径：本地 `turn-begin` 刚落、宿主尚未回填）→ 该回合的线
   * 画成纯虚线，不写 `hh:mm:ss ⇆N`（旧路径 `turnHeaderLine(undefined, undefined)` 同款）。
   */
  | (Delivery & { kind: "turn-start"; turn: number; time?: number });

/** 交付账键：块身份（session 由每会话一份接收状态隐含） */
export function blockKey(turn: number, step: number, index: number): string {
  return turn + ":" + step + ":" + index;
}

/** step 键：中断 / 定型 / 待配对标记用 */
export function stepKey(turn: number, step: number): string {
  return turn + ":" + step;
}
