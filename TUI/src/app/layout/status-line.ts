// src/app/layout/status-line.ts — 底部状态栏渲染（模型 / 用量 / 分支 / 沙箱等段）

import type { FrameRow, FrameSegment } from "../../renderer/index.ts";
import type { AppState, InputStatus } from "../state.ts";
import { fillBoxTree } from "./fill.ts";
import { h, styled } from "./box.ts";
import type { Box } from "./box.ts";
import { charWidth, displayWidth } from "./markdown.ts";
import { seg, truncateToWidth } from "./primitives.ts";

// src/app/layout/status-line.ts — 底部状态栏渲染（模型 / 用量 / 分支 / 沙箱等段）

/** 模型段标签：provider/model[:reasoningEffort]，无 effort 时不带冒号后缀 */
export function modelLabel(sel: {
  provider: string;
  model: string;
  reasoningEffort?: string;
}): string {
  return `${sel.provider}/${sel.model}${sel.reasoningEffort ? ":" + sel.reasoningEffort.toLowerCase() : ""}`;
}

/** provider 紫，模型名青，:后缀 正常前景色；无 "/" 时整体青（占位 "—" 保持无色）。
 *  状态栏段配色约定：相邻段不同色、不用红/黄/绿状态色、不用亮色系（bright*）。 */
function colorModel(s: string): FrameSegment[] {
  const slash = s.indexOf("/");
  if (slash < 0) return s === "—" ? [seg(s)] : [seg(s, { fg: "cyan" })];
  const rest = s.slice(slash + 1);
  const colon = rest.indexOf(":");
  const model = colon < 0 ? rest : rest.slice(0, colon);
  const effort = colon < 0 ? "" : rest.slice(colon);
  const out: FrameSegment[] = [
    seg(s.slice(0, slash), { fg: "magenta" }),
    seg(`/${model}`, { fg: "cyan" }),
  ];
  if (effort) out.push(seg(effort));
  return out;
}
/** notice/tool 行 tone → 着色名（log 灰 / info 蓝 / warn 黄 / error 红 / success 绿） */

/** 活动行是否为视觉空白：纯文本无可见字符（空思考/notice 拖尾行） */
function formatTokens(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** state.usage → 状态栏 contextLen/cacheHit 段（total<=0 或无用量时 undefined，保留占位） */
function usageStatus(u: {
  input: number;
  output: number;
  cacheRead: number;
  contextWindow?: number;
}): { ctx: string; cache: string } | undefined {
  const total = u.input + u.cacheRead;
  if (total <= 0) return undefined;
  const pct = Math.round((u.cacheRead / total) * 100);
  // 上下文占用百分比 = total / 模型上下文窗口（窗口未知/未披露时省略，保持仅绝对大小）
  const win = u.contextWindow;
  const ctxPct =
    win && win > 0
      ? `(${Math.min(100, Math.round((total / win) * 100))}%)`
      : "";
  return {
    ctx: `ctx ${formatTokens(total)}${ctxPct}`,
    cache: `cache ${pct}%`,
  };
}

/** 段文本按预算截断：过长保留开头 + 省略号（w<=3 视作不截断，交给换行兜底） */
function fitHead(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
  return `${truncateToWidth(s, w - 1)}…`;
}

/** git 段在 env 组超宽时的预算列数（分支 + 尾部统计符号；比 cwd 更需要完整） */
const GIT_FIT_WIDTH = 20;

/**
 * git 段按预算截断：分支名开头 + 尾部统计符号簇（`↑N ↓N +N ~N -N`）都要保。
 * 符号在尾部（`main ↑1 +2 ~3`），整体截头会把新信息全砍掉——故分支名中段省略、
 * 符号簇整体保留；符号簇本身就放不下时才退回按头截断。
 */
function fitGit(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
  // 分支名不含空格，统计符号以空格分隔 → 第一个空格起是符号簇
  const sp = s.indexOf(" ");
  const branch = sp >= 0 ? s.slice(0, sp) : s;
  const tail = sp >= 0 ? s.slice(sp) : "";
  if (tail !== "") {
    const tailW = displayWidth(tail);
    if (tailW + 2 <= w) {
      const branchW = Math.max(1, w - 1 - tailW); // 留 1 列省略号
      return `${truncateToWidth(branch, branchW)}…${tail}`;
    }
  }
  return fitHead(s, w);
}

/** 路径段按预算截断：保留末尾 + 省略号（路径尾部更有辨识度） */
function fitTail(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
  const budget = w - 1; // 省略号占 1 列
  let kept = "";
  let used = 0;
  for (const ch of [...s].reverse()) {
    const cw = charWidth(ch);
    if (budget - used < cw) break; // 剩余预算放不下该字符则停，保留已取尾部
    kept = ch + kept;
    used += cw;
  }
  return `…${kept}`;
}

/**
 * 模型段按预算截断：优先截 provider/model 名，保留 effort 后缀（:min/:med/:max 等）。
 * 稳定内容紧凑化，避免长模型名挤占动态段（cwd/ctx/cache）的宽度。
 */
function fitModel(s: string, w: number): string {
  const slash = s.indexOf("/");
  const colon = (slash < 0 ? s : s.slice(slash)).indexOf(":");
  const effort = colon >= 0 ? s.slice(slash + colon) : ""; // 含 : 前缀
  const body = effort ? s.slice(0, s.length - effort.length) : s;
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
  const bodyW = Math.max(1, w - 1 - displayWidth(effort)); // 留 1 列省略号
  return `${truncateToWidth(body, bodyW)}…${effort}`;
}

export function renderStatusLine(
  status: AppState["systemStatus"],
  cols: number,
  /** 最新一次模型调用 token 用量（有且 total>0 时覆盖 contextLen/cacheHit 占位） */
  usage?: AppState["usage"],
  /** 输入状态（签名保留兼容调用方）：P1 起状态栏不再渲染状态符号段
   *  （✓/✗/●/○/△/? 已迁至用户块首行，见 userBlockSymbol），本参数当前未参与排版 */
  inputStatus?: InputStatus,
  /** 运行中 ●/○ 交替相位（本回合虚拟总 token；running 且缺省时回落 ○） */
  runVirtTokens?: number,
): FrameRow[] {
  const u = usage ? usageStatus(usage) : undefined;
  const ctxSeg = u?.ctx ?? status.contextLen;
  const cacheSeg = u?.cache ?? status.cacheHit;
  // 思考状态并入 model 段（同一逻辑段）：provider/model:{后缀}
  // 后缀=on/off/none 或实际等级名（多等级开启如 high/low/max）
  const modelBase = status.model.replace(/:[^:]*$/, "");
  const thinkOn = status.model !== modelBase;
  const thinkState = status.modelThinking ?? (thinkOn ? "on" : "none");
  const modelSeg = `${modelBase}:${thinkState}`;

  // 状态栏按类分组（组间 `•` 分隔、组内 `•` 分隔）：
  //   环境组：time • git • cwd            （本机/工作区信息，与会话无关）
  //   LLM 组：model:{后缀} • ctx • cache  （最近一次模型调用指标）
  // 每个「逻辑段」= 多个 FrameSegment（点击色可分多段，如 provider/model/:后缀），
  // 组内逻辑段之间插 `•`、物理段之间不插。
  // P1：状态符号段已迁至**用户块首行左侧**（见 userBlockSymbol），状态栏不再承载符号；
  // 首行行首回到 1 空格留边（与其他行一致）
  const maxSegW = Math.max(1, cols - 2); // 留首尾各 1 列
  // 段配色：time 默认 / git 洋红 / cwd 蓝 / title 青 / provider 紫 / model 青
  //          / 后缀 正常前景 / ctx 蓝 / cache 默认
  // 会话别名段（TUI#48）：仅在 session-channel 已设别名时出现，`@<别名>` 以示区别
  const aliasSeg: FrameSegment[][] =
    status.alias === undefined || status.alias === ""
      ? []
      : [[{ text: `@${status.alias}`, style: { fg: "cyan" } }]];
  const envFull: FrameSegment[][] = [
    [{ text: status.time }],
    [{ text: status.git, style: { fg: "magenta" } }],
    [{ text: status.cwd, style: { fg: "blue" } }],
    ...aliasSeg,
  ];
  const llmFull: FrameSegment[][] = [
    [...colorModel(modelSeg)],
    [{ text: ctxSeg, style: { fg: "blue" } }],
    [{ text: cacheSeg }],
  ];
  // 各组超宽兜底（单组放不满一行时组内压缩）
  const envFit = (w: number): FrameSegment[][] => {
    const gitS = fitGit(status.git, GIT_FIT_WIDTH);
    const aliasW =
      status.alias === undefined || status.alias === ""
        ? 0
        : displayWidth(`@${status.alias}`) + 3; // 段间 `•` 与留白
    const budget = Math.max(
      1,
      w - displayWidth(status.time) - displayWidth(gitS) - 2 - 1 - aliasW,
    );
    return [
      [{ text: status.time }],
      [{ text: gitS, style: { fg: "magenta" } }],
      [{ text: fitTail(status.cwd, budget), style: { fg: "blue" } }],
      ...aliasSeg,
    ];
  };
  const llmFit = (w: number): FrameSegment[][] => {
    const budget = Math.max(
      1,
      w - displayWidth(ctxSeg) - displayWidth(cacheSeg) - 2 - 1,
    );
    return [
      [...colorModel(fitModel(modelSeg, budget))],
      [{ text: ctxSeg, style: { fg: "blue" } }],
      [{ text: cacheSeg }],
    ];
  };

  // 组段（组内逻辑段间插 `•` 圆点；单组超行宽时用组内压缩版）
  const dotJoin = (g: FrameSegment[][]): FrameSegment[] =>
    g.flatMap((s, si) => [
      ...(si > 0 ? [{ text: "•" } as FrameSegment] : []),
      ...s,
    ]);
  const segWidth = (segs: FrameSegment[]): number =>
    segs.reduce((a, x) => a + displayWidth(x.text), 0);
  const fulls = [dotJoin(envFull), dotJoin(llmFull)];
  const fits = [dotJoin(envFit(maxSegW)), dotJoin(llmFit(maxSegW))];
  const pick = (gi: number): FrameSegment[] =>
    segWidth(fulls[gi]!) > maxSegW ? fits[gi]! : fulls[gi]!;

  // 行分组决策（组为整体不拆，放不下整组换行；单组超行宽才组内压缩）：
  // 每行 = 组索引列表，行内组间以横向 Box 框线分隔
  const rowPlan: number[][] = [[]];
  let used = 0;
  for (let gi = 0; gi < fulls.length; gi++) {
    const segs = pick(gi);
    const gap = used > 0 ? 1 : 0;
    if (used > 0 && used + gap + segWidth(segs) > maxSegW) {
      rowPlan.push([]);
      used = 0;
    }
    rowPlan[rowPlan.length - 1]!.push(gi);
    used += (used > 0 ? 1 : 0) + segWidth(segs);
  }

  // 每行 → 横向 Box（组间以 `•` 圆点分隔，占 1 列由 measure/allocate 预留、
  // fill 逐行插圆点）→ 摊平成一行。行首/行尾各留 1 空格（「首尾空格留边」）；
  // P1 起不再有状态符号段（符号迁至用户块首行）
  return rowPlan.map((plan) => {
    const children = plan.map((gi, i) => {
      const segs: FrameSegment[] = [];
      if (i === 0) segs.push({ text: " " }); // 行首留边
      segs.push(...pick(gi));
      if (i === plan.length - 1) segs.push({ text: " " }); // 行尾留边
      return styled(segs, { wrap: false });
    });
    const box = h(
      children,
      plan.length > 1
        ? { separator: { char: "•", color: "plain" as const } }
        : {},
    );
    const out = fillBoxTree(box, 1, cols);
    return out[0] ?? { segments: [] };
  });
}

/**
 * 状态栏行内**框线竖线**（border 色 `│`）的列位置列表（0 基，升序去重）。
 * buildFrame 用它在上/下横线对应列画交点（┬/┴），使竖线两端与横线相接成格。
 * P1 起状态符号段迁至用户块首行、组间分隔改为 `•` 圆点（color="plain"），
 * 状态栏行内已无 border 色 `│` 段 → 对当前状态栏行恒返回空数组（不画交点）。
 */
export function statusBarSeamCols(row: FrameRow | undefined): number[] {
  if (!row) return [];
  const cols: number[] = [];
  let col = 0;
  for (const seg of row.segments) {
    if (seg.style?.fg === "border") {
      const i = seg.text.indexOf("│");
      if (i >= 0) cols.push(col + displayWidth(seg.text.slice(0, i)));
    }
    col += displayWidth(seg.text);
  }
  return [...new Set(cols)].sort((a, b) => a - b);
}
