// TUI/src/app/runtime/frame.ts — 帧与交付: 六步流水线缓存、排版出帧、滚动派生、合帧与提示写出
//
// 2026-11-04 拆分自 TUI/src/app/index.ts 的 App 类体: 方法体只做 this. -> ctx. 改写,
// 跨模块调用经 ctx.self, 公共状态在 ./context.ts.

import type { FrameRow, Size } from "../../renderer/index.ts";
import type { AppState, HistoryRow } from "../state.ts";
import { reduceState } from "../state.ts";
import type { NoticeTone } from "../adapter/types.ts";
import { formatNoticeLine } from "../notice-format.ts";
import { applyDelivery, createSections } from "../layout/pipeline/sections.ts";
import type { BlockDelivery } from "../layout/pipeline/types.ts";
import {
  deliveryOfLine,
  sectionsFromBuffer,
  stepOf,
} from "../layout/pipeline/replay.ts";
import { appendLocalLog } from "../adapter/local-log.ts";
import type { FrameScrollReport, FrameBuildOutput } from "../layout.ts";
import { buildFrame, WINDOW_GROW_STEP } from "../layout.ts";
import { createLineTable, positionAt } from "../layout/pipeline/rows.ts";
import { sectionGroupCount, sectionsOf } from "../layout/pipeline/frame.ts";
import type { PaneScrollMax } from "../scroll-helpers.ts";
import type { AppContext } from "./context.ts";

/** 审批倒计时重绘间隔（ms）：秒数每秒变 → 独立 1s 定时器（不靠状态行 ticker 节律） */
const APPROVAL_COUNTDOWN_TICK_MS = 1000;

export function createFramePart(ctx: AppContext) {
  /**
   * 六步流水线：把**已构造的历史行**重放成节缓存（恢复 / 会话切换路径）。
   *
   * 条目 7 选项 1：行由调用方本地构造（`surfaceToBuffer`）并直传，不再回读
   * `state.local` —— 生产路径不把缓冲内容当恢复入口（缓冲仅测试 / 嵌入用）。
   */
  function replaySectionsFromRows(rows: readonly HistoryRow[]): void {
    if (ctx.deps.pipelineSink === undefined) return;
    ctx.sections = sectionsFromBuffer(rows, { history: true });
    // 回合号基线：重放后取最大节回合（下一回合本地预测 +1 的基准）
    const scanned =
      ctx.sections.current === undefined
        ? ctx.sections.sections
        : [...ctx.sections.sections, ctx.sections.current];
    let lastTurn = 0;
    for (const section of scanned) {
      if (section.turn > lastTurn) lastTurn = section.turn;
    }
    ctx.pipelineLastTurn = lastTurn > 0 ? lastTurn : null;
    ctx.sectionsSessionId = ctx.state.activeSessionId;
    ctx.groupCount = null; // 重放（BACKLOG #24②）：与 sectionGroupCount 重新对齐
    const pipeline = ctx.sections;
    apply((s) => reduceState(s, { type: "pipeline-state", pipeline }));
  }

  /**
   * 六步流水线接收：块交付 → 节缓存 → 注入 state（会话切换即重建节缓存）。
   * 接收跟事件（去重不能延迟），处理与排版仍跟帧。
   */
  function ingestDelivery(delivery: BlockDelivery): void {
    // 符号归一（`/symbol-unify`）在**交付入口**统一做一次：生产的唯一渲染源是流水线，而交付里的
    // 文本来自适配器原文；只在事件分支里改缓冲文本到不了画面（BACKLOG「符号归一在真机不可见」）。
    if (delivery.kind === "text" && ctx.state.symbolUnify) {
      const symbols = ctx.self.symbols();
      if (symbols !== undefined) {
        const text = symbols.normalize(delivery.text).text;
        if (text !== delivery.text) delivery = { ...delivery, text };
      }
    }
    // P5（降级版，条目 16 段 C2 从 state 侧搬来）：宿主每个 step 末尾会补发「只有换行」的
    // 文本块（实测 190 个分片里 154 个是 "\n\n"），落进节会在思考/工具行后留下成片空行。
    // 判据：整段仅空白 **且** 末项来源与本分片不同（或尚无内容）→ 丢；同来源内部的空白
    // 分片保留（软换行/段落空行语义不变）。
    if (
      delivery.kind === "text" &&
      delivery.text.trim() === "" &&
      ctx.sections !== null
    ) {
      const items = [
        ...ctx.sections.sections,
        ...(ctx.sections.current === undefined ? [] : [ctx.sections.current]),
      ].flatMap((s) => s.items);
      const lastItem = items[items.length - 1];
      if (lastItem === undefined || lastItem.source !== delivery.source) return;
    }
    const sid = ctx.state.activeSessionId;
    if (
      ctx.sections === null ||
      (ctx.sectionsSessionId !== null && ctx.sectionsSessionId !== sid)
    ) {
      // 首次建立 or 会话切换（真实 sid 变化）→ 重建节缓存并归零回合号基线
      ctx.sections = createSections();
      ctx.groupCount = null; // 会话切换（BACKLOG #24②）：窗口基线随会话重建
      ctx.sectionsSessionId = sid;
      ctx.pipelineLastTurn = null;
    } else if (ctx.sectionsSessionId === null && sid !== null) {
      // 会话建立过渡（null → sid，启动早期事件带上了会话号）：保留既有缓存
      // （启动期内容同属该会话），只登记归属，不重建
      ctx.sectionsSessionId = sid;
    }
    ctx.sections = applyDelivery(ctx.sections, delivery);
    // 画线判据的事实：turn-start 之后无内容 = 分隔线还在末尾（下次回合不重复画）
    ctx.pipelineSepPending = delivery.kind === "turn-start";
    if (delivery.kind !== "turn-start") ctx.pipelineAnyContent = true;
    // 回合号基线只跟回合边界（beginTurn 预测 +1 的基准）；用户/通知等自带 turn 的
    // 交付不推进基线（启动注入按回合 1 归组后，首回合预测不得被推到 2）
    if (delivery.kind === "turn-start") ctx.pipelineLastTurn = delivery.turn;
    const pipeline = ctx.sections;
    apply((s) => reduceState(s, { type: "pipeline-state", pipeline }));
  }

  /** App 本地写入的双写交付（用户回显 / 注入 / 通知 / 本地 shell）：流水线关闭时空转 */
  function deliverLocal(delivery: BlockDelivery): void {
    if (ctx.sections === null) return;
    ingestDelivery(delivery);
  }

  /**
   * 事件驱动的本地写入补块交付（条目 7 批 A）：`reduceState` 写下的可见行（retry /
   * subagent / hook / feedback / 压缩提示 …）过去只进缓冲、不投块 → 流水线（唯一渲染
   * 来源）看不到（用户真机「回合区不显示警告」）。
   *
   * 复用重放的「行 → 交付」映射（`deliveryOfLine`），口径与恢复路径完全一致；scope 取
   * 接收层最近一次 (turn, step)。**step 头与分隔线**在这里按重放同款规则转成
   * `step-start` / `turn-start`（但 `step` / `compaction-prune` 事件由 adapter 侧直接
   * 投递，调用方跳过本方法以免重复）。
   */
  function deliverBufferTail(before: number): void {
    if (ctx.sections === null) return;
    const scope = ctx.sections.lastScope;
    // 块身份跨调用连续（BACKLOG #22②）：每次从 0 起会让两次调用带出的辅助行都拿 block 0
    // → 被并成「辅助甲辅助乙」。同一 (turn, step) 内累加，scope 变化才归零。
    const tailScope = scope.turn + ":" + scope.step;
    if (ctx.bufferTailScope !== tailScope) {
      ctx.bufferTailScope = tailScope;
      ctx.bufferTailIndex = 0;
    }
    let index = ctx.bufferTailIndex;
    for (const line of ctx.state.local.slice(before)) {
      const step =
        line.kind === "step" || line.kind === "tool"
          ? stepOf(line.text)
          : undefined;
      if (step !== undefined) {
        deliverLocal({
          kind: "step-start",
          turn: scope.turn,
          step,
          ...(line.time === undefined ? {} : { time: line.time }),
        });
        continue;
      }
      if (line.kind === "separator") {
        deliverLocal({
          kind: "turn-start",
          turn:
            typeof line.turn === "number" && line.turn > 0
              ? line.turn
              : scope.turn,
          ...(line.time === undefined ? {} : { time: line.time }),
        });
        continue;
      }
      const delivery = deliveryOfLine(line, scope, index);
      index += 1;
      if (delivery !== undefined)
        deliverLocal(
          // 事件驱动补块：reducer 直落 toast（compaction / retry / workflow 等）的
          // notice 行同样补统一前缀（`[hh:mm:ss 来源] 正文`）。幂等：已带前缀
          // （shortNotice / adapter 事件已格式化）或 /help 多行表格原样返回。
          delivery.kind === "notice"
            ? { ...delivery, text: formatNoticeLine(delivery.text, Date.now()) }
            : delivery,
        );
    }
    ctx.bufferTailIndex = index;
  }

  /** 空的滚动报表（scratch 试算用：与 `paneScrollMax` 同形，出帧后即被填满） */
  function scratchReport(): FrameScrollReport {
    return {
      dialogueMaxScroll: 0,
      activityMaxScroll: 0,
      dialogueTotal: 0,
      dialogueCounts: [],
      dialogueKeys: [],
      dialogueTopIdx: 0,
      dialogueViewportH: 0,
      dialogueUserRows: [],
    };
  }

  /** 试算「窗口 = windowGroups」时的可滚动上限（**不出帧、不写 state**；BACKLOG #24①） */
  function trialDialogueMaxScroll(windowGroups: number): number {
    const trial = { ...ctx.state, windowGroups };
    const scratch = scratchReport();
    buildFrame(trial, ctx.deps.renderer.getSize(), scratch);
    return scratch.dialogueMaxScroll;
  }

  /** 当前 state 的可滚动上限：出帧回填过就直接用，否则就地补算一次（同一帧口径） */
  function paneMaxes(): FrameScrollReport {
    if (ctx.paneScrollMaxState !== ctx.state) {
      buildFrame(ctx.state, ctx.deps.renderer.getSize(), ctx.paneScrollMax);
      ctx.paneScrollMaxState = ctx.state;
    }
    return ctx.paneScrollMax;
  }

  /**
   * 出帧后同步派生缓存（视口顶位置 + 距底偏移 + 渐进窗口）：帧已按段键解析后的位置渲染，
   * 故直接写 state（不经 apply，不触发重绘），与 paneScrollMax 的缓存语义一致。
   *
   * 两件事：① 段落收敛（位置键已消失 → 布局按距底偏移回落，这里把结果写回，保持
   * 「state 里记的就是画面上那一行」）；② 用户停在历史里时，尾部新增回合组会把窗口
   * 起点向前挤（窗口按「尾部 N 组」计）→ 按新增组数把窗口撑住，视口顶所在段不被挤出。
   */
  function syncDialoguePos(): void {
    const r = ctx.paneScrollMax;
    const st = ctx.state;
    const groups = sectionGroupCount(sectionsOf(st));
    const grew = groups - (ctx.groupCount ?? groups);
    ctx.groupCount = groups;
    const keepWindow =
      st.dialogueTop !== null && grew > 0
        ? Math.min(groups, st.windowGroups + grew)
        : st.windowGroups;
    if (st.dialogueTop === null) {
      // 贴底：位置就是「跟随最新」，只需收敛窗口
      let next = keepWindow;
      // 视口容量驱动（BACKLOG「交付窗口折叠改为视口容量驱动」）：**还有空位就不折叠**——
      // 内容没占满会话区（`dialogueMaxScroll === 0`）且仍有未物化的更早组时，继续按步长
      // 物化；一旦装不下（滑动上限 > 0）或已全量物化即停。每轮至少 +WINDOW_GROW_STEP 且
      // 上限 = 总组数，单调收敛，不会自激
      // `next < groups` 即「还有更早的组未物化」——与窗口层的 `dropped` 同源，不另设字段
      // **一次到位**（BACKLOG #24①）：用 scratch 报表**循环试算**（不出帧、不写 state），
      // 直到装不下（上限 > 0）或已全量物化；最后一次才写 state 并重绘一次
      // —— 此前一帧一步（300 组 × 1 行 + rows=60 要约 19 帧）
      let maxScroll = r.dialogueMaxScroll;
      while (maxScroll === 0 && next < groups) {
        next = Math.min(groups, next + WINDOW_GROW_STEP);
        maxScroll = trialDialogueMaxScroll(next);
      }
      if (st.windowGroups !== next) {
        ctx.state = { ...st, windowGroups: next };
        paint(); // 窗口变了：再出一帧（同 tick 合帧，不会叠加渲染）
      }
      return;
    }
    const offset = Math.max(0, r.dialogueMaxScroll - r.dialogueTopIdx);
    const resolved = positionAt(
      createLineTable(r.dialogueCounts),
      r.dialogueKeys,
      r.dialogueTopIdx,
    );
    if (
      st.scrollOffset === offset &&
      st.windowGroups === keepWindow &&
      st.dialogueTop.key === resolved.key &&
      st.dialogueTop.row === resolved.row
    )
      return;
    ctx.state = {
      ...st,
      dialogueTop: resolved,
      scrollOffset: offset,
      windowGroups: keepWindow,
    };
  }

  /**
   * 出帧后同步回合区滚动锚点：内容增长时按增量抬高 `activityScroll`，使视口顶停在
   * 同一绝对行。返回 `true` 表示 state 被调整过，调用方需按新 state 重排一帧。
   *
   * 与会话区不同：回合区没有段键，只有距底偏移（`activityScroll`），布局按
   * `activity.length - activityH - offset` 切片，内容追加会直接推高上限把视口带向最新。
   * 故用户上滚（offset > 0）时必须等量补偿；贴底（offset = 0）继续跟随最新。
   */
  function syncActivityPos(): boolean {
    const max = Math.max(0, ctx.paneScrollMax.activityMaxScroll);
    const prev = ctx.activityMax;
    ctx.activityMax = max;
    if (prev === null || max <= prev) return false;
    const offset = ctx.state.activityScroll;
    if (offset <= 0) return false;
    const next = Math.min(max, offset + (max - prev));
    if (next === offset) return false;
    ctx.state = { ...ctx.state, activityScroll: next };
    ctx.paneScrollMaxState = null;
    return true;
  }

  /**
   * 排版一帧并把滚动派生状态收敛到「画面上那一行」：先按当前 state 出帧回填
   * `paneScrollMax`，再同步会话区段键锚点与回合区距底偏移；后者调整了 state 时
   * 重排一次（仅「用户上滚 + 新内容增长」才会走到，正常跟随路径零额外排版）。
   */
  function layoutFrame(size: Size, out: FrameBuildOutput): FrameRow[] {
    let frame = buildFrame(ctx.state, size, ctx.paneScrollMax, out);
    ctx.paneScrollMaxState = ctx.state;
    syncDialoguePos();
    if (syncActivityPos()) {
      frame = buildFrame(ctx.state, size, ctx.paneScrollMax, out);
      ctx.paneScrollMaxState = ctx.state;
      syncDialoguePos();
    }
    return frame;
  }

  /**
   * 会话区按键滚动（`delta` 行：正 = 上滚看更早内容）。
   *
   * 顺序：**先扩窗、再按扩窗后的段表施加位移** —— 位置按段键表达，扩窗只在视口上方插段，
   * 画面不动；位移量因此始终等于 `delta`（撞窗口顶那次也只是多物化，不多滚）。
   */
  function scrollDialogueBy(delta: number): void {
    if (delta === 0) return;
    let r = paneMaxes();
    for (let guard = 0; delta > 0 && guard < 4; guard++) {
      if (ctx.state.windowGroups >= sectionGroupCount(sectionsOf(ctx.state)))
        break; // 更早回合已全部物化，没有可扩的窗口
      const margin = Math.max(1, Math.floor(r.dialogueViewportH / 2));
      const needMore = r.dialogueTopIdx - delta < 0;
      const nearTop = r.dialogueTopIdx <= margin;
      if (!needMore && !nearTop) break;
      const before = r.dialogueTotal;
      apply((s) =>
        reduceState(s, {
          type: "window-grow",
          groups: s.windowGroups + WINDOW_GROW_STEP,
        }),
      );
      r = paneMaxes();
      if (r.dialogueTotal <= before) break; // 没有更多内容可纳入
    }
    const target = Math.min(
      Math.max(0, r.dialogueTopIdx - delta),
      r.dialogueMaxScroll,
    );
    // 滚回底部 → 恢复跟随最新（窗口复位默认组数，释放增量物化）
    if (delta < 0 && target >= r.dialogueMaxScroll) {
      apply((s) => reduceState(s, { type: "scroll-to-bottom" }));
      return;
    }
    apply((s) =>
      reduceState(s, {
        type: "dialogue-scroll",
        top: positionAt(
          createLineTable(r.dialogueCounts),
          r.dialogueKeys,
          target,
        ),
        offset: Math.max(0, r.dialogueMaxScroll - target),
      }),
    );
  }

  /**
   * 回合区按键滚动（`delta` 行：正 = 上滚看更早内容）。位置按**节键 + 行偏移**表达
   * （与会话区同口径）：从当前视口顶行 `activityTopIdx` 加减 `delta` → clamp → 经
   * `positionAt` 换成活动段表键 + 行, 写入 `activityTop`。滚回底部 → 恢复跟随最新。
   * 内容按节键锚定, 上方插段 / 扩窗不动画面。
   */
  function scrollActivityBy(delta: number): void {
    if (delta === 0) return;
    const r = paneMaxes();
    const topIdx = r.activityTopIdx ?? 0;
    const max = Math.max(0, r.activityMaxScroll);
    const cur = Math.max(0, Math.min(topIdx, max));
    // 正 = 上滚（看更早）→ topIdx 减小（同 scrollDialogueBy: target = topIdx - delta）
    const target = Math.max(0, Math.min(cur - delta, max));
    if (target >= max) {
      apply((s) =>
        reduceState(s, {
          type: "activity-scroll",
          delta: 0,
          top: null,
          offset: 0,
        }),
      );
      return;
    }
    apply((s) =>
      reduceState(s, {
        type: "activity-scroll",
        delta: 0,
        top: positionAt(
          createLineTable(r.activityCounts ?? []),
          r.activityKeys ?? [],
          target,
        ),
        offset: max - target,
      }),
    );
  }

  /**
   * 回合区按「Step」跳转页（PgUp/PgDn 等级错开：会话区整 Turn、回合区整 Step）。
   * 从当前顶行所在段出发, 向 dir 找下一个 `turn:step` 前缀不同的段, 把视口钉到它首行。
   */
  function scrollActivityStep(dir: 1 | -1): void {
    const r = paneMaxes();
    const keys = r.activityKeys ?? [];
    const counts = r.activityCounts ?? [];
    if (keys.length === 0) return;
    const max = Math.max(0, r.activityMaxScroll);
    const table = createLineTable(counts);
    const cur = Math.max(0, Math.min(r.activityTopIdx ?? 0, max));
    // 当前所在段（按行号落段）
    let seg = keys.length - 1;
    for (let i = 0; i < keys.length; i++)
      if (cur < (table.prefix[i] ?? 0)) {
        seg = i - 1;
        break;
      }
    seg = Math.max(0, seg);
    const curPrefix = (keys[seg] ?? "").split(":").slice(0, 2).join(":");
    let target: number | undefined;
    if (dir === 1) {
      for (let i = seg - 1; i >= 0; i--)
        if ((keys[i] ?? "").split(":").slice(0, 2).join(":") !== curPrefix) {
          target = table.prefix[i] ?? 0;
          break;
        }
      if (target === undefined) target = 0; // 已在最旧 step → 顶部
    } else {
      for (let i = seg + 1; i < keys.length; i++)
        if ((keys[i] ?? "").split(":").slice(0, 2).join(":") !== curPrefix) {
          target = table.prefix[i] ?? 0;
          break;
        }
      if (target === undefined) {
        apply((s) =>
          reduceState(s, {
            type: "activity-scroll",
            delta: 0,
            top: null,
            offset: 0,
          }),
        );
        return; // PgDn 无下一个 step → 跟随最新
      }
    }
    if (target >= max) {
      apply((s) =>
        reduceState(s, {
          type: "activity-scroll",
          delta: 0,
          top: null,
          offset: 0,
        }),
      );
      return;
    }
    apply((s) =>
      reduceState(s, {
        type: "activity-scroll",
        delta: 0,
        top: positionAt(table, keys, target),
        offset: max - target,
      }),
    );
  }

  /** 回合区 Home：一次 → 顶部（首行）；已到顶再按 → 无操作（回合区不加载更旧） */
  function scrollActivityHome(): void {
    const r = paneMaxes();
    const max = Math.max(0, r.activityMaxScroll);
    const cur = r.activityTopIdx ?? 0;
    if (r.activityKeys === undefined || r.activityKeys.length === 0) return;
    if (cur <= 0) return; // 已到顶: 二次 Home 无操作
    apply((s) =>
      reduceState(s, {
        type: "activity-scroll",
        delta: 0,
        top: positionAt(
          createLineTable(r.activityCounts ?? []),
          r.activityKeys ?? [],
          0,
        ),
        offset: max,
      }),
    );
  }

  /** 按面板取可滚动上限（status 列不按行滚动，返回 undefined = 不设上限） */
  function paneScrollMaxOf(
    panel: AppState["focusedPanel"],
  ): PaneScrollMax | undefined {
    if (panel === "status") return undefined;
    const m = paneMaxes();
    return { dialogue: m.dialogueMaxScroll, activity: m.activityMaxScroll };
  }

  /**
   * 写一条短提示：缓冲 + 流水线双写，展示文本补统一前缀（`[hh:mm:ss 来源] 正文`，
   * 见 app/notice-format.ts）。多行提示（/help 双列表格）不走这里——前缀只加单行短提示。
   */
  function shortNotice(text: string, tone?: NoticeTone): void {
    const shown = formatNoticeLine(text, Date.now());
    apply((s) =>
      reduceState(s, {
        type: "notice",
        text: shown,
        ...(tone ? { tone } : {}),
      }),
    );
    // 双写：流水线通知节（scope 由接收层取 lastScope；启动早期 → 回合 1）
    deliverLocal({
      kind: "notice",
      text: shown,
      ...(tone === undefined ? {} : { tone }),
    });
  }

  /**
   * 追加一条命令通知并重绘（/model 结果/错误统一入口）。
   * 展示文本补统一前缀；旁路日志记原文（ts / kind 另行成列）。
   */
  function notice(text: string, tone?: NoticeTone): void {
    if (ctx.disposed) return;
    shortNotice(text, tone);
    // 旁路：notice 只给用户看（不进模型上下文）→ 落本地日志供模型侧工具按需读
    recordLocalLog("notice", text, {
      ...(tone === undefined ? {} : { tone }),
    });
    paint();
  }

  /**
   * 写一条本地输出旁路日志（fire-and-forget；未接线 / 关闭 / 空正文时静默丢弃）。
   * 会话归属取 `state.activeSessionId`（未持久化的新会话写不进去，属预期）。
   */
  function recordLocalLog(
    kind: "shell" | "notice",
    text: string,
    meta?: Record<string, unknown>,
  ): void {
    const opts = ctx.localLog;
    if (opts === undefined) return;
    appendLocalLog(
      ctx.state.activeSessionId ?? undefined,
      { ts: Date.now(), kind, text, ...(meta === undefined ? {} : { meta }) },
      opts,
    );
  }

  /** 强制整帧重绘（Ctrl+L）：绕过 delta，走 renderer.refresh */
  function refresh(): void {
    if (ctx.disposed) return;
    const size = ctx.deps.renderer.getSize();
    const out: FrameBuildOutput = {};
    const frame = layoutFrame(size, out);
    ctx.deps.renderer.refresh(frame, out.sections, out.focus);
  }

  /**
   * 标脏 + 同 tick 合帧：同一 tick 内多次调用只产生一次 renderer.render。
   *
   * 事件 burst（如 assistant/attempt 展开出的逐 delta 流式事件）与定时器
   * （状态行 ticker / 思考打字机 / 面板刷新）都走这里：标脏后排队一个 microtask，
   * 本 tick 内后续标脏复用同一次冲刷。microtask 仍在同一事件循环 tick 内执行，
   * 用户可见时序不变（按键回显、审批弹窗不会跨 tick 延迟）。
   * 需要「立即拿到帧」的路径（启动首帧、测试断言）用 paintNow()。
   */
  function paint(): void {
    if (ctx.disposed) return;
    ctx.paintDirty = true;
    if (ctx.paintScheduled) return;
    ctx.paintScheduled = true;
    queueMicrotask(() => flushPaint());
  }

  /**
   * 冲刷待绘制帧（microtask 与显式调用共用）。
   * 帧率上限（跨回合）：距上一帧不足 frameIntervalMs 时**不清脏**、改排一个「窗口末」
   * 定时器——窗口内所有跨宏任务的标脏被合并到该时点统一出一帧，把渲染压到目标频率
   * （真实接线 10Hz）。0=不限帧：与既有语义一致，microtask 即冲刷。
   * 无脏帧时不动；渲染期间再次标脏则排下一帧。
   */
  function flushPaint(): void {
    ctx.paintScheduled = false;
    if (ctx.disposed || !ctx.paintDirty) return;
    if (ctx.frameIntervalMs > 0) {
      const wait = ctx.lastFrameAt + ctx.frameIntervalMs - Date.now();
      if (wait > 0) {
        // 窗口内：保留脏标记，只挂一个定时器（重复 flush 不重复挂）
        if (ctx.frameTimer === null)
          ctx.frameTimer = setTimeout(() => {
            ctx.frameTimer = null;
            flushPaint();
          }, wait);
        return;
      }
    }
    ctx.paintDirty = false;
    renderFrame();
    ctx.lastFrameAt = Date.now();
    if (ctx.paintDirty && !ctx.paintScheduled) {
      ctx.paintScheduled = true;
      queueMicrotask(() => flushPaint());
    }
  }

  /** 同步出帧（丢弃待处理合帧与窗口定时器，立即渲染当前状态）；供启动首帧、测试与需立即出帧的路径 */
  function paintNow(): void {
    if (ctx.disposed) return;
    ctx.paintDirty = false;
    clearFrameTimer();
    renderFrame();
    ctx.lastFrameAt = Date.now();
  }

  /** 清除「窗口末出帧」定时器（paintNow 抢占 / dispose 时调用） */
  function clearFrameTimer(): void {
    if (ctx.frameTimer) {
      clearTimeout(ctx.frameTimer);
      ctx.frameTimer = null;
    }
  }

  /** 实际出帧：取当前终端尺寸 → 全量排版 → 渲染（区间 diff 与按段切分在渲染层） */
  function renderFrame(): void {
    const size = ctx.deps.renderer.getSize();
    // 出帧顺带回填两 pane 的可滚动上限与帧段表（零额外排版开销）
    const out: FrameBuildOutput = {};
    const frame = layoutFrame(size, out);
    // 帧前按需实测：本次排版登记了「呈现不确定」字符 → 先实测再出帧（探测字节写在原点，
    // 由随后的整帧重绘覆盖），见 probeThenRender；首帧不在此列（见 probingSuspended）
    if (ctx.self.probePendingWidths()) return; // 本帧由 probeThenRender 的整帧重绘产出（已按实测宽度排版）
    ctx.deps.renderer.render(frame, out.sections, out.focus);
  }

  function apply(fn: (s: AppState) => AppState): void {
    const prev = ctx.state;
    ctx.state = fn(prev);
    // 提及候选（异步）：输入 / 面板变化的唯一漏斗点——token 变了就重排一次查询，
    // 面板收起或切到命令候选则取消在途请求（覆盖按键路径与事件面路径）
    ctx.self.syncFileMentionRequest(prev);
    // 需交互面板关闭（提交 / 取消 / 超时）→ 停止催促响铃（BACKLOG 3.4.3）；
    // 统一在此判定，覆盖按键路径与事件面路径的全部关闭点
    if (
      (prev.approval !== null || prev.question !== null) &&
      ctx.state.approval === null &&
      ctx.state.question === null
    ) {
      ctx.self.clearInteractiveBell();
    }
    // 审批倒计时：任何状态变化后同步 1s 重绘定时器（唯一真源 = 有审批且有 deadline）
    syncApprovalTicker();
  }

  /**
   * 审批倒计时重绘（BACKLOG 3.2.5）：`deadline − now` 的秒数每秒都会变，但重绘不能
   * 依赖状态行 ticker 的节律（那个间隔可配、也会因别的需求调整）——有审批且有 deadline
   * 时单起一个 1s 定时器，到点重绘一帧；审批关闭 / 倒计时隐藏（面板内按过键，3.3.5）
   * 即停。判据只读 state，故在 `apply()` 里统一同步，覆盖按键与事件两条路径。
   */
  function syncApprovalTicker(): void {
    const want =
      ctx.state.approval !== null && ctx.state.approvalDeadline !== null;
    if (want === (ctx.approvalTimer !== null)) return;
    if (ctx.approvalTimer !== null) {
      clearInterval(ctx.approvalTimer);
      ctx.approvalTimer = null;
    }
    if (want) {
      ctx.approvalTimer = setInterval(
        () => paint(),
        APPROVAL_COUNTDOWN_TICK_MS,
      );
      ctx.approvalTimer.unref?.(); // 不阻止测试进程退出
    }
  }

  return {
    replaySectionsFromRows,
    ingestDelivery,
    deliverLocal,
    deliverBufferTail,
    scratchReport,
    trialDialogueMaxScroll,
    paneMaxes,
    syncDialoguePos,
    syncActivityPos,
    layoutFrame,
    scrollDialogueBy,
    scrollActivityBy,
    scrollActivityStep,
    scrollActivityHome,
    paneScrollMaxOf,
    shortNotice,
    notice,
    recordLocalLog,
    refresh,
    paint,
    flushPaint,
    paintNow,
    clearFrameTimer,
    renderFrame,
    apply,
    syncApprovalTicker,
  };
}
