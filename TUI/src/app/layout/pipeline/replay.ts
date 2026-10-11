// src/app/layout/pipeline/replay.ts — 会话恢复：已有行 → 节缓存
//
// 恢复（`--resume` / 历史折叠）时没有逐块事件可放，但有状态层已归一化的行。本模块按
// **历史行**（`HistoryRow`）把它们重放成节（与 `frame.ts` 的 `sectionGroupStarts` 恰好相反：
// 那边把节还原成行类型序列，这边把行还原成节），供新流水线在恢复后继续按节增量接收事件。
//
// 口径：
//   - `separator`（回合分隔线）→ 回合 +1；
//   - step 头（`kind = "step"` 或工具行里的 `hh:mm:ss ⇆N #M`）→ step 边界；
//   - `user` / `notice` / `shell` → 独立自足节；
//   - `thinking` → reasoning 条目；工具行 → 工具批（调用行按 `名字 摘要` 拆、结果行按
//     `✓/✗` 判定，配对交给接收层的到达顺序口径）；其余 → 正文条目；
//   - `final` 正文 → 定型信号 + 回合结束（该节即回合总结节 → 会话区归属）。
// 恢复不到的瞬态内容不造占位（reasoning 只在实时线，恢复后自然缺失）。

import type { HistoryRow } from "../../state.ts";
import { isToolCall } from "../content-rules.ts";
import {
  createSections,
  applyDelivery,
  type SectionsState,
} from "./sections.ts";
import type { BlockDelivery } from "./types.ts";

/** step 头文本（`hh:mm:ss ⇆N #M` 及其省略形 / 旧形制 `hh:mm:ss #N`）→ step 号；非 step 头返回 undefined。
 *  尾锚 `#M` 使回合号插在 `#` 前不影响回解（新旧文本都能解）。 */
export function stepOf(text: string): number | undefined {
  const match = /(?:^|\s)#(\d+)\s*$/.exec(text.trim());
  if (match === null) return undefined;
  const n = Number(match[1]);
  // step 0 = 占位（未声明），历史缓冲里可能有 `#0` 头 → 不算声明，避免 `#0` 假头（BACKLOG #21）
  return n > 0 ? n : undefined;
}

/** 工具结果行（`✓ …` / `✗ …`）→ 成功标志；非结果行返回 undefined */
function resultOf(text: string): boolean | undefined {
  if (text.startsWith("✓")) return true;
  if (text.startsWith("✗")) return false;
  return undefined;
}

interface Scope {
  turn: number;
  step: number;
}

/** 行 → 块交付（顺序投递；step 头与分隔线在调用方处理） */
export function deliveryOfLine(
  line: HistoryRow,
  scope: Scope,
  index: number,
): BlockDelivery | undefined {
  const text = line.text;
  switch (line.kind) {
    case "user":
      return {
        kind: "user",
        turn: scope.turn,
        step: scope.step,
        text,
        // 留白标记（steer 插队送达）：节带 steer → 第 3 步在该块之前插空行
        ...(line.spaceBefore === true ? { spaceBefore: true } : {}),
        // 终态与「被 steer 续接」标记按行原样透传（批 B1）：恢复的用户块符号不再回查 buffer
        ...(line.status === undefined ? {} : { status: line.status }),
        ...(line.steerContinued === true ? { steerContinued: true } : {}),
      };
    case "notice":
      return {
        kind: "notice",
        text,
        ...(line.tone === undefined ? {} : { tone: line.tone }),
      };
    case "shell":
      return { kind: "shell", text };
    case "thinking":
      return {
        kind: "text",
        turn: scope.turn,
        step: scope.step,
        index,
        source: "reasoning",
        text,
      };
    case "tool": {
      const ok = resultOf(text);
      if (ok !== undefined) {
        return {
          kind: "tool-result",
          turn: scope.turn,
          step: scope.step,
          ok,
          detail: text.replace(/^[✓✗]\s?/, ""),
        };
      }
      // 辅助行（无状态前缀：subagent / hook / command / 重试提示等）：按本地辅助行渲染，
      // 不再丢弃（旧路径把它们当工具行原样上屏）
      if (!isToolCall(text))
        return {
          kind: "text",
          turn: scope.turn,
          step: scope.step,
          index,
          source: "tool",
          text,
          ...(line.tone === undefined ? {} : { tone: line.tone }),
          full: true,
        };
      const [name, ...rest] = text.split(" ");
      return {
        kind: "tool-call",
        turn: scope.turn,
        step: scope.step,
        callId: "replay:" + scope.turn + ":" + scope.step + ":" + index,
        name: name ?? "",
        // 摘要按原始串存回：`summarizeToolArguments` 对非 JSON 原样返回 → 渲染回同一行
        args: rest.join(" "),
        full: true,
      };
    }
    default:
      return {
        kind: "text",
        turn: scope.turn,
        step: scope.step,
        index,
        source: "assistant",
        text,
        full: true,
      };
  }
}

/** 历史行 → 节缓存（恢复路径；顺序与行序一致） */
/**
 * 由 `state.local` 重放一份节缓存（**显式助手**，条目 16 段 C1：从 `sectionsOf` 的无 sink 回退
 * 搬出来给测试与嵌入用法显式调用）。
 *
 * 带**单槽 memo**（与搬运前逐字等价）：命中判据 = **逐行对象身份**相同（不是数组身份）——
 * 缓冲是就地改的，流式续写 / `final` 打标 / 回合号回填都会换掉行对象；只比数组身份会拿到
 * 过期节缓存。**不要**去掉 memo：节身份与合成序号按对象发号，每帧新建节对象会让发号漂移。
 */
let replayEntry:
  { lines: readonly HistoryRow[]; value: SectionsState } | undefined;

export function sectionsFromLocal(local: readonly HistoryRow[]): SectionsState {
  const hit = replayEntry;
  if (
    hit !== undefined &&
    hit.lines.length === local.length &&
    hit.lines.every((line, index) => line === local[index])
  )
    return hit.value;
  const value = sectionsFromBuffer(local);
  replayEntry = { lines: [...local], value };
  return value;
}

export function sectionsFromBuffer(
  lines: readonly HistoryRow[],
  opts?: { history?: boolean },
): SectionsState {
  let state = createSections();
  const scope: Scope = { turn: 1, step: 0 };
  const indexByScope = new Map<string, number>();
  // 定型 + 回合结束在**整块 final 结束时**补：final 块可能多行（正文 + 代码 + 表格），
  // 逐行补会把后续行挤进新节（会话区归属丢失）
  let pendingFinal: Scope | undefined;
  // 已定型的 scope：其后同 scope 的内容在真实会话里必带新的 (turn, step)（宿主给），
  // 重放没有该信息，故本地把 scope 前移一格——**不发 step-start**（不产生 step 头）。
  // 否则接收层的「迟到回写」会把内容并回已定型的总结节：文本被直拼成一行、非 final
  // 正文被错并进会话区（真机与基线都会看到「中间输出一段最终总结回复」这种粘行）。
  const closedScopes = new Set<string>();
  const freshScope = (): void => {
    if (closedScopes.has(scope.turn + ":" + scope.step)) scope.step += 1;
  };
  const flushFinal = (): void => {
    if (pendingFinal === undefined) return;
    const done = pendingFinal;
    pendingFinal = undefined;
    state = applyDelivery(state, {
      kind: "finalize",
      turn: done.turn,
      step: done.step,
    });
    state = applyDelivery(state, {
      kind: "turn-end",
      turn: done.turn,
      step: done.step,
    });
    closedScopes.add(done.turn + ":" + done.step);
  };
  // 文本类行按「同 kind 连续块」聚合后一次投递（块文本语义：节内直拼，须带换行）
  let run:
    | { kind: HistoryRow["kind"]; tone?: HistoryRow["tone"]; text: string[] }
    | undefined;
  const flushRun = (): void => {
    if (run === undefined) return;
    const block = run;
    run = undefined;
    freshScope();
    const key = scope.turn + ":" + scope.step;
    const index = indexByScope.get(key) ?? 0;
    indexByScope.set(key, index + 1);
    const delivery = deliveryOfLine(
      {
        text: block.text.join("\n"),
        kind: block.kind,
        ...(block.tone === undefined ? {} : { tone: block.tone }),
      },
      scope,
      index,
    );
    if (delivery !== undefined) state = applyDelivery(state, delivery);
  };
  const isTextKind = (kind: HistoryRow["kind"]): boolean =>
    kind === "assistant" || kind === "thinking" || kind === "plain";
  for (const line of lines) {
    if (
      !isTextKind(line.kind) ||
      !(line.kind === "assistant" && line.final === true)
    ) {
      // final 块与非文本行都要先冲刷文本 run（final 的定型在整块结束时补）
      if (
        !isTextKind(line.kind) ||
        run === undefined ||
        run.kind !== line.kind
      ) {
        flushRun();
      }
      if (!(line.kind === "assistant" && line.final === true)) flushFinal();
    }
    if (line.kind === "separator") {
      flushRun();
      // 回合号用分隔线行上的宿主真值（numberTurnSeparator 落盘 / 恢复路径保留）；
      // 缺号（极旧缓冲）才退回序数 +1。真值是续接后本地预测与宿主对齐的前提
      // 无回合号的分隔线（极旧缓冲）：已有内容 → 下一回合；尚无内容 → 本回合
      // （首回合的分隔线，若 +1 会被记成第 2 回合，帧层按 turnMeta 画首条线时找不到）
      const hasContent =
        state.current !== undefined || state.sections.length > 0;
      scope.turn =
        typeof line.turn === "number" && line.turn > 0
          ? line.turn
          : hasContent
            ? scope.turn + 1
            : scope.turn;
      // step **不重置**：分隔线之后的裸内容归属「最近一次声明的 step」——与实时线一致
      // （宿主按 step/start 声明 step，内容都带显式 step；重放缺该显式值时沿用最近声明，
      // 否则会落进未声明的 step 0，step 头被推迟到内容之后）
      // 分隔线行 = 回合边界：补交付 turn-start（turnMeta 时间源），与实时路径同构——
      // 帧层的回合分隔线以「该回合被 turn-begin 交付过」为准（见 panes 的 marker 规则）。
      // **时间按行透传**：行上没有时间（本地 `turn-begin` 刚落、宿主还没回填）就不补时间，
      // 该回合的线画成纯虚线（旧路径 `turnHeaderLine(undefined, undefined)` = 无标签）
      state = applyDelivery(state, {
        kind: "turn-start",
        turn: scope.turn,
        ...(line.time === undefined ? {} : { time: line.time }),
      });
      continue;
    }
    const header = line.kind === "step" ? stepOf(line.text) : undefined;
    // BACKLOG #21：历史缓冲里的 step 0 占位头（`╌╌ hh:mm:ss ⇆N #0 ╌╌…`）——既不是
    // 真正的 step 声明，也不是内容 → 直接丢弃，避免它作为普通行上屏
    if (line.kind === "tool" && /(?:^|\s)#0\s/.test(line.text)) continue;
    const toolHeader =
      line.kind === "tool" && stepOf(line.text) !== undefined
        ? stepOf(line.text)
        : undefined;
    if (header !== undefined || toolHeader !== undefined) {
      scope.step = header ?? toolHeader ?? scope.step + 1;
      state = applyDelivery(state, {
        kind: "step-start",
        turn: scope.turn,
        step: scope.step,
        ...(line.time === undefined ? {} : { time: line.time }),
      });
      continue;
    }
    if (line.kind === "step") {
      // P9：概要行（`22:31:05 #3 ╌╌ read ×2`）——`stepOf` 认不出（`#N` 不在行尾）
      state = applyDelivery(state, {
        kind: "step-summary",
        turn: scope.turn,
        step: scope.step,
        text: line.text,
      });
      continue;
    }
    if (isTextKind(line.kind)) {
      if (run !== undefined && run.kind === line.kind) {
        run.text.push(line.text);
      } else {
        flushRun();
        run = {
          kind: line.kind,
          ...(line.tone === undefined ? {} : { tone: line.tone }),
          text: [line.text],
        };
      }
      if (line.kind === "assistant" && line.final === true) {
        pendingFinal = { ...scope };
      }
      continue;
    }
    freshScope();
    const key = scope.turn + ":" + scope.step;
    const index = indexByScope.get(key) ?? 0;
    indexByScope.set(key, index + 1);
    const delivery = deliveryOfLine(line, scope, index);
    if (delivery !== undefined) {
      state = applyDelivery(state, delivery);
      // steer 续接标记（BACKLOG #23②）：与实时路径同形，补一条 `user-flag`
      if (line.steerContinued === true && delivery.kind === "user")
        state = applyDelivery(state, {
          kind: "user-flag",
          steerContinued: true,
        });
    }
    if (line.kind === "assistant" && line.final === true) {
      // 该节即回合总结节（会话区归属）：定型与回合结束在整块结束时补（见 flushFinal）
      pendingFinal = { ...scope };
    }
  }
  flushRun();
  flushFinal();
  // 恢复重放产出 = 历史：整节标 `history`（`isDialogue` 据此把正文与工具批都路由到会话区；
  // 实时新交付的节不带该标记 → 回合区）
  if (opts?.history === true) {
    const mark = <T extends { history?: true }>(section: T): T =>
      section.history === true ? section : { ...section, history: true };
    state = {
      ...state,
      sections: state.sections.map(mark),
      ...(state.current === undefined ? {} : { current: mark(state.current) }),
    };
  }
  return state;
}
