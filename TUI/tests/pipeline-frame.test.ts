// tests/pipeline-frame.test.ts — 批 5 接管接缝：整帧逐行等价（新旧内容行来源）
//
// 同一语料两条路径：
//   旧：`state.local` → `dialogueWindow` + `buildContentRows`（生产路径）；
//   新：`state.pipeline`（节缓存）→ 节 → box → pane → 行（六步流水线，开关开启）。
// 断言 `buildFrame` 输出的**整帧逐行**一致（含标题栏 / 两 pane / 状态列 / 状态栏 / 输入区）。
//
// 覆盖：多 step、多回合（> 窗口组数，含顶部「更早回复已折叠」占位行）、代码块、表格、
// 工具批、思考、notice、窄宽（折行）与宽窗。

import { test } from "node:test";
import assert from "node:assert/strict";

// 条目 16 段 C1：`sectionsOf` 不再按 `state.local` 回退重放 → 旧路径口径（纯缓冲状态）
// 的出帧改用显式补节缓存的包装版（等价剥离前行为）
import { buildFrame } from "./helpers/frameWithLocalReplay.ts";
import { pipelineContent } from "../src/app/layout/pipeline/frame.ts";
import {
  clearNewRowCache,
  resetRowRenderStats,
  rowRenderMisses,
} from "../src/app/layout/pipeline/rows.ts";
import {
  applyAll,
  createSections,
} from "../src/app/layout/pipeline/sections.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";
import { sectionsFromBuffer } from "../src/app/layout/pipeline/replay.ts";
import {
  initialState,
  reduceState,
  type AppState,
  type HistoryRow,
} from "../src/app/state.ts";
import { stepHeaderLine } from "../src/app/layout/tool-line.ts";
import { rowText } from "./helpers/rowText.ts";

/** 语料：`turns` 个回合，每回合含思考 / 工具批 / 正文（末步带代码块与表格） */
function script(turns: number): BlockDelivery[] {
  const out: BlockDelivery[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const base = 1_700_000_000_000 + turn * 60_000;
    // 回合变化处交付 turn-start（与旧路径 `turn-begin` 往缓冲追加 separator 行同构：
    // 分隔线由它画，`oldBuffer` 也只在 turn ≥ 2 处生成 separator 行）
    if (turn > 1) out.push({ kind: "turn-start", turn, time: base });
    out.push({ kind: "user", turn, step: 1, text: `第 ${turn} 问：看下文档` });
    out.push({ kind: "step-start", turn, step: 1, time: base });
    out.push({
      kind: "text",
      turn,
      step: 1,
      index: 0,
      source: "reasoning",
      text: `（第 ${turn} 回合的思考）`,
    });
    out.push({
      kind: "tool-call",
      turn,
      step: 1,
      callId: `c${turn}`,
      name: "read",
      args: `{"path":"/tmp/${turn}.md"}`,
      full: true,
    });
    out.push({
      kind: "tool-result",
      turn,
      step: 1,
      callId: `c${turn}`,
      ok: true,
      detail: "ok",
    });
    if (turn === turns) {
      out.push({
        kind: "text",
        turn,
        step: 1,
        index: 0,
        source: "assistant",
        text: "要点：\n```ts\nconst a = 1;\n```\n| 名 | 值 |\n| --- | ---: |\n| a | 1 |",
      });
    } else {
      out.push({
        kind: "step-start",
        turn,
        step: 2,
        time: base + 10_000,
      });
      out.push({
        kind: "text",
        turn,
        step: 2,
        index: 0,
        source: "assistant",
        text: `第 ${turn} 问答复。`,
      });
    }
    out.push({ kind: "finalize", turn, step: turn === turns ? 1 : 2 });
    out.push({ kind: "turn-end", turn, step: turn === turns ? 1 : 2 });
  }
  return out;
}

/** 旧路径口径的缓冲行（与 state 的落行口径一致：物理行、step 头为工具行、final 打标） */
function oldBuffer(turns: number): HistoryRow[] {
  const lines: HistoryRow[] = [];
  const deliveries = script(turns);
  const finals = new Map<number, number>();
  deliveries.forEach((delivery, index) => {
    if (delivery.kind === "text" && delivery.source === "assistant") {
      finals.set(delivery.turn, index);
    }
  });
  const turnTime = new Map<number, number>();
  for (const delivery of deliveries) {
    if (delivery.kind === "step-start" && delivery.time !== undefined) {
      if (!turnTime.has(delivery.turn))
        turnTime.set(delivery.turn, delivery.time);
    }
  }
  let turn = 0;
  deliveries.forEach((delivery, index) => {
    const push = (line: HistoryRow): void => {
      lines.push(line);
    };
    switch (delivery.kind) {
      case "user":
        if (turn !== 0 && turn !== delivery.turn) {
          const time = turnTime.get(delivery.turn);
          push({
            text: "--------",
            kind: "separator",
            turn: delivery.turn,
            ...(time === undefined ? {} : { time }),
          });
        }
        turn = delivery.turn;
        push({ text: delivery.text, kind: "user" });
        break;
      case "step-start":
        turn = delivery.turn;
        push({
          text: stepHeaderLine(delivery.step, delivery.time, delivery.turn),
          kind: "tool",
          // 真实落行口径：step 头带事件时间（恢复重放要靠它补 step / 回合时间）
          ...(delivery.time === undefined ? {} : { time: delivery.time }),
        });
        break;
      case "text":
        for (const line of delivery.text.split("\n")) {
          push({
            text: line,
            kind: delivery.source === "reasoning" ? "thinking" : "assistant",
            ...(finals.get(delivery.turn) === index ? { final: true } : {}),
          });
        }
        break;
      case "tool-call":
        // 工具块改版（2026-10-13）：参数由 `toolParams(args)` 从 JSON **原序**取，
        // 故旧侧也要带原始参数（老口径的「name + 摘要」文本拿不到参数名，两侧必然不等价）
        push({
          text: `read {"path":"/tmp/${delivery.turn}.md"}`,
          kind: "tool",
        });
        break;
      case "tool-result":
        push({ text: "✓ ok", kind: "tool" });
        break;
      default:
        break;
    }
  });
  return lines;
}

function states(turns: number): { oldState: AppState; newState: AppState } {
  const base = initialState();
  const buffer = oldBuffer(turns);
  return {
    oldState: { ...base, local: buffer },
    newState: {
      ...base,
      local: [],
      pipeline: applyAll(createSections(), script(turns)),
    },
  };
}

for (const turns of [2, 5]) {
  for (const size of [
    { rows: 30, cols: 100 },
    { rows: 40, cols: 120 },
    { rows: 24, cols: 60 },
  ]) {
    test(`整帧等价（${turns} 回合 · ${size.cols}x${size.rows}）：新旧内容行来源逐行一致`, () => {
      const { oldState, newState } = states(turns);
      const oldRows = buildFrame(oldState, size).map(rowText);
      const newRows = buildFrame(newState, size).map(rowText);
      assert.deepEqual(newRows, oldRows);
    });
  }
}

test("c5 扩窗只排版新增段：已渲染的节命中行缓存（查表不重排）", () => {
  const { newState } = states(5);
  const pipeline = newState.pipeline;
  assert.ok(pipeline, "注入节缓存");
  // 独立会话边界：清空摊平缓存（真实单会话语义）, 避免跨测试模块级缓存残留
  clearNewRowCache();
  resetRowRenderStats();
  const first = pipelineContent(pipeline, {
    dialogueTextW: 80,
    activityTextW: 80,
    windowGroups: 3,
    render: { width: 80 },
  });
  const initial = rowRenderMisses();
  assert.ok(initial > 0, "首帧排一次");

  // 同窗口重复出帧：全部命中（滚动 / 重绘不重排）
  resetRowRenderStats();
  pipelineContent(pipeline, {
    dialogueTextW: 80,
    activityTextW: 80,
    windowGroups: 3,
    render: { width: 80 },
  });
  assert.equal(rowRenderMisses(), 0, "同窗重复出帧零重排");

  // 扩窗（3 → 6 组）：只排新纳入的更早段，已排过的内容不重排
  resetRowRenderStats();
  const wider = pipelineContent(pipeline, {
    dialogueTextW: 80,
    activityTextW: 80,
    windowGroups: 6,
    render: { width: 80 },
  });
  const grown = rowRenderMisses();
  assert.ok(grown > 0, "扩窗纳入的新段要排一次");
  // 扩窗后同样宽再出一帧：全部命中（新纳入的也已入缓存）——缓存幂等 = 不重排已缓存内容。
  // （旧的 `grown <= initial` 是数据相关启发: 增宽 2 组的项数可多于首窗 3 组, 正确缓存下
  //   并不恒成立, 故以「同窗重复出帧零重排」这一稳健断言代替。）
  resetRowRenderStats();
  pipelineContent(pipeline, {
    dialogueTextW: 80,
    activityTextW: 80,
    windowGroups: 6,
    render: { width: 80 },
  });
  assert.equal(rowRenderMisses(), 0, "扩窗后同样宽重复出帧零重排");
  assert.ok(
    wider.dialogue.length >= first.dialogue.length,
    "扩窗后内容不少于原窗口",
  );
});

test("恢复重放：缓冲行 → 节缓存，整帧与原缓冲逐行一致", () => {
  const { oldState } = states(3);
  const replayed = sectionsFromBuffer(oldState.local);
  const newState: AppState = {
    ...initialState(),
    local: [],
    pipeline: replayed,
  };
  for (const size of [
    { rows: 30, cols: 100 },
    { rows: 40, cols: 120 },
  ]) {
    assert.deepEqual(
      buildFrame(newState, size).map(rowText),
      buildFrame(oldState, size).map(rowText),
      `${size.cols}x${size.rows}`,
    );
  }
});

test("同源合并的前导 / 拖尾空行不产出可见行（交付驱动，回合区与会话区）", () => {
  // 宿主每步补发的 "\n\n" 与相邻同源文本合并（sections.ts 按 source 合并）→ box 文本带
  // 边缘空行；旧渲染器 absorbActivityBlank 会吸收，新流水线须同口径（BACKLOG 条目）。
  const base: BlockDelivery[] = [
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "正文一",
    },
  ];
  const merged: BlockDelivery[] = [
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "正文一",
    },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "\n\n",
    },
  ];
  const rows = (deliveries: BlockDelivery[]): string[] => {
    const content = pipelineContent(applyAll(createSections(), deliveries), {
      dialogueTextW: 80,
      activityTextW: 80,
      windowGroups: 3,
      render: { width: 80 },
    });
    return [
      ...content.activity.map((row) =>
        row.segments.map((s) => s.text).join(""),
      ),
      "|",
      ...content.dialogue.map((row) =>
        row.segments.map((s) => s.text).join(""),
      ),
    ];
  };
  assert.deepEqual(
    rows(merged),
    rows(base),
    "边缘空行不应改变回合区 / 会话区行",
  );
});

test("边界空行不带竖线：留白空行恒为裸空行（会话区与回合区）", () => {
  // 条目「取消 pane 边界留白空行的竖线」：pane 边界空行（会话区「用户块 → 正文」/ 回合区
  // 「思考 ↔ 正文」/ steer 留白）曾按「两侧都有竖线 → 取下一行前导竖线」补段（2026-10-10
  // 裁定），现改为**恒裸空行**——留白行不再像正文块向下延伸。
  const T = 1_700_000_000_000;
  const content = (deliveries: BlockDelivery[]) =>
    pipelineContent(applyAll(createSections(), deliveries), {
      dialogueTextW: 60,
      activityTextW: 60,
      windowGroups: 3,
      render: { width: 60 },
    });
  const texts = (rows: readonly { segments: readonly { text: string }[] }[]) =>
    rows.map((row) => row.segments.map((segment) => segment.text).join(""));

  // ① 会话区「用户块 → 正文」：留白空行恒裸空行（不取下一行的前导竖线段）
  const finalTurn: BlockDelivery[] = [
    { kind: "turn-start", turn: 1, time: T },
    { kind: "user", turn: 1, step: 1, text: "第一问" },
    { kind: "step-start", turn: 1, step: 1, time: T },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "答复",
    },
    { kind: "finalize", turn: 1, step: 1 },
    { kind: "turn-end", turn: 1, step: 1, reason: "completed" },
  ];
  const dialogue = content(finalTurn).dialogue;
  const userAt = dialogue.findIndex((row) => row.kind === "user");
  const blank = dialogue[userAt + 1];
  const reply = dialogue[userAt + 2];
  assert.ok(userAt >= 0 && blank !== undefined && reply !== undefined);
  assert.equal(
    texts(dialogue)[userAt + 1],
    "",
    "会话区边界空行不带竖线（裸空行）",
  );
  assert.equal(
    texts(dialogue)[userAt]!.endsWith("┃"),
    true,
    "上一行（用户块末行）本身有竖线，但不传导到空行",
  );
  assert.equal(
    texts(dialogue)[userAt + 2]!.startsWith("┃"),
    true,
    "下一行（正文首行）仍是带前导竖线的正文行",
  );
  assert.deepEqual(
    blank.segments,
    [],
    "边界空行不带任何段（无 prefix / suffix；reply 与它不同形）",
  );

  // ② 回合区「思考 ↔ 正文」：同上（正文非 final 才留回合区）
  const midTurn: BlockDelivery[] = [
    { kind: "step-start", turn: 1, step: 1, time: T },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "reasoning",
      text: "（先想）",
    },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "中间正文",
    },
  ];
  const activity = content(midTurn).activity;
  // 正文行后不足整宽的部分补空格留白（右缘留空），空行本身不带任何段
  assert.deepEqual(
    texts(activity).map((text) =>
      text.replace(/^╌+.*╌+$/, "<step>").replace(/\s+$/, ""),
    ),
    ["<step>", "┃（先想）", "", "┃中间正文"],
    "回合区边界空行不带竖线（裸空行）",
  );
  assert.deepEqual(activity[2]!.segments, []);
  // ③ 一侧是 step 头（无竖线）：仍为裸空行（不误挂）
  const twoSteps: BlockDelivery[] = [
    { kind: "step-start", turn: 1, step: 1, time: T },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "reasoning",
      text: "（先想）",
    },
    { kind: "step-start", turn: 1, step: 2, time: T + 1000 },
    {
      kind: "text",
      turn: 1,
      step: 2,
      index: 0,
      source: "assistant",
      text: "正文",
    },
  ];
  const stepped = content(twoSteps).activity;
  const bodyAt = stepped.findIndex((row) =>
    row.segments.some((segment) => segment.text.includes("正文")),
  );
  assert.equal(bodyAt > 0, true);
  assert.deepEqual(
    stepped[bodyAt - 1]!.segments,
    [],
    "上一行是 step 头（无竖线）→ 空行保持裸空行",
  );

  // ④ 两侧竖线都在行尾（steer 留白两侧都是用户块右缘竖线）：仍为裸空行
  const steered: BlockDelivery[] = [
    { kind: "user", turn: 1, step: 1, text: "第一问" },
    { kind: "user", turn: 1, step: 1, text: "插队", queued: "steer" },
  ];
  const steeredRows = content(steered).dialogue;
  const steerAt = steeredRows.findIndex((row) =>
    row.segments.some((segment) => segment.text.includes("插队")),
  );
  assert.equal(steerAt > 0, true);
  assert.deepEqual(
    steeredRows[steerAt - 1]!.segments,
    [],
    "下一行竖线在行尾 → 空行保持裸空行",
  );
});

test("会话区内容不足时贴底：短内容空白留在上方，超视口行为不变（帧断言）", () => {
  // 条目「会话区内容不足时贴顶」：会话区此前贴顶（内容在第 1 行、空白在下方），
  // 回合区早已贴底——两区口径统一为「底部对齐」；本用例只钉放置，不改视口 / 滚动模型。
  const T = 1_700_000_000_000;
  const short: BlockDelivery[] = [
    { kind: "turn-start", turn: 1, time: T },
    { kind: "user", turn: 1, step: 1, text: "问题" },
    { kind: "step-start", turn: 1, step: 1, time: T },
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "答案",
    },
    { kind: "finalize", turn: 1, step: 1 },
    { kind: "turn-end", turn: 1, step: 1, reason: "completed" },
  ];
  const frame = (
    deliveries: BlockDelivery[],
    size: { rows: number; cols: number },
  ): string[] =>
    buildFrame(
      {
        ...initialState(),
        local: [],
        pipeline: applyAll(createSections(), deliveries),
      },
      size,
    ).map(rowText);
  /** 剥掉 pane 边框与状态列骨架后是否为空行 */
  const isBlank = (text: string): boolean => text.replace(/[│\s]/g, "") === "";

  // 短内容 + 高终端：内容贴 pane 底边（最后一行内容紧邻 Turn 分隔行），其上方全空
  const rows = frame(short, { cols: 60, rows: 30 });
  const sessionAt = rows.findIndex((text) => text.includes("Session"));
  const turnAt = rows.findIndex((text) => text.includes("Turn"));
  const userAt = rows.findIndex((text) => text.includes("问题"));
  const answerAt = rows.findIndex((text) => text.includes("答案"));
  assert.ok(
    sessionAt >= 0 &&
      turnAt > sessionAt &&
      userAt > sessionAt &&
      answerAt > userAt,
  );
  const pane = rows.slice(sessionAt + 1, turnAt);
  const firstContent = pane.findIndex((text) => !isBlank(text));
  assert.ok(firstContent >= 0, "会话区应有内容（回合分隔线 / 用户块 / 正文）");
  assert.equal(
    pane.slice(0, firstContent).every(isBlank),
    true,
    `内容上方应为空白：${JSON.stringify(pane.slice(0, firstContent))}`,
  );
  assert.equal(
    isBlank(pane[pane.length - 1] ?? ""),
    false,
    `会话区最后一行应为内容（贴 pane 底边）：${JSON.stringify(pane[pane.length - 1])}`,
  );
  assert.equal(answerAt, turnAt - 1, "正文是 pane 的最后一行");

  // 不变量扫描（含「内容恰等于视口高」的边界）：补白行数恒 = max(0, 视口高 − 内容行数)，
  // 内容 ≥ 视口时补白为 0——放置与视口模型不脱钩
  for (let turns = 1; turns <= 6; turns++) {
    const sweep = { cols: 60, rows: 30 };
    const report = {
      dialogueMaxScroll: 0,
      activityMaxScroll: 0,
      dialogueTotal: 0,
      dialogueCounts: [],
      dialogueKeys: [],
      dialogueTopIdx: 0,
      dialogueViewportH: 0,
      dialogueUserRows: [],
    };
    buildFrame(
      {
        ...initialState(),
        local: [],
        pipeline: applyAll(createSections(), script(turns)),
      },
      sweep,
      report,
    );
    const rowsN = frame(script(turns), sweep);
    const top = rowsN.findIndex((text) => text.includes("Session")) + 1;
    const bottom = rowsN.findIndex((text) => text.includes("Turn"));
    const pane = rowsN.slice(top, bottom);
    const firstContent = pane.findIndex((text) => !isBlank(text));
    assert.equal(
      firstContent,
      Math.max(0, report.dialogueViewportH - report.dialogueTotal),
      `${turns} 回合：补白行数 = max(0, 视口高 − 内容行数)`,
    );
  }

  // 内容超视口：不补白（标题行之后第一行就是内容），放置口径与改动前一致
  const long = frame(script(5), { cols: 60, rows: 24 });
  const longSession = long.findIndex((text) => text.includes("Session"));
  const longTurn = long.findIndex((text) => text.includes("Turn"));
  assert.ok(longSession >= 0 && longTurn > longSession);
  assert.equal(
    isBlank(long[longSession + 1] ?? ""),
    false,
    `超视口时首行应为内容：${JSON.stringify(long[longSession + 1])}`,
  );
});

test("用户块终态符号：宿主回合号漂移时同一帧即显 `✓`（帧断言）", () => {
  // BACKLOG「用户块终态符号始终是 `?`」：用户块按本地预测回合号交付、turn-end 带宿主号，
  // 两者不同步时旧实现恒 `?`；终态改按回合世代落后，漂移也要在同帧出 `✓`。
  const rows = (deliveries: BlockDelivery[]): string[] =>
    buildFrame(
      {
        ...initialState(),
        local: [],
        pipeline: applyAll(createSections(), deliveries),
      },
      { cols: 60, rows: 30 },
    ).map(rowText);
  const drift: BlockDelivery[] = [
    { kind: "user", turn: 3, step: 0, text: "追问" },
    {
      kind: "text",
      turn: 9,
      step: 1,
      index: 0,
      source: "assistant",
      text: "答复九",
    },
    { kind: "turn-end", turn: 9, step: 1, reason: "completed" },
  ];
  const driftRow = rows(drift).find((text) => text.includes("追问"));
  assert.ok(
    driftRow !== undefined && driftRow.includes("✓"),
    `漂移也要显 ✓：${JSON.stringify(driftRow)}`,
  );
  // 反例：非终态原因（interrupted）不显 ✓（既有设计：保持未定 → `?`）
  const interrupted: BlockDelivery[] = [
    { kind: "user", turn: 1, step: 0, text: "追问" },
    { kind: "turn-end", turn: 1, step: 1, reason: "interrupted" },
  ];
  const interruptedRow = rows(interrupted).find((text) =>
    text.includes("追问"),
  );
  assert.ok(
    interruptedRow !== undefined && interruptedRow.includes("?"),
    `中断回合保持 ?：${JSON.stringify(interruptedRow)}`,
  );
});

// ---- 条目 16 段 D：节身份 / 行身份是**稳定量**（重建后逐字节一致） ----
//
// 旧口径：节身份 = `WeakMap<Section, number>` + 全局自增，行身份 = `WeakMap<Box, number>` +
// 全局自增。节对象每次写入都被换成副本（`sections.ts` 的 `close` / `write` 都是浅拷贝），
// 于是**每来一次交付**段键与行号就整体换号（实测流式 12 步里段键换 8 次：`1:0` → `2:0`
// → `3:0` …），渐进扩窗 / 重放 / 会话切换后更与前一帧对不上——视口位置（段键 + 段内行）
// 随之失配、回落「距底偏移」，表现为扩窗或切换后画面跳到窗口顶。
// 现口径：节身份由**节自身派生**（`turn:step` + 角色 + 同组合出现序，见 `panes.ts`
// 的 `sectionIdentities`），行身份由段键派生（`frame.ts` 的 `syntheticSeq`）。

/** 整帧逐字节（`FrameRow[]` 的 JSON，含段级样式与 caret） */
function frameBytes(
  st: AppState,
  size: { rows: number; cols: number },
): string {
  return JSON.stringify(buildFrame(st, size));
}

/** 段键 + 逐行身份（`{ 段键, 行身份 }`，按段表展开）：跨重建的两类稳定量 */
function identityOf(
  st: AppState,
  windowGroups?: number,
): { keys: string[]; rows: { key: string; seq: string }[] } {
  const built = pipelineContent(st.pipeline ?? createSections(), {
    dialogueTextW: 80,
    activityTextW: 80,
    windowGroups: windowGroups ?? st.windowGroups,
    render: { width: 80 },
  });
  const rows: { key: string; seq: string }[] = [];
  let at = 0;
  for (const [index, key] of built.dialogueKeys.entries()) {
    const count = built.dialogueCounts[index] ?? 0;
    for (let n = 0; n < count; n++) {
      rows.push({ key, seq: String(built.dialogue[at++]?.seq ?? "-") });
    }
  }
  return { keys: [...built.dialogueKeys], rows };
}

/** 内容行（正文 / 用户块）的「段键 → 行身份」表（排除边界项：它们的段键随窗口边界变） */
function contentIdentity(v: {
  rows: { key: string; seq: string }[];
}): Map<string, string> {
  return new Map(
    v.rows
      // 新链段键: 内容=数字键 `${turn}:${step}:${序}:${块}`(或含 `:u#` 的用户块);
      // 边界项以字母前缀开头(sep@/blank@/step@/summary@gap@turn@)
      .filter(
        (row) =>
          /^\d/.test(row.key) ||
          row.key.includes(":u#") ||
          row.key.includes(":c#"),
      )
      .map((row) => [row.key, row.seq]),
  );
}

test("段 D · Home：扩窗上滚后回最新，与一直跟随底部逐字节一致（段键 / 行身份不变）", () => {
  const size = { rows: 30, cols: 100 };
  const base: AppState = {
    ...initialState(),
    pipeline: applyAll(createSections(), script(6)),
  };
  // 一直跟随底部（从未上滚）
  const bottomBytes = frameBytes(base, size);
  const bottom = identityOf(base);

  // 上滚：扩窗物化更早回合（App 侧由视口容量驱动，这里直接置窗口组数）
  const scrolled = reduceState(base, { type: "window-grow", groups: 99 });
  const wider = identityOf(scrolled);
  const narrow = contentIdentity(bottom);
  const wide = contentIdentity(wider);
  assert.ok(wide.size > narrow.size, "上滚确实多物化了更早的内容段");
  // 扩窗只多物化、不改已物化段：原窗口里的每个内容段在新序列里拿到**同一段键 + 同一行身份**
  // （边界项——回合分隔线 / 空行——的段键随窗口起点变，不在比较之列）
  for (const [key, seq] of narrow) {
    assert.equal(wide.get(key), seq, `扩窗后 ${key} 的段键与行身份不变`);
  }
  // 原窗口的段键在新序列里**原样保留**（尾部逐项一致，含边界项）
  const keptKeys = wider.keys.filter((key) => bottom.keys.includes(key));
  assert.deepEqual(
    keptKeys,
    bottom.keys.filter((key) => wider.keys.includes(key)),
    "扩窗不改已物化段的段键与顺序",
  );

  // 上滚后停在历史里（视口顶 = 某段键 + 段内行），再回最新
  const parked = reduceState(scrolled, {
    type: "dialogue-scroll",
    top: { key: wider.keys[0] ?? "", row: 3 },
    offset: 12,
  });
  const back = reduceState(parked, { type: "scroll-to-bottom" });
  assert.equal(frameBytes(back, size), bottomBytes, "回最新后整帧逐字节一致");
  assert.deepEqual(identityOf(back), bottom, "段键与行身份逐项一致");
});

test("段 D · 流式改写：同一逻辑节的段键在交付推进中不被换号", () => {
  const all = script(1);
  const keysAt = (n: number): string[] =>
    identityOf(
      {
        ...initialState(),
        pipeline: applyAll(createSections(), all.slice(0, n)),
      },
      99,
    ).keys;
  let prev = keysAt(2);
  for (let n = 3; n <= all.length; n++) {
    const now = keysAt(n);
    for (const key of prev) {
      assert.ok(
        now.includes(key),
        `第 ${n} 步：段键 ${key} 应保持（旧口径每次交付整体换号）`,
      );
    }
    prev = now;
  }
});

test("段 D · 会话切换 / 重放：同一份历史行重放两次（含切走再切回）逐字节一致", () => {
  const size = { rows: 30, cols: 100 };
  const rows = oldBuffer(3);
  const replay = (): AppState => ({
    ...initialState(),
    local: [],
    pipeline: sectionsFromBuffer(rows, { history: true }),
  });
  const firstBytes = frameBytes(replay(), size);
  const first = identityOf(replay());
  assert.equal(
    frameBytes(replay(), size),
    firstBytes,
    "重放两次整帧逐字节一致",
  );
  assert.deepEqual(
    identityOf(replay()),
    first,
    "重放两次段键 / 行身份逐项一致",
  );

  // 切走（另一会话的历史行）再切回：切回后与首次重放逐字节一致
  const otherBytes = frameBytes(
    {
      ...initialState(),
      local: [],
      pipeline: sectionsFromBuffer(oldBuffer(2), { history: true }),
    },
    size,
  );
  assert.notEqual(
    otherBytes,
    firstBytes,
    "不同会话内容不同（自检：比较有意义）",
  );
  assert.equal(frameBytes(replay(), size), firstBytes, "切回后逐字节一致");
  assert.deepEqual(identityOf(replay()), first, "切回后段键 / 行身份逐项一致");
});

test("段 D · 重放 vs 实时交付：同内容整帧逐字节一致（差异口径见注释）", () => {
  // 语料只用「每回合都已定型」的文本内容：恢复重放把整节标 `history`——正文与工具批都归
  // 会话区；实时路径把未定型内容（思考 / 工具批 / 中间正文）归回合区。这是既定分派口径
  // （见 `tests/pipeline-equivalence.test.ts` 的等价协议），故不纳入本用例的逐字节比较。
  const T = 1_700_000_000_000;
  const live: BlockDelivery[] = [];
  const rows: HistoryRow[] = [];
  for (let turn = 1; turn <= 2; turn++) {
    live.push({ kind: "turn-start", turn, time: T + turn * 1000 });
    live.push({ kind: "user", turn, step: 1, text: `第 ${turn} 问` });
    live.push({ kind: "step-start", turn, step: 1, time: T + turn * 1000 });
    live.push({
      kind: "text",
      turn,
      step: 1,
      index: 0,
      source: "assistant",
      text: `第 ${turn} 答：正文。`,
    });
    live.push({ kind: "finalize", turn, step: 1 });
    live.push({ kind: "turn-end", turn, step: 1 });
    rows.push({
      text: "--------",
      kind: "separator",
      turn,
      time: T + turn * 1000,
    });
    rows.push({ text: `第 ${turn} 问`, kind: "user" });
    rows.push({
      text: `22:31:0${turn} ⇆${turn} #1`,
      kind: "tool",
      time: T + turn * 1000,
    });
    rows.push({
      text: `第 ${turn} 答：正文。`,
      kind: "assistant",
      final: true,
    });
  }
  const liveState: AppState = {
    ...initialState(),
    local: [],
    pipeline: applyAll(createSections(), live),
  };
  const replayState: AppState = {
    ...initialState(),
    local: [],
    pipeline: sectionsFromBuffer(rows, { history: true }),
  };
  for (const size of [
    { rows: 30, cols: 100 },
    { rows: 24, cols: 60 },
  ]) {
    assert.equal(
      frameBytes(replayState, size),
      frameBytes(liveState, size),
      `重放与实时交付逐字节一致（${size.cols}x${size.rows}）`,
    );
  }
  // 行身份跨路径一致：内容节逐项相同（用户节的差异见下一条断言）
  // 行身份跨路径一致：非首回合内容节逐项相同（用户节与首回合 step 位移见下一条断言）
  const contentSeq = (v: { rows: { key: string; seq: string }[] }): string[] =>
    v.rows
      // 新链内容键 = 数字键 `${turn}:${step}:${序}:${块}`（排除 `@` 边界项）；首回合键在
      // 重放下整体位移(用户落 step0), 不在比较之列
      .filter((row) => /^[2-9]\d*:/.test(row.key) || row.key.includes(":c#"))
      .map((row) => `${row.key}:${row.seq}`);
  assert.deepEqual(
    contentSeq(identityOf(replayState, 99)),
    contentSeq(identityOf(liveState, 99)),
    "内容节的行身份逐项一致",
  );
  // 既定差异（钉住，不隐藏）：重放按**行序**还原作用域——历史行序里用户行在 step 头之前，
  // 故首回合用户节落在 step 0，后续首回合键整体位移一步；实时交付按自带 step 编号。
  // 该差异只体现在段键字符串上（渲染内容与行数完全一致，上面的整帧比较仍逐字节相等）。
  const liveKeys = identityOf(liveState, 99).keys;
  const replayKeys = identityOf(replayState, 99).keys;
  assert.deepEqual(
    liveKeys.filter((key, index) => key !== replayKeys[index]),
    ["1:1:0:0", "blank@1:1:1:0", "1:1:1:0"],
    "唯一差异 = 首回合键的整体 step 位移（重放按行序还原作用域：用户落 step0）",
  );
});
