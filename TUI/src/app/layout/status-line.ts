// TUI/src/app/layout/status-line.ts — 底部状态行渲染（模型 / 用量 / 分支 / 沙箱等段）

import type { FrameRow, FrameSegment } from "../../renderer/index.ts";
import type { AppState, InputStatus } from "../state.ts";
import { fillBoxTree } from "./fill.ts";
import { h, styled } from "./box.ts";
import { charWidth, displayWidth } from "./markdown.ts";
import { seg, truncateToWidth } from "./primitives.ts";

// TUI/src/app/layout/status-line.ts — 底部状态行渲染（模型 / 用量 / 分支 / 沙箱等段）

/** 模型段标签：provider/model[:reasoningEffort]，无 effort 时不带冒号后缀 */
export function modelLabel(sel: {
  provider: string;
  model: string;
  reasoningEffort?: string | undefined;
}): string {
  return `${sel.provider}/${sel.model}${sel.reasoningEffort ? ":" + sel.reasoningEffort.toLowerCase() : ""}`;
}

/** provider 紫，模型名青，:后缀 正常前景色；无 "/" 时整体青（占位 "—" 保持无色）。
 *  状态行段配色约定：相邻段不同色、不用红/黄/绿状态色、不用亮色系（bright*）。 */
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

/** state.usage → 状态行 contextLen/cacheHit 段（total<=0 或无用量时 undefined，保留占位） */
function usageStatus(u: {
  input: number;
  output: number;
  cacheRead: number;
  contextWindow?: number | undefined;
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

/** 性能槽位文本：首字节延时 + 解码速率（B1/B3；不带 `ttfb` 标签、速率单位 `t/s`）。
 *  无读数（尚未开始 / 该步已收尾归零）时给 `0ms 0 t/s` 常驻占位。 */
function performanceText(p?: {
  ttfbMs?: number | undefined;
  avgTokensPerSec?: number | undefined;
  streamed: boolean;
}): string {
  const ttfb = p?.ttfbMs === undefined ? formatTtfb(0) : formatTtfb(p.ttfbMs);
  return `${ttfb} ${formatRate(p?.avgTokensPerSec ?? 0)} t/s`;
}

/** 速率展示：≤0 只写 `0`，其余 ≥100 取整、否则 1 位小数。 */
function formatRate(v: number): string {
  if (v <= 0) return "0";
  return v.toFixed(v >= 100 ? 0 : 1);
}

/** TTFB 展示: 数字右对齐补足 4 字符宽, 数字与单位间空一格;
 *  <1s 用 ms, >=1s 用 s（保留 1 位小数, 注明近似）。
 *  例: 350 → ` 350 ms`, 1500 → ` 1.5 s`, 0 → `   0 ms`。 */
function formatTtfb(ms: number): string {
  const num = ms < 1000
    ? String(Math.round(ms))
    : (ms / 1000).toFixed(1);
  const unit = ms < 1000 ? "ms" : "s";
  return `${num.padStart(4, " ")} ${unit}`;
}

/** 缓存判定三态 → cache 段颜色（决策项 9：正常绿 / 缓存失效告警红 / 首次黄；
 *  无判定返回 undefined = 默认前景色）。色值取主题调色板同名槽位。 */
function cacheTintOf(
  judge: AppState["cacheJudge"] | undefined,
): "green" | "red" | "yellow" | undefined {
  switch (judge?.state) {
    case "normal":
      return "green";
    case "stale":
      return "red";
    case "first":
      return "yellow";
    default:
      return undefined;
  }
}

/** cache 段（文字不变、按判定着色）：无判定 / 无 usage 时保持默认前景色
 *  （决策项 11：无 cache 数据沿用 `—` 占位、不着色）。 */
function cacheSegment(
  text: string,
  tint: "green" | "red" | "yellow" | undefined,
): FrameSegment {
  return tint === undefined ? { text } : { text, style: { fg: tint } };
}

/** 段文本按预算截断：过长保留开头 + 省略号（w<=3 视作不截断，交给换行兜底） */
function fitHead(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
  return `${truncateToWidth(s, w - 1)}…`;
}

/** git 段在 env 组超宽时的预算列数（分支 + 尾部统计符号；比 cwd 更需要完整） */
const GIT_FIT_WIDTH = 20;

/** LLM 组组内压缩时留给 model 段的最小列数：小于此值先丢掉性能段（保模型名可辨）。 */
const MODEL_FIT_FLOOR = 8;

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
  const chars = Array.from(s).reverse();
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
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
  /** 输入状态（签名保留兼容调用方）：P1 起状态行不再渲染状态符号段
   *  （✓/✗/●/○/△/? 已迁至用户块首行，见 userBlockSymbol），本参数当前未参与排版 */
  _inputStatus?: InputStatus,
  /** 运行中 ●/○ 交替相位（本回合虚拟总 token；running 且缺省时回落 ○） */
  _runVirtTokens?: number,
  /** B1/B3：最新一次模型调用的性能指标（TTFB / 平均解码速率） */
  performance?: AppState["performance"],
  /** A6：缓存命中率判定（cache-hit-monitor 服务面懒读；cache 段三态着色用） */
  cacheJudge?: AppState["cacheJudge"],
): FrameRow[] {
  const u = usage ? usageStatus(usage) : undefined;
  const ctxSeg = u?.ctx ?? status.contextLen;
  const cacheSeg = u?.cache ?? status.cacheHit;
  // A6: cache 段着色（决策项 9/11）：有 usage 且有判定才着色；`—` 占位保持默认色
  const cacheTint = u === undefined ? undefined : cacheTintOf(cacheJudge);
  // B1/B3: 性能槽位（首字节延时 + 解码速率; 常驻占位, 该步收尾归零为 `0ms 0 t/s`）
  const perfSeg = performanceText(performance);
  // 思考状态并入 model 段（同一逻辑段）：provider/model:{后缀}
  // 后缀=on/off/none 或实际等级名（多等级开启如 high/low/max）
  const modelBase = status.model.replace(/:[^:]*$/, "");
  const thinkOn = status.model !== modelBase;
  const thinkState = status.modelThinking ?? (thinkOn ? "on" : "none");
  const modelSeg = `${modelBase}:${thinkState}`;

  // 状态行按类分组（组间 `•` 分隔、组内 `•` 分隔）：
  //   环境组：time • git • cwd            （本机/工作区信息，与会话无关）
  //   LLM 组：model:{后缀} • ctx • cache  （最近一次模型调用指标）
  // 每个「逻辑段」= 多个 FrameSegment（点击色可分多段，如 provider/model/:后缀），
  // 组内逻辑段之间插 `•`、物理段之间不插。
  // P1：状态符号段已迁至**用户块首行左侧**（见 userBlockSymbol），状态行不再承载符号；
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
    [cacheSegment(cacheSeg, cacheTint)],
    [{ text: perfSeg }],
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
    const perfW = displayWidth(perfSeg) + 2; // 段间 `•` 与留白
    const fixedW = displayWidth(ctxSeg) + displayWidth(cacheSeg) + 3;
    // 极窄宽优先保 model 段身份：性能段是可丢段（两个零值的占位不如模型名有用）
    const withPerf = w - fixedW - perfW >= MODEL_FIT_FLOOR;
    const budget = Math.max(1, w - fixedW - (withPerf ? perfW : 0));
    return [
      [...colorModel(fitModel(modelSeg, budget))],
      [{ text: ctxSeg, style: { fg: "blue" } }],
      [cacheSegment(cacheSeg, cacheTint)],
      ...(withPerf ? [[{ text: perfSeg }]] : []),
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
      return styled(segs, { wrap: { mode: "none", hint: "none" } });
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
 * 状态行内**框线竖线**（border 色 `│`）的列位置列表（0 基，升序去重）。
 * buildFrame 用它在上/下横线对应列画交点（┬/┴），使竖线两端与横线相接成格。
 * P1 起状态符号段迁至用户块首行、组间分隔改为 `•` 圆点（color="plain"），
 * 状态行内已无 border 色 `│` 段 → 对当前状态行恒返回空数组（不画交点）。
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
