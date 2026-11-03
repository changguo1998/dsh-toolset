// TUI/src/app/runtime/lifecycle.ts — 生命周期: 启动、退出、空会话清理、宽度探测、响铃、终端过小警告
//
// 2026-11-04 拆分自 TUI/src/app/index.ts 的 App 类体: 方法体只做 this. -> ctx. 改写,
// 跨模块调用经 ctx.self, 公共状态在 ./context.ts.

import type { ProbeReject, ProbeVoid } from "../../renderer/index.ts";
import { writeFileSync } from "node:fs";
import { reduceState, startupCleanableIds } from "../state.ts";
import type { NoticeTone } from "../adapter/types.ts";
import { formatNoticeLine } from "../notice-format.ts";
import { createSections } from "../layout/pipeline/sections.ts";
import {
  charWidth,
  requeueUnmeasuredProbes,
  resetWidthProbeTries,
  setWidthOverrides,
  setWidthProbeEnabled,
  takePendingWidthProbes,
  widthOverrideCodePoints,
} from "../layout/markdown.ts";
import {
  readWidthSymbols,
  writeWidthSymbols,
} from "../layout/width-symbols.ts";
import type { FrameBuildOutput } from "../layout.ts";
import { StatusTicker } from "../status.ts";
import { EXIT_CLEAN_TIMEOUT_MS } from "../exit-guards.ts";
import type { AppContext } from "./context.ts";

/** 帧前实测的超时上限(ms)：探测期间不出帧，故取小值；整批无回包即判定不支持 CPR */
const WIDTH_PROBE_TIMEOUT_MS = 150;

/** 启动预探测（按符号列表）的超时上限（ms）：不设严格限制 —— 宁可多等一点换首帧宽度准 */
const STARTUP_PROBE_TIMEOUT_MS = 1200;

/** 运行中闪烁时间驱动的 tick 周期(ms)：running 期间周期性推进虚拟状态
 *  （无数据时虚拟速度衰减回落、虚拟总 token 持续积分，闪烁频率渐降到最低而不断） */
const VIRT_TICK_MS = 250;

/** 终端过小判据阈值：宽 ≤ SMALL_TERMINAL_COLS 或 高 ≤ SMALL_TERMINAL_ROWS 视为过小 */
export const SMALL_TERMINAL_COLS = 16;

export const SMALL_TERMINAL_ROWS = 9;

/** 终端过小警告文案（不带符号前缀，走既有 notice 渲染） */
export const SMALL_TERMINAL_NOTICE =
  "终端尺寸过小（宽 ≤ 16 或高 ≤ 9），显示可能不可用，请调大窗口";

/** 终端尺寸是否过小（启动与 resize 共用判据；纯函数便于测试） */
export function smallTerminal(size: { cols: number; rows: number }): boolean {
  // 尺寸未知（0）按正常处理、不误报：renderer 侧另有 80×24 回落（见 renderer/terminal.ts）
  if (size.cols <= 0 || size.rows <= 0) return false;
  return size.cols <= SMALL_TERMINAL_COLS || size.rows <= SMALL_TERMINAL_ROWS;
}

export function createLifecyclePart(ctx: AppContext) {
  /**
   * 首帧前载入「呈现不确定」符号列表（`<profile 目录>/tui-width-symbols.json`）：只记
   * **哪些码点值得实测**，宽度不落盘（每次会话重新实测）——换终端 / tmux / 字体 / 字号
   * 因此自动正确（用户 2026-10-12 裁定，见 `src/app/layout/width-symbols.ts`）。
   *
   * `TUI_WIDTH_PROBE=0`：整体关闭按需实测（不读列表、不登记、不探测、不落盘），用于对照
   * 排查「静态表基线」。
   */
  function loadWidthSymbols(): void {
    if (process.env.TUI_WIDTH_PROBE === "0") {
      setWidthProbeEnabled(false);
      return;
    }
    if (ctx.profileDir === "") return;
    ctx.widthSymbols = readWidthSymbols(ctx.profileDir);
  }

  /**
   * 符号列表原子落盘（文件很小、幂等）：列表只是**下次启动的先验**，实测值当次已生效；
   * 写失败静默。`TUI_WIDTH_PROBE=0` 时不写。
   */
  function recordWidthSymbols(): void {
    if (process.env.TUI_WIDTH_PROBE === "0") return;
    if (ctx.profileDir === "" || ctx.widthSymbols.length === 0) return;
    writeWidthSymbols(ctx.profileDir, ctx.widthSymbols);
  }

  /** 新实测到的字符码点并入符号列表并落盘（去重；宽度本身不落盘） */
  function rememberWidthSymbols(chars: Iterable<string>): void {
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      if (cp === undefined || ctx.widthSymbols.includes(cp)) continue;
      ctx.widthSymbols.push(cp);
    }
    recordWidthSymbols();
  }

  /**
   * 临时诊断（`TUI_WIDTH_DUMP=<文件路径>`）：把这一批实测到的宽度写成文本，便于真机上
   * 比对「实测 vs 静态」（排查符号宽度不对；未设开关时零开销、不落盘）。
   */
  function dumpProbeResults(
    widths: Map<string, number>,
    rejects: readonly ProbeReject[] = [],
    voids: readonly ProbeVoid[] = [],
  ): void {
    const path = process.env.TUI_WIDTH_DUMP;
    if (path === undefined || path === "") return;
    const lines: string[] = [];
    for (const [ch, w] of widths) {
      const cp = ch.codePointAt(0) ?? 0;
      lines.push(
        `U+${cp.toString(16).toUpperCase()} ${ch} measured=${w} effective=${charWidth(ch)}`,
      );
    }
    // 被丢弃的列差：列差落在 {1,2} 之外 —— 字符会退回静态宽度、且该码点本轮算漏测
    // （会重新入队，见 probeThenRender 的容错路径）
    for (const r of rejects) {
      const cp = r.ch.codePointAt(0) ?? 0;
      lines.push(
        `REJECT U+${cp.toString(16).toUpperCase()} ${r.ch} delta=${r.delta ?? "跨行"} row=${r.row} col=${r.col} prevRow=${r.prevRow} prevCol=${r.prevCol}`,
      );
    }
    // 整块作废（BACKLOG「字符宽度探测的触发时机」裁定 ③）：该块字符与应答的对应关系
    // 不可信 → 本块零产出并重排队；reason：short 应答数不足 / row 偏离基线行 / back 列倒退
    for (const v of voids) {
      const cps = v.chars
        .map((ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}`)
        .join(",");
      lines.push(
        `VOID reason=${v.reason} responded=${v.responded}/${v.expected} chars=${cps}`,
      );
    }
    try {
      writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    } catch {
      // 诊断写失败不影响运行
    }
  }

  /**
   * 帧前按需实测（用户 2026-10-01 裁定「帧绘制前计算宽度时」）：本帧排版期间登记的
   * 「呈现不确定」字符（markdown.ts `takePendingWidthProbes`）在**写屏前**发一次终端
   * 实测（`CSI 6n` 列差，见 renderer.probeSymbolWidths）。实测值写入覆盖表并重新排版，
   * 随后以**整帧重绘**出帧——探测字符画在屏幕原点，由这一帧覆盖；且这一帧即按实测宽度排版。
   *
   * 只在**首帧之外**发生（启动时首帧先出、帧后合并一轮，见 `probingSuspended` 与
   * `probeSymbolsAtStartup`）；发起前经过 `probePendingWidths` 的单飞守卫。
   *
   * 整批零应答 → 判定终端不支持 CPR，关闭后续实测（否则每个新字符都要白等一次超时）；
   * 有应答但**整块作废**（应答数不足 / 行号偏离基线 / 列倒退）不算不支持——该块字符按
   * 漏测处理，重新入队重试（裁定 ③）。探测期间不出帧（上限 `WIDTH_PROBE_TIMEOUT_MS`），
   * 故只在出现新字符的帧上发生。
   */
  function probeThenRender(
    batch: readonly string[],
    timeoutMs = WIDTH_PROBE_TIMEOUT_MS,
  ): void {
    const probe = ctx.deps.renderer.probeSymbolWidths;
    if (typeof probe !== "function") return;
    ctx.widthProbeInFlight = true;
    const rejects: ProbeReject[] = []; // 诊断：被丢弃的列差（仅 TUI_WIDTH_DUMP 落盘）
    const voids: ProbeVoid[] = []; // 诊断：被整块作废的批次（同上）
    void probe
      .call(ctx.deps.renderer, batch, timeoutMs, rejects, voids)
      .then((widths) => {
        ctx.widthProbeInFlight = false;
        if (ctx.disposed) return;
        // 「有应答」包括被拒的列差与被作废的整块：只有**零应答**才说明终端不支持 CPR
        const answered =
          widths.size > 0 || rejects.length > 0 || voids.length > 0;
        if (!answered) {
          ctx.widthProbeUnavailable = true; // 无 CPR 支持：沿用静态表，不再实测
        } else if (setWidthOverrides(widths)) {
          // 新实测到的码点并入符号列表（宽度不落盘）：列表 = 下次启动预探测的先验
          rememberWidthSymbols(widths.keys());
        }
        dumpProbeResults(widths, rejects, voids); // 临时诊断（TUI_WIDTH_DUMP）
        // /detect-char-width：手动重测完成 → 回一条结果提示（尺寸变化触发的重测不提示）
        if (ctx.widthReprobeNotice) {
          ctx.widthReprobeNotice = false;
          ctx.self.notice(
            `字符宽度实测完成：本轮测得 ${widths.size} 个字符（未测到 ${batch.length - widths.size} 个）`,
            widths.size > 0 ? "success" : "warn",
          );
        }
        // 容错：本轮**没测到**的字符重新入队（每码点最多重试 WIDTH_PROBE_MAX_TRIES 次）——
        // 漏测（无应答 / 列差异常 / 整块作废）不再等于本会话永久沿用静态宽度
        if (answered) {
          const measured = new Set(
            [...widths.keys()].map((ch) => ch.codePointAt(0) ?? 0),
          );
          requeueUnmeasuredProbes(
            batch
              .map((ch) => ch.codePointAt(0) ?? 0)
              .filter((cp) => !measured.has(cp)),
          );
        }
        ctx.self.refresh(); // 重排 + 整帧重绘：按实测宽度出这一帧并覆盖探测残留
        probePendingWidths(); // 重排可能登记了新字符（未测到 / 重试额度未用尽仍会入队）
      })
      .catch(() => {
        ctx.widthProbeInFlight = false;
        if (!ctx.disposed) ctx.self.refresh();
      });
  }

  /**
   * 单飞发起口（裁定 ④，BACKLOG「字符宽度探测的触发时机」）：取走待测队列整批实测。
   * 四个入口（按需 / 启动 / 尺寸变化 / `/detect-char-width`）都只经这里发起，故并发批次
   * 不可能出现——在途 / 终端不支持 / 启动首帧（`probingSuspended`）时一律不动。
   *
   * 返回是否**已发起**：`renderFrame` 据此跳过本帧写屏（本帧由实测后的整帧重绘产出）。
   */
  function probePendingWidths(timeoutMs = WIDTH_PROBE_TIMEOUT_MS): boolean {
    if (ctx.widthProbeInFlight || ctx.widthProbeUnavailable) return false;
    if (ctx.probingSuspended) return false;
    if (typeof ctx.deps.renderer.probeSymbolWidths !== "function") return false;
    const batch = takePendingWidthProbes();
    if (batch.length === 0) return false;
    probeThenRender(batch, timeoutMs);
    return true;
  }

  /**
   * 重新实测已生效的宽度覆盖（尺寸变化 / `/detect-char-width` 共用）：
   * 终端对「呈现不确定」字符的解析随终端/字体/tmux 客户端而变（真机症状见 BACKLOG #1），
   * 故重置尝试额度后把**已实测的码点**重新入队；在途探测由 `probePendingWidths`
   * 的在途守卫合并（连续 resize 只在当前批结束后再发下一批）。
   */
  function reprobeWidths(extraCodePoints: Iterable<number> = []): number {
    resetWidthProbeTries();
    const queued = requeueUnmeasuredProbes([
      ...widthOverrideCodePoints(),
      ...extraCodePoints,
    ]);
    if (queued > 0) probePendingWidths();
    return queued;
  }

  /**
   * 启动轮实测（裁定 ②，BACKLOG「字符宽度探测的触发时机」）：首帧**之后**把「首帧排版
   * 登记的字符」与「符号列表先验」合并成**一轮**实测，再重排 + 整帧重绘覆盖探测残留。
   *
   * 不放在首帧之前：那时 alt screen / 尺寸尚未落定，CPR 报的列差会错（实测出错的宽度）、
   * 探测残留也没有帧覆盖（用户 2026-10-12 定稿）。首帧也**不再**单独按需探测：否则首帧被
   * 吞（屏幕空等一次超时），且紧接着本轮并发跟发、两轮应答互相串台（裁定 ②）。
   */
  function probeSymbolsAtStartup(): void {
    if (ctx.widthProbeInFlight || ctx.widthProbeUnavailable) return;
    if (typeof ctx.deps.renderer.probeSymbolWidths !== "function") return;
    // 列表先验并入待测队列（与首帧排版登记的字符合并成同一批；去重、受尝试额度与队列上限约束）
    if (ctx.widthSymbols.length > 0) {
      requeueUnmeasuredProbes(ctx.widthSymbols);
    }
    probePendingWidths(STARTUP_PROBE_TIMEOUT_MS);
  }

  function start(): void {
    // 恢复会话：启动历史折叠会整表替换 buffer → 早到的外部日志先挂起（落定后补发，见
    // flushKickoffPending）。必须在总线接线（会触发插件侧重放）之前置位。
    if (ctx.deps.adapter.resumedAtLaunch === true) ctx.bootLogPending = [];
    // 六步流水线：仅在「开关开启 + 调用方给了 sink」时接管（缺 sink = 未装配 → 旧路径，
    // 测试与嵌入用法不受默认切换影响）
    const sink = ctx.deps.pipelineSink;
    if (sink !== undefined) {
      ctx.sections = createSections();
      ctx.groupCount = null; // 会话切换（BACKLOG #24②）：窗口基线随会话重建
      ctx.sectionsSessionId = ctx.state.activeSessionId;
      // 宿主 / adapter 的实时投递：notice 文本在此补统一前缀（`[hh:mm:ss 来源] 正文`）；
      // 本地写入（App.notice / 恢复重放）自己已格式化或属历史记录，不再经过本口。
      sink.current = (delivery) =>
        ctx.self.ingestDelivery(
          delivery.kind === "notice"
            ? { ...delivery, text: formatNoticeLine(delivery.text, Date.now()) }
            : delivery,
        );
      const pipeline = ctx.sections;
      // 内容单源：注入节缓存（条目 16 段 C2 后这是唯一内容来源）
      ctx.self.apply((s) =>
        reduceState(s, { type: "pipeline-state", pipeline }),
      );
    }
    // 告警总线懒接线（未挂载则 no-op；见 ruleEngine()）
    ctx.self.ruleEngine();
    ctx.deps.renderer.onKey((k) => ctx.self.handleKey(k));
    // 尺寸变化重跑检测（决策细节 2）：仍过小 → 再置一次警告；够大 → 不动（不清旧警告）
    ctx.deps.renderer.onResize(() => {
      warnIfSmallTerminal();
      // 尺寸/客户端变化可能改变终端的宽度解析（真机症状见 BACKLOG #1）→ 已实测的码点重测
      reprobeWidths();
      ctx.self.paint();
    });
    ctx.unbindEvents.push(
      ctx.deps.adapter.onEvent((e) => ctx.self.handleEvent(e)),
    );
    // 状态行：合并节流 ticker（tick 一次批量查 cwd/git/time）
    if (ctx.deps.status) {
      ctx.statusTicker = new StatusTicker({
        queries: ctx.deps.status.queries,
        intervalMs: ctx.deps.status.intervalMs ?? 1000,
        ...(ctx.deps.status.schedule === undefined
          ? {}
          : { schedule: ctx.deps.status.schedule }),
        apply: (status) => {
          ctx.self.apply((s) => reduceState(s, { type: "status", status }));
          ctx.self.paint();
          // 随 ticker 周期刷新生效模型(会话切换 ?? 宿主默认)：宿主 provider 注册
          // 可能晚于启动，早读会拿到内置兜底(如 deepseek-official)，故常驻跟随，
          // 值变化才重绘。与 /model 显示同一来源。
          ctx.self.refreshModelStatus();
          // TUI#39：Agents 块同节律保鲜（状态列隐藏时自动停；不依赖事件面，空数据也轮询）
          ctx.self.maybeRefreshAgents();
          // TUI#48：会话别名同节律保鲜（无插件 / 无别名时不动状态）
          void ctx.self.maybeRefreshSessionAlias();
        },
      });
      ctx.statusTicker.start();
      ctx.unbindEvents.push(() => ctx.statusTicker?.stop());
    }
    // 运行中闪烁时间驱动（250ms tick）：仅 inputStatus=running 时推进（见 virtTick
    // 方法）。unref：不阻止测试进程退出（node --test 下 interval 会让事件循环挂住）。
    ctx.virtTimer = setInterval(() => ctx.self.virtTick(), VIRT_TICK_MS);
    ctx.virtTimer.unref?.();
    ctx.unbindEvents.push(() => {
      if (ctx.virtTimer) clearInterval(ctx.virtTimer);
      ctx.virtTimer = null;
    });
    // 审批倒计时重绘定时器（按需创建，见 syncApprovalTicker）：随生命周期统一清理
    ctx.unbindEvents.push(() => {
      if (ctx.approvalTimer) clearInterval(ctx.approvalTimer);
      ctx.approvalTimer = null;
    });
    // 首帧前载入「呈现不确定」符号列表（profile 目录；宽度不落盘）。
    // 本次会话新出现的「呈现不确定」字符在帧绘制前按需实测（见 probeThenRender）
    loadWidthSymbols();
    // 首帧前同步 renderer 主题（基底色/词槽位随 /theme 切换）
    ctx.deps.renderer.setTheme(ctx.state.themeId);
    // 首帧之后按列表预探测（宽度只存内存）：首帧前屏幕未就绪会测错宽度、残留也没帧覆盖
    // （见 probeSymbolsAtStartup）；无列表 / 终端不支持 CPR 时它自己早退
    // 启动即过小 → 首帧前只置状态（决策 1a）：警告随首帧就位，不额外多绘一帧
    warnIfSmallTerminal();
    // 首帧先出（裁定 ②）：首帧若也按需探测，屏幕会先空等至多 WIDTH_PROBE_TIMEOUT_MS，
    // 且紧接着的启动轮并发跟发 → CPR 应答串台、错值留存。故首帧只出帧：帧内登记的字符
    // 留在队列里，由 probeSymbolsAtStartup 合并成一轮实测。
    ctx.probingSuspended = true;
    try {
      ctx.self.paintNow();
    } finally {
      ctx.probingSuspended = false;
    }
    probeSymbolsAtStartup();
    // 拉取权限/agent 预设目录写入 state（原状态列 Mode 块的可选项，P7 移除该块后
    // 暂无渲染消费方；缺默服务则保持降级）
    ctx.self.refreshCatalogs();
    // 拉取宿主命令注册表目录（输入补全候选；服务缺失时仅本地目录）
    ctx.self.refreshCommandCatalog();
    // 探测宿主文件提及服务（`@` 补全开关；缺失时 `@` 按普通字符输入）
    ctx.self.refreshFileMention();
    // 补会话状态初始值（标题栏状态符号组用；log-only 事件启动不产生，从会话日志折叠一次）
    ctx.self.restoreSessionState();
    // 启动自检 kickoff（BACKLOG TUI「启动后自动触发首轮工具调用」）：先挂起，再由下面的
    // 历史折叠决定发送时机（新会话走启动宏任务；恢复会话等折叠落定，见 flushKickoffPending）
    ctx.self.startBootstrapKickoff();
    // TUI#40：CLI 启动即恢复（--resume / -c）→ 补一次历史折叠，会话区直接可见既有消息
    ctx.self.restoreStartupHistory();
    // 启动自动清理空会话（session.autoCleanEmpty=true 时后台执行，不阻塞 UI）
    if (ctx.autoCleanEmpty) {
      void runStartupCleanEmptySessions();
    }
  }

  /**
   * 列出全部会话并返回可清理的空会话 id（判据 startupCleanableIds：已持久化 + 非 live +
   * 非当前 + 无用户消息）。列表服务缺失或读取失败 → 空数组（不抛，不阻碍调用方）。
   */
  async function cleanableSessionIdsViaAdapter(): Promise<string[]> {
    const list = ctx.deps.adapter.listSessions;
    if (!list) return [];
    try {
      return startupCleanableIds(await list.call(ctx.deps.adapter));
    } catch {
      return []; // 列表不可用 → 不清理
    }
  }

  /**
   * 逐个文件级删除给定会话（串行，避免并发 IO 与错误归属混乱），返回成功/失败计数。
   * 删除服务缺失时不删任何项（返回 0/0）。
   */
  async function deleteSessionIds(
    ids: string[],
  ): Promise<{ removed: number; failed: number }> {
    const del = ctx.deps.adapter.deleteSession;
    if (!del) return { removed: 0, failed: 0 };
    let removed = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const res = await del.call(ctx.deps.adapter, id);
        if (res.ok) removed += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    return { removed, failed };
  }

  /**
   * 启动时自动清理空会话（session.autoCleanEmpty=true）：与退出清理共享判据与删除核心，
   * 结果经 notice 汇报（UI 尚在，走会话区提示）。依赖宿主 sessionQuery
   * （listSessions/deleteSession）已挂载；缺失或执行失败静默跳过（清理属于维护性功能，
   * 不让启动失败）。当前活跃/live 会话由判据天然排除。
   */
  async function runStartupCleanEmptySessions(): Promise<void> {
    const ids = await cleanableSessionIdsViaAdapter();
    if (ids.length === 0) return;
    const { removed, failed } = await deleteSessionIds(ids);
    if (removed === 0) {
      // 全部失败才提示（避免静默）；部分成功走下方成功文案
      if (failed > 0) {
        ctx.self.notice(`自动清理空会话失败：${failed} 个删除未生效`, "warn");
      }
      return;
    }
    ctx.self.notice(
      failed > 0
        ? `已自动清理 ${removed} 个空会话（${failed} 个失败）`
        : `已自动清理 ${removed} 个空会话`,
      failed > 0 ? "warn" : "success",
    );
  }

  /**
   * 退出时清理其他空会话（复用 session.autoCleanEmpty 开关；优雅退出路径在关渲染器前调用）。
   * 有可清理项才把提示渲染到**回合区**并等待清理完成，完成后才继续后续收尾（释放 adapter/
   * 关闭渲染器退出）；无清理项/无可清理服务时静默直接返回，不拖慢退出。
   */
  async function runExitCleanEmptySessions(): Promise<void> {
    const ids = await cleanableSessionIdsViaAdapter();
    if (ids.length === 0) return;
    const t0 = Date.now();
    paintExitNotice(`正在清理 ${ids.length} 个空会话...`, "info");
    const { removed, failed } = await deleteSessionIds(ids);
    const elapsed = Date.now() - t0;
    if (removed === 0) {
      paintExitNotice(`清理空会话失败：${failed} 个删除未生效`, "error");
      return;
    }
    paintExitNotice(
      `已自动清理 ${removed} 个空会话` +
        (failed > 0 ? `（${failed} 个失败）` : "") +
        `（${elapsed}ms）`,
      failed > 0 ? "warn" : "success",
    );
  }

  /**
   * 退出清理提示：绕过 disposed 守卫与 10Hz 合帧，把消息直接渲染到回合区。
   * dispose() 已置 disposed=true（常规 notice/paint 均被守卫拦截），且主接线
   * frameIntervalMs>0 时标脏可能被窗口定时器推迟到关终端之后——此处同步 apply + render，
   * 保证提示在 close() 前真实落屏。
   */
  function paintExitNotice(text: string, tone?: NoticeTone): void {
    const shown = formatNoticeLine(text, Date.now());
    ctx.state = reduceState(ctx.state, {
      type: "notice",
      text: shown,
      ...(tone ? { tone } : {}),
    });
    // 双写：流水线节缓存（与 `notice()` 同口径）。缺了它，注册 sink 后内容不再写缓冲 →
    // 退出清理提示永远不上屏（条目 16 段 C1 暴露；生产 main.ts 恒注入 sink，真机同样中招）
    ctx.self.deliverLocal({
      kind: "notice",
      text: shown,
      ...(tone ? { tone } : {}),
    });
    const size = ctx.deps.renderer.getSize();
    const out: FrameBuildOutput = {};
    const frame = ctx.self.layoutFrame(size, out);
    ctx.deps.renderer.render(frame, out.sections, out.focus);
  }

  /** 释放 App（收尾落盘 → 释放 adapter → 渲染器 close）。
   *  `options.exit === false` = 宿主停掉本条目（HMR / 插件重载）的卸载路径：只恢复终端，
   *  不结束进程、不跑退出式空会话清理（宿主随后会按新配置重建本行，会话由新实例接回）。
   *  用户退出路径（`/quit`、确认面板、`/restart`、`/cleanquit`）不传选项，行为与之前一致。 */
  function dispose(options?: { exit?: boolean }): void {
    if (ctx.disposed) return;
    // 退出前落盘会话状态快照（未过合并窗口的变更不丢）
    ctx.self.flushSessionStateSave();
    ctx.disposed = true;
    // 待处理合帧作废：已排队的 microtask 见 disposed 直接返回，不再写终端
    ctx.paintDirty = false;
    ctx.paintScheduled = false;
    for (const f of ctx.unbindEvents) f();
    ctx.unbindEvents = [];
    ctx.symbolUnsubscribe?.();
    ctx.symbolUnsubscribe = null;
    ctx.ruleEngineUnsubscribe?.();
    ctx.ruleEngineUnsubscribe = null;
    ctx.self.stopPanelRefresh();
    clearInteractiveBell();
    ctx.self.clearFrameTimer();
    ctx.self.cancelMentionRequest();
    // 退出时清理其他空会话（复用 session.autoCleanEmpty 开关）：开启时先打印提示并等待
    // 清理完成，再释放 adapter/关闭渲染器退出；关闭或无可清理服务时保持同步收尾。
    // 注意：仅优雅退出路径（/quit、Ctrl+D、双击 Ctrl+C）覆盖——信号强退
    // （SIGINT/SIGTERM）与崩溃路径由 renderer 直接 process.exit，无法可靠等待异步 IO。
    // 「重启 dsh」路径（restartPending）跳过清理：重启不该改动其它会话（BACKLOG #51）。
    // 宿主卸载（exit:false）同样跳过：它不再是「退出」，异步清理会与重建后的实例抢写。
    if (!ctx.autoCleanEmpty || ctx.restartPending || options?.exit === false) {
      finishDispose(options?.exit);
      return;
    }
    void disposeWithExitClean();
  }

  /** 收尾释放：适配器 →（「清理并退出」时）删当前会话 → 渲染器（close 恢复终端并按需退出）。
   *  `exit === false` 透传给 renderer（只恢复终端、不结束进程）。 */
  function finishDispose(exit?: boolean): void {
    ctx.deps.adapter.dispose?.();
    if (ctx.cleanQuitPending) deleteActiveSessionForExit();
    ctx.deps.renderer.close(exit === false ? { exit: false } : undefined);
  }

  /** 「清理并退出」的删除步骤：只在 `adapter.dispose()` 之后调用（handle 已释放，删目录
   *  不会被并发写入）。失败只告警、不阻断退出；无活跃会话或宿主无会话服务时同样只告警。 */
  function deleteActiveSessionForExit(): void {
    const id = ctx.state.activeSessionId ?? ctx.deps.adapter.sessionId ?? "";
    const del = ctx.deps.adapter.deleteSessionForExit;
    if (id === "" || del === undefined) {
      paintExitNotice("清理并退出：会话服务不可用，未删除本会话", "warn");
      return;
    }
    const outcome = del.call(ctx.deps.adapter, id);
    paintExitNotice(
      outcome.ok
        ? "已删除本会话的记录与历史"
        : `删除本会话失败：${outcome.reason}`,
      outcome.ok ? "success" : "error",
    );
  }

  /** autoCleanEmpty 开启时的退出收尾：等待清理完成（含超时兜底）后再 finishDispose。 */
  async function disposeWithExitClean(): Promise<void> {
    let timedOut = false;
    try {
      await Promise.race([
        runExitCleanEmptySessions(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, EXIT_CLEAN_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      paintExitNotice(`退出清理异常：${String(err)}`, "error");
    }
    if (timedOut) {
      paintExitNotice("清理空会话超时，放弃等待", "warn");
    }
    finishDispose();
  }

  // ---------- 声音提醒（P2#33） ----------

  /** 响铃一次（bell 总开关 + 已释放双检查）：turn-end 与「需交互」事件共用（BACKLOG 3.4.1） */
  function ringBell(): void {
    if (!ctx.bellEnabled || ctx.disposed) return;
    ctx.deps.renderer.bell?.();
  }

  /** turn-end 钩子：任务运行结束只响一声（BACKLOG 3.4.2——原「随后 idle 补响一次」已去掉，
   *  一次 run 结束不再听到两声；「需交互而未应答」的催促改由 3.4.3 的交互响铃承担）。 */
  function onTurnEnded(): void {
    ringBell();
  }

  /** 需交互开始（BACKLOG 3.4.1 + 3.4.3）：审批 / 问答面板弹出即响一声，并启动「无操作
   *  超阈值」计时；超阈值仍无操作 → 每秒响一次，直到用户有操作或面板关闭。
   *  一次交互内最多进入一次：任意按键（handleKey 入口）即停止且不重启。 */
  function beginInteractiveBell(): void {
    if (!ctx.bellEnabled || ctx.disposed) return;
    ringBell();
    clearInteractiveBell();
    ctx.pendingBellTimer = setTimeout(() => {
      ctx.pendingBellTimer = null;
      if (!ctx.bellEnabled || ctx.disposed) return;
      ctx.repeatBellTimer = setInterval(() => ringBell(), 1000);
    }, ctx.idleBellMs);
  }

  /** 停止需交互响铃（任意按键 / 面板关闭 / dispose）：清计时器，且同一次交互不再重启 */
  function clearInteractiveBell(): void {
    if (ctx.pendingBellTimer) {
      clearTimeout(ctx.pendingBellTimer);
      ctx.pendingBellTimer = null;
    }
    if (ctx.repeatBellTimer) {
      clearInterval(ctx.repeatBellTimer);
      ctx.repeatBellTimer = null;
    }
  }

  /**
   * 终端过小警告（BACKLOG〈启动时终端尺寸过小警告〉）：过小 → 弹一条 warning notice；
   * 够大 → 什么都不做（不清旧警告，见决策细节 2）。
   *
   * 走 `notice()`（= 置状态 + 写流水线通知节）而非只置状态：流水线下回合区只渲染节缓存，
   * 只写 `state.local` 的 notice **在真机不可见**（见追踪文档「计划外偏差」）。首帧路径上紧接
   * `paintNow()` 会清掉这里的待绘标记，故不多绘一帧。
   */
  function warnIfSmallTerminal(): void {
    if (!smallTerminal(ctx.deps.renderer.getSize())) return;
    ctx.self.notice(SMALL_TERMINAL_NOTICE, "warn");
  }

  return {
    loadWidthSymbols,
    recordWidthSymbols,
    rememberWidthSymbols,
    dumpProbeResults,
    probeThenRender,
    probePendingWidths,
    reprobeWidths,
    probeSymbolsAtStartup,
    start,
    cleanableSessionIdsViaAdapter,
    deleteSessionIds,
    runStartupCleanEmptySessions,
    runExitCleanEmptySessions,
    paintExitNotice,
    dispose,
    finishDispose,
    deleteActiveSessionForExit,
    disposeWithExitClean,
    ringBell,
    onTurnEnded,
    beginInteractiveBell,
    clearInteractiveBell,
    warnIfSmallTerminal,
  };
}
