// renderer/index.ts — Renderer 公共 API：terminal + input + screen 的组装
//
// 契约见 TUI/docs/DESIGN.md「核心接口契约」。退出生命周期归 renderer：
// close()/SIGINT/SIGTERM/uncaught 一律先恢复终端。

import { appendFileSync } from "node:fs";
import {
  Screen,
  CURSOR_HIDE,
  CURSOR_SHOW,
  type FrameFocus,
  type FrameRow,
  type FrameSection,
  type RenderInterval,
  serializeFrameRow,
} from "./screen.ts";
import type { Size } from "./screen.ts";
import {
  DEFAULT_THEME,
  THEMES,
  type ColorTheme,
  type ThemeId,
} from "./theme.ts";
import type { KeyEvent } from "./input.ts";
import { KeyDecoder } from "./input.ts";
import {
  createTerminal,
  installExitHandlers,
  type ExitResult,
} from "./terminal.ts";

export type { FrameRow, KeyEvent };
export type {
  FrameSegment,
  FrameStyle,
  FrameFocus,
  FrameSection,
  RenderInterval,
} from "./screen.ts";
export type { Size };

/** bracketed paste 启用 / 关闭（BACKLOG 条目 11）：启用后终端把粘贴内容包在
 *  `ESC[200~ … ESC[201~` 里，解码层产出**单个** `paste` 事件（整段插入、不逐行提交） */
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";

/** 宽度探测的**块间静默期**（ms）：等上一块可能迟到的 CPR 应答落地并被丢弃，
 *  再注册下一块的等待者（应答不带请求标识，靠到达顺序配对 → 跨块会错位）。 */
export const PROBE_SETTLE_MS = 20;

/** 宽度探测里被**丢弃**的列差（诊断留痕，`TUI_WIDTH_DUMP` 用）：`delta = null` 表示跨行
 *  （自动换行使列差作废），其余为落在 `{1,2}` 之外的异常列差。 */
export type ProbeReject = {
  readonly ch: string;
  readonly delta: number | null;
  readonly row: number;
  readonly col: number;
  readonly prevRow: number;
  readonly prevCol: number;
};

/**
 * 宽度探测里被**整块作废**的批次（诊断留痕，`TUI_WIDTH_DUMP` 用）：一块的应答只要
 * 命中可疑条件，该块全部字符都不产出宽度（交由调用方重排队重试），因为它们与应答的
 * 对应关系已不可信。
 */
export type ProbeVoid = {
  /** short = 应答数不足（迟到的应答可能属于别的批次）；row = 有应答不在探测基线行；back = 列倒退（应答错序） */
  readonly reason: "short" | "row" | "back";
  readonly chars: readonly string[];
  /** 实际收到的应答数 / 该块请求数 */
  readonly responded: number;
  readonly expected: number;
};

/** 探测报文的定位行（候选字符画在屏幕原点，应答的行号必与此一致） */
const PROBE_BASELINE_ROW = 1;

/**
 * 整块作废判定（BACKLOG「字符宽度探测的触发时机」裁定 ③）：应答数不足 / 有应答偏离
 * 探测基线行 / 列**倒退** —— 任一命中即整块作废（该块字符与应答的对应关系已不可信，
 * 由调用方重排队重试）。下列两种**不算**整块可疑：① 列差落在 `{1,2}` 之外但列在递增
 * （只丢那个字符，避免一个真宽字符废掉同块其余字符）；② 列差为 0（该字符在终端上零宽，
 * 只丢那个字符）。
 *
 * 代价：真的发生自动换行时整块本轮不产出（旧实现只丢换行处那一个字符）。分块按
 * 「每字符最多 2 列 + 1 列余量」切分（见 `probeSymbolWidths`），正常终端不会换行。
 */
function chunkVoidReason(
  responses: readonly { readonly row: number; readonly col: number }[],
  expected: number,
): ProbeVoid["reason"] | null {
  if (responses.length !== expected) return "short";
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i]!;
    if (r.row !== PROBE_BASELINE_ROW) return "row";
    if (i > 0 && r.col < responses[i - 1]!.col) return "back";
  }
  return null;
}

export interface Renderer {
  /** 整帧重绘；内含变化行游程重写（sections 提供时先按帧段切分）。
   *  focus（3.1.3）：输入焦点与位置，决定重写结束后光标是否定位回输入位置。 */
  render(rows: FrameRow[], sections?: FrameSection[], focus?: FrameFocus): void;
  /** 强制整帧重绘（绕过 delta 优化，Ctrl+L 用）；focus 语义同 render */
  refresh(
    rows: FrameRow[],
    sections?: FrameSection[],
    focus?: FrameFocus,
  ): void;
  onKey(cb: (k: KeyEvent) => void): void;
  /** 合成按键注入（无 TTY / 测试 / 脚本驱动用；不经 stdin 解码） */
  emitKey(k: KeyEvent): void;
  /** 合成 CPR 响应注入（无 TTY / 测试 / 脚本驱动用；实现可选） */
  emitCpr?(row: number, col: number): void;
  /**
   * 终端字符宽度探测（呈现不确定字符的实测取值）：批量写「字符 + `CSI 6n`」，
   * 再按序读回光标位置（CPR），列差即该字符占用的列数——一次往返完成一块，
   * 超宽批次按终端宽度分块。终端不支持 CPR 时在 `timeoutMs` 后返回已收集结果（可能为空 Map）。
   * 探测字符会短暂出现在屏幕原点：调用方必须在探测之后出帧，且该帧走整帧重绘（覆盖残留）。
   * 注入型 renderer 可不实现（App 侧判空后跳过探测，沿用静态表）。
   *
   * 自校验（BACKLOG「字符宽度探测的触发时机」裁定 ③）：每块先校验应答（数量 / 基线行 /
   * 列序），命中可疑条件即**整块作废**（不产出宽度，`voids` 留痕），只有零应答才说明
   * 终端不支持 CPR —— 调用方据此决定「重排队重试」还是「关闭后续实测」。
   */
  probeSymbolWidths?(
    chars: readonly string[],
    timeoutMs?: number,
    rejects?: ProbeReject[],
    voids?: ProbeVoid[],
  ): Promise<Map<string, number>>;
  onResize(cb: (cols: number, rows: number) => void): void;
  getSize(): Size;
  /** 切换主题（改变基底前景/背景与 16 色槽位映射） */
  setTheme(id: ThemeId): void;
  /** 取当前注册表某主题（id 不存在回落默认主题） */
  getTheme?(id: ThemeId): ColorTheme;
  /** 终端 bell（BEL ；声音提醒事件钩子的输出口）。可选：注入型 renderer
   *  可不实现，App 侧经 `bell?.()` 调用。 */
  bell?(): void;
  /** 恢复终端并退出事件循环（`options.exit === false` 时只恢复终端、不结束进程：
   *  宿主停掉本条目（HMR / 插件重载）时由此保留会话，见 App 的 `dispose({ exit: false })`） */
  close(options?: { exit?: boolean }): void;
}

export interface CreateRendererOptions {
  /** 输出注入（测试用） */
  write?: (s: string) => void;
  /** 主题注册表（main 注入配置解析结果；缺省内置 THEMES） */
  themes?: Record<ThemeId, ColorTheme>;
  /** raw mode 开关：默认 true；测试/非 TTY 可关闭 */
  rawMode?: boolean;
  /** 追加层级渲染优化开关（默认 true） */
  delta?: boolean;
  /** close() 后是否退出进程（默认 true，符合 DESIGN「退出事件循环」契约） */
  exitOnClose?: boolean;
}

/**
 * 帧转储（排查设施，2026-10-04 起保留）：设 `TUI_FRAME_DUMP=<path>` 时把**每帧**与
 * **每条终端报文**按 JSONL 追加到该文件，用于定位「帧对但屏幕不对」类问题（残留 /
 * 首项被复制 / 错位）——这类问题取决于「实际写出的字节 + 当时的尺寸认知」，离线复现
 * 不一定命中，需要真机抓一段现场。
 *
 * 记录形态（每行一条 JSON，`t` 为毫秒时间戳）：
 * - `{kind:"frame", value:{size:{cols,rows}, count, lines:[...]}}`：本帧行文本（去样式）
 *   与渲染器**认为的**屏幕尺寸；`lines` 是判定「屏幕上应该是什么」的基准。
 * - `{kind:"out", value:"<终端报文原文>"}`：实际写出的转义序列（含行定位 / 擦除）。
 * - `{kind:"size", value:{got, out}}`：尺寸来源对比——`got` = 渲染器采用的尺寸，
 *   `out` = `process.stdout` 当下读数；两者不一致即「认知偏差」，滚屏 / 钳制类残留的源头。
 * - `{kind:"stop", value:"..."}`：达到上限后停止转储的收尾标记。
 *
 * 用法：`TUI_FRAME_DUMP=/tmp/tui-frames.jsonl dsh --profile fff` → 复现 → 退出。复盘时把
 * `kind:"out"` 的报文**按序**喂给 `tests/helpers/screenEmu.ts` 的 `ScreenEmu.feed()`
 * 重放，得到「屏幕上实际留下什么」，再与同刻 `kind:"frame"` 的 `lines` 逐行比对，
 * 差异行即残留 / 复制位置；`kind:"size"` 用来看认知偏差是否发生（及何时发生）。
 *
 * 开销：未设该环境变量时**不生效**（每次调用仅一次 env 读取 + 早返回）；设了则每次
 * 渲染同步追加一行，文件超上限即停（转储含屏幕文本，排查完请自行删除文件）。
 */
const FRAME_DUMP_MAX_BYTES = 8 * 1024 * 1024;
let frameDumpBytes = 0;
let frameDumpStopped = false;
function frameDump(kind: string, value: unknown): void {
  const path = process.env["TUI_FRAME_DUMP"];
  if (!path || frameDumpStopped) return;
  const line = JSON.stringify({ t: Date.now(), kind, value }) + "\n";
  if (frameDumpBytes + line.length > FRAME_DUMP_MAX_BYTES) {
    frameDumpStopped = true;
    try {
      appendFileSync(
        path,
        JSON.stringify({
          t: Date.now(),
          kind: "stop",
          value: `已达 ${FRAME_DUMP_MAX_BYTES} 字节上限，停止转储`,
        }) + "\n",
      );
    } catch {
      // 排查开关：写失败不影响渲染
    }
    return;
  }
  frameDumpBytes += line.length;
  try {
    appendFileSync(path, line);
  } catch {
    frameDumpStopped = true; // 写入失败（权限/磁盘）：停止重试，不影响渲染
  }
}

export function createRenderer(opts: CreateRendererOptions = {}): Renderer {
  const terminal = createTerminal();
  const themes = opts.themes ?? THEMES;
  // 原始写出句柄（屏幕渲染与宽度探测共用同一出口，便于测试捕获）
  const rawWrite = opts.write ?? ((s: string) => process.stdout.write(s));
  const write = (s: string): void => {
    frameDump("out", s);
    rawWrite(s);
  };
  const screen = new Screen({ write, themes });
  const decoder = new KeyDecoder();
  const keyCbs = new Set<(k: KeyEvent) => void>();
  const resizeCbs = new Set<(cols: number, rows: number) => void>();
  // CPR 等待者（宽度探测：终端对 CSI 6n 的应答按序唤醒）
  const cprWaiters = new Set<(row: number, col: number) => void>();
  decoder.onCpr = (row, col) => {
    for (const w of [...cprWaiters]) w(row, col);
  };
  const delta = opts.delta ?? true;
  const exitOnClose = opts.exitOnClose ?? true;
  // 当前主题（序列化文本比较用；随 setTheme 同步，screen.theme 为私有）
  let theme: ColorTheme = themes[DEFAULT_THEME];
  let prevRows: FrameRow[] | null = null;
  let prevSections: FrameSection[] | undefined;
  let closed = false;

  const passToRenderSizes = (): void => {
    if (terminal.stdin.isTTY) {
      const s = terminal.getSize();
      screen.resize(s.cols, s.rows);
      // 尺寸变化现场（排查：认知偏差何时发生）——got = 采用的尺寸，out = stdout 读数
      frameDump("size", {
        got: s,
        out: {
          cols: process.stdout.columns ?? 0,
          rows: process.stdout.rows ?? 0,
        },
      });
      for (const cb of resizeCbs) cb(s.cols, s.rows);
    }
  };

  // 键盘解码
  const onData = (chunk: Buffer): void => {
    for (const ev of decoder.feed(chunk)) for (const cb of keyCbs) cb(ev);
  };

  // bracketed paste：启用后粘贴内容整段到达（见 PASTE_ON）；关闭 = 还原终端状态，
  // 退出路径（restore / close）都走这里，重复调用只写一次
  let pasteModeOn = false;
  const pasteOff = (): void => {
    if (!pasteModeOn) return;
    pasteModeOn = false;
    rawWrite(PASTE_OFF);
  };

  // 终端恢复
  const restore = (): void => {
    pasteOff();
    if (!closed) terminal.rawMode(false);
  };

  // 退出路径统一钩子：恢复终端后退出
  // SIGHUP 走 onHangup（不退出）：终端挂断不等于用户要走——tmux detach / 客户端断开时
  // 会话必须保活（BACKLOG〈tmux 在 dsh 所在 window 内 detach 会让程序退出〉）；终端真没了
  // 时后续写 stdout 会失败并落到 uncaughtException 出口退出，故不会留下孤儿进程。
  const detach = installExitHandlers(
    (r: ExitResult) => {
      restore();
      if ("exitCode" in r) process.exit(r.exitCode);
      process.stderr.write(
        String((r as { injected?: unknown }).injected ?? r) + "\n",
      );
      process.exit(1);
    },
    () => {
      // 终端挂断：保留会话，等下一次按键 / 重绘（尺寸变化会走 resize → 全帧重绘）
      prevRows = null;
    },
  );

  const stdio = terminal.stdin;
  const onResizeEvt = (): void => passToRenderSizes();

  // 启动
  if (opts.rawMode !== false) {
    terminal.rawMode(true);
    // 粘贴协议只在真终端有意义（rawMode: false = 测试 / 无 TTY：不写模式序列）
    rawWrite(PASTE_ON);
    pasteModeOn = true;
  }
  stdio.on("data", onData);
  stdio.resume();
  process.stdout.on("resize", onResizeEvt);
  process.on("beforeExit", restore);
  passToRenderSizes();

  const renderer: Renderer = {
    render(
      rows: FrameRow[],
      sections?: FrameSection[],
      focus?: FrameFocus,
    ): void {
      if (closed) return;
      // 帧转储（TUI_FRAME_DUMP 生效时）：本帧行文本 + 渲染器认为的尺寸 + stdout 读数
      frameDump("frame", {
        size: screen.getSize(),
        out: {
          cols: process.stdout.columns ?? 0,
          rows: process.stdout.rows ?? 0,
        },
        count: rows.length,
        lines: rows.map((r) => r.segments.map((s) => s.text).join("")),
      });
      // delta 优化：与上一帧逐行比较取变化行**游程**，只重写这些区间（帧中任意位置，
      // 不限帧尾——状态栏符号/流式末行增长都只重写对应行，不清屏）。
      // sections 提供且与上一帧段表一致时按**帧段**切分：多段同时变化只重写各段内
      // 变化行，不跨越中间未变化的段；段内不连续的变化行再各自成区间（见 changedRuns）。
      // #3：**帧高变短一律走整帧重写**——变短意味着几何刚缩过（多路复用器里 resize
      // 上报可能滞后，期间帧比终端高就会触底滚屏、把整屏顶掉一行），逐行 diff 会
      // 认为「没变」而留下永久残留（「首项上方多一行」）；整帧重写从首行覆盖即自愈。
      // 帧高变长仍走 delta（常见于内容追加，且不会滚屏）。
      if (delta && prevRows && rows.length >= prevRows.length) {
        let intervals = changedIntervals(
          prevRows,
          rows,
          sections,
          prevSections,
          theme,
        );
        if (intervals === null) {
          // 段表不可用（首帧/几何变化/覆盖不全）：退化为整帧逐行游程比较
          intervals = changedRuns(prevRows, rows, theme).map(
            ({ first, last }) => ({
              startLine: first + 1,
              rows: rows.slice(first, last + 1),
            }),
          );
        }
        if (intervals.length === 0) {
          prevRows = rows; // 画面无变化：不出报文
          prevSections = sections;
          return;
        }
        // 新帧比旧帧短：区间重写后清除下方残留行（ESC[J）
        screen.renderRanges(intervals, rows.length < prevRows.length, focus);
        prevRows = rows;
        prevSections = sections;
        return;
      }
      screen.render(rows, focus);
      prevRows = rows;
      prevSections = sections;
    },
    refresh(
      rows: FrameRow[],
      sections?: FrameSection[],
      focus?: FrameFocus,
    ): void {
      if (closed) return;
      prevRows = null; // 强制走全帧 screen.render(清屏+重绘)
      this.render(rows, sections, focus);
    },
    onKey(cb: (k: KeyEvent) => void): void {
      keyCbs.add(cb);
    },
    emitKey(k: KeyEvent): void {
      for (const cb of keyCbs) cb(k);
    },
    emitCpr(row: number, col: number): void {
      decoder.onCpr?.(row, col);
    },
    async probeSymbolWidths(
      chars: readonly string[],
      timeoutMs = 500,
      rejects?: ProbeReject[],
      voids?: ProbeVoid[],
    ): Promise<Map<string, number>> {
      const widths = new Map<string, number>();
      if (closed || chars.length === 0) return widths;
      // 探测期间隐藏光标（用户 2026-10-12 裁定）：探测报文会把候选字符画在屏幕原点，
      // 光标跟着乱跳很显眼；结束处恢复显示，随后整帧重绘覆盖残留。
      write(CURSOR_HIDE);
      const unique = [...new Set(chars)];
      // 按终端宽度分块：一块写入的字符总宽必须落在同一行内（自动换行会让列差作废）。
      // 按每字符最多 2 列估算，留 1 列余量；典型 80/120 列下一次容纳 39/59 个字符。
      const cols = Math.max(8, screen.getSize().cols);
      const perChunk = Math.max(1, Math.floor((cols - 1) / 2));
      const chunks: string[][] = [];
      for (let i = 0; i < unique.length; i += perChunk) {
        chunks.push(unique.slice(i, i + perChunk));
      }
      const budgetMs = Math.max(30, Math.floor(timeoutMs / chunks.length));
      for (const chunk of chunks) {
        // 单块探测：一次报文写完全部「字符 + CSI 6n」，响应按序到达
        const responses: Array<{ row: number; col: number }> = [];
        const collected = new Promise<void>((resolve) => {
          const onCpr = (row: number, col: number): void => {
            responses.push({ row, col });
            if (responses.length >= chunk.length) {
              clearTimeout(timer);
              cprWaiters.delete(onCpr);
              resolve();
            }
          };
          const timer = setTimeout(() => {
            cprWaiters.delete(onCpr);
            resolve();
          }, budgetMs);
          cprWaiters.add(onCpr);
        });
        let payload = `\x1b[${PROBE_BASELINE_ROW};1H`;
        for (const ch of chunk) payload += ch + "\x1b[6n";
        write(payload);
        await collected;
        // 整块自校验（裁定 ③）：可疑即整块作废 —— 不产出宽度，交由调用方重排队重试
        const voidReason = chunkVoidReason(responses, chunk.length);
        if (voidReason !== null) {
          voids?.push({
            reason: voidReason,
            chars: [...chunk],
            responded: responses.length,
            expected: chunk.length,
          });
        } else {
          // 解析：同一行内相邻 CPR 的列差即字符宽度（基线行与列序已由上面的校验保证）
          let prevCol = 1;
          for (let i = 0; i < responses.length; i++) {
            const { row, col } = responses[i]!;
            const ch = chunk[i]!;
            const delta = col - prevCol; // 仅接受 1 / 2 列，其余留痕退回静态宽度
            if (delta === 1 || delta === 2) widths.set(ch, delta);
            else rejects?.push({ ch, delta, row, col, prevRow: row, prevCol });
            prevCol = col;
          }
        }
        if (closed) break;
        // 块间静默期：迟到的应答（属于上一块的）在无等待者时被丢弃，不会落到下一块的等待者上
        // 造成「相邻字符宽度错位」——应答不带请求标识，只能按到达顺序配对（真漏进来的迟到
        // 应答会让该块判 `short` 而整块重试，不再错配）。仅在还有下一块时等待；代价
        // ≤ `PROBE_SETTLE_MS` × 块数，且只在探测帧发生。
        if (chunk !== chunks[chunks.length - 1]) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, PROBE_SETTLE_MS),
          );
        }
      }
      // 复位光标 + 恢复显示（调用方随后整帧重绘覆盖探测残留）
      write(`\x1b[${PROBE_BASELINE_ROW};1H` + CURSOR_SHOW);
      return widths;
    },
    onResize(cb: (cols: number, rows: number) => void): void {
      resizeCbs.add(cb);
    },
    getSize(): Size {
      return screen.getSize();
    },
    setTheme(id: ThemeId): void {
      theme = themes[id] ?? themes[DEFAULT_THEME];
      screen.setTheme(id);
      prevRows = null; // 使下一帧走全帧重绘，把新背景/调色板画满屏幕
    },
    getTheme(id: ThemeId): ColorTheme {
      return themes[id] ?? themes[DEFAULT_THEME];
    },
    bell(): void {
      screen.beep();
    },
    close(options?: { exit?: boolean }): void {
      if (closed) return;
      closed = true;
      detach(); // 移除退出钩子，防止 close 后再被信号触发
      pasteOff(); // 关闭 bracketed paste（还原终端粘贴行为）
      stdio.removeListener("data", onData);
      stdio.pause(); // 对称：启动时 resume()，关闭时 pause() 释放事件循环持有
      process.stdout.removeListener("resize", onResizeEvt);
      process.removeListener("beforeExit", restore);
      screen.reset(); // 恢复终端默认 SGR，避免残留主题色
      terminal.close();
      // DESIGN：close() = 恢复终端 + 退出事件循环
      // 尊重既有 process.exitCode（BACKLOG TUI#14：冒烟失败已置 1，不能被这里
      // 的硬 exit(0) 覆盖成「看起来通过」；未设置时按 0 正常退出）
      // 退出分流（BACKLOG「非 TUI 行的 HMR 重载不连带退出会话」）：宿主停掉本条目时
      // 调用方显式传 exit:false——终端照常恢复，进程与会话留给宿主重载后重建的实例。
      if (options?.exit ?? exitOnClose) process.exit(process.exitCode ?? 0);
    },
  };
  return renderer;
}

/**
 * 两帧的**变化行游程**（0 基闭区间数组；空数组 = 无变化）。
 * 逐行比较至两帧较长者：行数不同时缺失侧视为「无行」，多出/缺少的行即变化行，
 * 故删除与追加都能落到游程内（区间重写 + 尾部残留清除即可收敛到新帧）。
 *
 * 关键：只把**连续**变化行合成一段，不取「首末跨度」。状态列（最左窄列，纵向贯穿
 * 顶部区域）与活动区（底部流式行）会在同一 tick 同时变化，两者之间大段行其实未变——
 * 取跨度会把整段一起逐行擦除重写（实测 18 行/tick），正是无 DEC2026 同步终端上
 * 可见闪烁与多余字节的直接来源（改游程后同场景 2~3 行/tick）。
 */
function changedRuns(
  a: FrameRow[],
  b: FrameRow[],
  theme: ColorTheme,
  from = 0,
  to = Math.max(a.length, b.length),
): Array<{ first: number; last: number }> {
  const runs: Array<{ first: number; last: number }> = [];
  let start = -1; // 当前游程起点（-1 = 未开始）
  for (let i = from; i < to; i++) {
    const x = a[i];
    const y = b[i];
    const same =
      x !== undefined && y !== undefined
        ? sameRow(x, y, theme)
        : x === undefined && y === undefined;
    if (!same) {
      if (start === -1) start = i;
      continue;
    }
    if (start !== -1) {
      // 命中未变化行 → 封口当前游程（其后变化行另起一段）
      runs.push({ first: start, last: i - 1 });
      start = -1;
    }
  }
  if (start !== -1) runs.push({ first: start, last: to - 1 });
  return runs;
}

/**
 * 按**帧段**切分的变化区间（每段内独立取变化行游程，段内不连续处再各自成区间）；
 * 返回 `null` 表示段表不可用，调用方退化为整帧游程比较。可用条件：新旧段表均存在、
 * 逐段 id/startLine/lineCount 完全一致，且段覆盖帧的全部行——行数或几何变化都会
 * 改变段表，故该校验即几何一致性校验（不满足时按整帧比较，避免漏更新）。
 */
function changedIntervals(
  prevRows: FrameRow[],
  rows: FrameRow[],
  sections: FrameSection[] | undefined,
  prevSections: FrameSection[] | undefined,
  theme: ColorTheme,
): RenderInterval[] | null {
  if (!sections || !prevSections) return null;
  if (sections.length !== prevSections.length) return null;
  let covered = 0;
  for (let i = 0; i < sections.length; i++) {
    const a = sections[i]!;
    const b = prevSections[i]!;
    if (a.startLine !== b.startLine || a.lineCount !== b.lineCount) {
      return null;
    }
    covered += a.lineCount;
  }
  if (covered !== rows.length || covered !== prevRows.length) return null;
  const out: RenderInterval[] = [];
  for (const s of sections) {
    const from = s.startLine;
    const to = s.startLine + s.lineCount;
    for (const { first, last } of changedRuns(
      prevRows,
      rows,
      theme,
      from,
      to,
    )) {
      out.push({ startLine: first + 1, rows: rows.slice(first, last + 1) });
    }
  }
  return out;
}

/**
 * 两行是否相等：按「当前主题下序列化后的行文本」比较（序列化文本即最终上屏字节，
 * 内部实现不对外——SPEC.md §14）。caret 变化(纯光标移动)也阻止 delta 合并。
 */
function sameRow(x: FrameRow, y: FrameRow, theme: ColorTheme): boolean {
  if (x.caret !== y.caret) return false;
  return serializeFrameRow(x, theme) === serializeFrameRow(y, theme);
}
