// TUI/src/app/runtime/commands.ts — slash 分派与本地 / UI 命令: /help、主题、详略、符号、宽度、/stats
//
// 2026-11-04 拆分自 TUI/src/app/index.ts 的 App 类体: 方法体只做 this. -> ctx. 改写,
// 跨模块调用经 ctx.self, 公共状态在 ./context.ts.

import type { ActivityCategory } from "../state.ts";
import { reduceState } from "../state.ts";
import { createSections } from "../layout/pipeline/sections.ts";
import { parseSlashCommand } from "../adapter/dsh.ts";
import { routeSlashCommand, themeCommandDecision } from "../commands.ts";
import { helpTableLines, sortHelpRows } from "../layout.ts";
import type { ThemeId } from "../../renderer/theme.ts";
import type { AppContext } from "./context.ts";

/** 回合区三类开关的解析（`/verbose` 与 `/collapse` 共用）。 */
const ACTIVITY_CATEGORIES: readonly ActivityCategory[] = [
  "think",
  "tool",
  "reply",
];

/**
 * 解析 `[think|tool|reply|all] [on|off]`；`all` = 三类同时设置。
 * 缺参 / 非法值返回空对象（调用方回用法）。
 */
function parseActivitySwitch(
  line: string,
  command: string,
): { categories?: ActivityCategory[]; on?: boolean } {
  const parts = line.slice(command.length).trim().toLowerCase().split(/\s+/);
  const category = parts[0];
  const value = parts[1];
  if (category === undefined) return {};
  if (value !== "on" && value !== "off") return {};
  if (category === "all") {
    return { categories: [...ACTIVITY_CATEGORIES], on: value === "on" };
  }
  if (!ACTIVITY_CATEGORIES.includes(category as ActivityCategory)) return {};
  return { categories: [category as ActivityCategory], on: value === "on" };
}

/** 三类开关的当前值（usage 提示用）。 */
function formatActivitySwitches(switches: {
  think: boolean;
  tool: boolean;
  reply: boolean;
}): string {
  return ACTIVITY_CATEGORIES.map(
    (c) => `${c} ${switches[c] ? "on" : "off"}`,
  ).join(" / ");
}

export function createCommandsPart(ctx: AppContext) {
  /**
   * Slash 命令路由：
   *  - 渲染相关命令(/help /clearscreen /cls /quit)→ 本地小命令表
   *  - 其他 /name → adapter.runCommand → commands 注册表调用(官方机制)
   *  - 未命中注册表 → adapter 侧 notice 提示(fail-close，绝不经 sendMessage)
   */
  function handleSlash(line: string): void {
    const name = parseSlashCommand(line);
    if (!name) {
      ctx.self.shortNotice("无效命令: " + line, "error");
      // 本地可检测的无效 slash 命令 → 失败色(红)
      ctx.self.apply((s) =>
        reduceState(s, { type: "input-status", status: "failure" }),
      );
      return;
    }
    // 已识别 slash 命令（本地成功或注册表 dispatch）→ 成功色(绿)
    ctx.self.apply((s) =>
      reduceState(s, { type: "input-status", status: "success" }),
    );
    switch (routeSlashCommand(name)) {
      case "help":
        {
          const lines = helpLines();
          ctx.self.apply((s) =>
            reduceState(s, { type: "notice", text: "", lines }),
          );
          // 条目 7 选项 1：/help 是唯一不经 `notice()` 的本地提示——内容单源是节缓存，
          // 只写缓冲的话生产路径（已注入 sink）什么都看不到。悬挂缩进与紧凑豁免随交付带上
          const hanging = lines.find((l) => l.hanging !== undefined)?.hanging;
          ctx.self.deliverLocal({
            kind: "notice",
            text: lines.map((l) => l.text).join("\n"),
            ...(hanging === undefined ? {} : { hanging }),
            noCompact: true,
          });
          return;
        }
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "notice",
            text: "",
            lines: helpLines(),
          }),
        );
        return;
      case "clearscreen": {
        ctx.self.apply((s) => reduceState(s, { type: "clear-buffer" }));
        // 节缓存同源清空（条目 7 选项 1 回归）：生产路径内容单源是节缓存，`clearBuffer`
        // 只把 `state.pipeline` 换成新对象，App 手里的接收层仍是旧内容 → 下一次交付
        // 会把清掉的内容原样带回来（真机复现：`/cls` 后新事件一到旧正文全回来了）
        if (ctx.deps.pipelineSink !== undefined) {
          const pipeline = createSections();
          ctx.sections = pipeline;
          ctx.sectionsSessionId = ctx.state.activeSessionId;
          ctx.pipelineLastTurn = null;
          ctx.pipelineSepPending = false;
          ctx.pipelineAnyContent = false;
          ctx.self.apply((s) =>
            reduceState(s, { type: "pipeline-state", pipeline }),
          );
        }
        return;
      }
      case "cleanquit":
        // /cleanquit：删除不可逆，先弹合成确认面板；确认后走 requestCleanQuit()
        ctx.self.openCleanQuitConfirm();
        return;
      case "quit":
        // 走 App.dispose：释放 adapter 与当前活跃 handle（含 resume 后由 adapter
        // 持有的新 handle），再恢复终端退出
        ctx.self.dispose();
        return;
      case "restart":
        // /restart：与退出确认面板第三项同路径（写交接文件 → 退出码 75 → 收尾）
        ctx.self.handleRestartCommand();
        return;
      case "model":
        void ctx.self.handleModelCommand(line);
        return;
      case "provider":
      case "effort":
        // 带参直接切换对应字段（provider / effort）；无参打开 /model 面板并把焦点列预置
        void ctx.self.handleModelFocus(name, line);
        return;
      case "theme":
        handleThemeCommand(line);
        return;
      case "collapse":
        handleCollapseCommand(line);
        return;
      case "verbose":
        // BACKLOG #8：/verbose 改为回合区**输出内容**档位（think / tool / step）
        handleVerboseLevelCommand(line);
        return;
      case "symbol-unify":
        handleSymbolUnifyCommand(line);
        return;
      case "detect-char-width":
        handleDetectCharWidthCommand();
        return;
      case "session":
        // 会话列表 + 切换：见 openHistory / resumeToSession；
        // 子命令 clean：打开面板并直达「清理当前项目空会话」二次确认
        if (line.slice("/session".length).trim().toLowerCase() === "clean") {
          void ctx.self.openHistoryClean();
        } else {
          void ctx.self.openHistory();
        }
        return;
      case "continue":
        // TUI#1：加载当前目录下最近退出的会话（复用 /session 的加载路径）
        void ctx.self.continueRecentSession();
        return;
      case "policy":
        ctx.self.handlePolicyCommand(line);
        return;
      case "permission":
        ctx.self.handlePermissionCommand(line);
        return;
      case "jobs":
        ctx.self.handleJobsCommand();
        return;
      case "init":
        ctx.self.runInit();
        return;
      case "stats":
        handleStatsCommand();
        return;
      case "rename":
        ctx.self.handleRenameCommand(line);
        return;
      case "skills":
        ctx.self.handleSkillsCommand(line);
        return;
      case "agents":
        // agents 无 filter：直接开面板并拉列表
        ctx.self.openListPanel({
          kind: "agents",
          label: "subagents",
          refresh: ctx.deps.adapter.refreshAgents,
          filter: "",
        });
        return;
      case "tools":
        ctx.self.handleToolsCommand(line);
        return;
      case "settings":
        ctx.self.handleSettingsCommand();
        return;
      case "config":
        ctx.self.handleConfigCommand(line);
        return;
      case "new":
        ctx.self.startNewSession();
        return;
      case "fork":
        ctx.self.handleForkCommand();
        return;
      case "task":
        ctx.self.handleTaskCommand();
        return;
      case "guard":
        ctx.self.handleGuardCommand();
        return;
      case "memory":
        ctx.self.handleMemoryCommand(line);
        return;
      case "loop":
        ctx.self.handleLoopCommand();
        return;
      case "group":
        ctx.self.handleGroupCommand(line);
        return;
      case "contract":
        ctx.self.handleContractCommand();
        return;
      case "workflows":
        ctx.self.handleWorkflowsCommand();
        return;
      case "council":
        ctx.self.handleCouncilCommand(line);
        return;
      case "search":
        ctx.self.handleSearchCommand(line);
        return;
      case "copy":
        ctx.self.copyLastReply();
        return;
      case "registry":
        // 非本地命令 → 注册表调用
        ctx.deps.adapter.runCommand(
          line,
          ctx.state.activeSessionId ?? undefined,
        );
    }
  }

  /**
   * 就地切换主题（等价 /theme 的落地动作，不打印提示）：状态 + renderer 调色板 + 重绘。
   * 供 profile 配置热更新（cordis `internal/update` 钩子）调用——配置里改 theme 时无需
   * 重建 App/renderer（重建会走插件卸载路径并把 dsh 进程一起带退出）。
   */
  function applyTheme(id: ThemeId): void {
    if (id === ctx.state.themeId) return;
    ctx.self.apply((s) => reduceState(s, { type: "set-theme", themeId: id }));
    ctx.deps.renderer.setTheme(id);
    ctx.self.paint();
  }

  /** /theme 命令：无参/toggle 在 dark|light 间切换；带参显式设置；非法参数提示 usage */
  function handleThemeCommand(line: string): void {
    const cur = ctx.state.themeId;
    const decision = themeCommandDecision(line, cur);
    if (decision.kind === "usage") {
      ctx.self.notice("usage: /theme [light|dark|toggle]", "info");
      return;
    }
    const next = decision.theme;
    if (next !== cur) applyTheme(next);
    ctx.self.notice(
      `theme: ${next} (${ctx.deps.renderer.getTheme?.(next)?.name ?? next})`,
      "success",
    );
  }

  /**
   * /collapse on|off：回合区详略切换（SPEC §6.8 两态）。
   * on = 紧凑（状态 2：每条目 1 行 + 行尾省略号）；off = 每条目完整折行（状态 1，缺省）。
   * 无参数/非法参数 → 只提示用法与当前状态，不切换。
   */
  /**
   * `/collapse [think|tool|reply] [on|off]`：回合区**压缩开关**（按类别）。
   * on = 该类条目压 1 行 + 行尾省略号；off = 完整折行。无参 / 非法参数只提示用法与当前值。
   */
  function handleCollapseCommand(line: string): void {
    const { categories, on } = parseActivitySwitch(line, "/collapse");
    if (categories === undefined || on === undefined) {
      ctx.self.notice(
        `usage: /collapse [think|tool|reply|all] [on|off]（当前：${formatActivitySwitches(ctx.state.activityCompact)}）`,
        "info",
      );
      return;
    }
    ctx.self.apply((s) =>
      reduceState(s, { type: "activity-compact", categories, on }),
    );
    ctx.self.paint();
    ctx.self.scheduleSessionStateSave();
    const label =
      categories.length === ACTIVITY_CATEGORIES.length
        ? "all"
        : categories.join(",");
    ctx.self.notice(
      `回合区压缩：${label} → ${on ? "on（压 1 行）" : "off（完整折行）"}`,
      "success",
    );
  }

  /**
   * `/verbose think|tool|step`：回合区**输出内容**档位（BACKLOG #8；只作用于回合区）。
   * think = 思考 + 正文 + 工具调用（全量，缺省）；tool = 正文 + 工具调用（去思考）；
   * step = 正文 + 工具调用的**调用行**（去结果行 / 辅助行；step 头与 notice 保留）。
   * 无参数 / 非法参数 → 只提示用法与当前档位，不切换（沿用既有口径）。
   */
  /**
   * `/verbose [think|tool|reply] [on|off]`：回合区**显示开关**（按类别）。
   * on = 显示该类内容；off = 不显示（notice 与 step 头恒显）。无参 / 非法参数只提示用法与当前值。
   */
  function handleVerboseLevelCommand(line: string): void {
    const { categories, on } = parseActivitySwitch(line, "/verbose");
    if (categories === undefined || on === undefined) {
      ctx.self.notice(
        `usage: /verbose [think|tool|reply|all] [on|off]（当前：${formatActivitySwitches(ctx.state.activityShow)}）`,
        "info",
      );
      return;
    }
    ctx.self.apply((s) =>
      reduceState(s, { type: "activity-show", categories, on }),
    );
    ctx.self.paint();
    ctx.self.scheduleSessionStateSave();
    const label =
      categories.length === ACTIVITY_CATEGORIES.length
        ? "all"
        : categories.join(",");
    ctx.self.notice(
      `回合区显示：${label} → ${on ? "on（显示）" : "off（不显示）"}`,
      "success",
    );
  }

  /** `/symbol-unify on|off`：模型输出符号统一开关（变体替换为推荐 + 未推荐提醒）。 */
  function handleSymbolUnifyCommand(line: string): void {
    const arg = line.slice("/symbol-unify".length).trim().toLowerCase();
    const cur = ctx.state.symbolUnify;
    let next: boolean;
    if (arg === "on" || arg === "true") next = true;
    else if (arg === "off" || arg === "false") next = false;
    else {
      ctx.self.notice(
        `usage: /symbol-unify on|off（当前：${cur ? "on(替换+提醒)" : "off(原样)"}）`,
        "info",
      );
      return;
    }
    if (next !== cur) {
      ctx.self.apply((s) => reduceState(s, { type: "symbol-unify", on: next }));
      ctx.self.paint();
      ctx.self.scheduleSessionStateSave();
    }
    ctx.self.notice(
      `模型输出符号统一：${next ? "on（变体替换为推荐符号并提醒）" : "off（原样，不替换不提醒）"}`,
      "success",
    );
  }

  /**
   * `/detect-char-width`：手动重新实测终端字符宽度。实测集 = 已生效的覆盖 + 本会话
   * 记下的符号列表（`tui-width-symbols.json` 的先验），命中盲区：终端/字体/tmux 客户端
   * 改变导致既有实测值不再成立（真机症状见 BACKLOG #1）。结果经 notice 回报。
   */
  function handleDetectCharWidthCommand(): void {
    if (typeof ctx.deps.renderer.probeSymbolWidths !== "function") {
      ctx.self.notice("重新探测字符宽度：当前终端不支持实测（无 CPR）", "warn");
      return;
    }
    ctx.widthReprobeNotice = true;
    const queued = ctx.self.reprobeWidths(ctx.widthSymbols);
    if (queued === 0) {
      ctx.widthReprobeNotice = false;
      ctx.self.notice(
        "重新探测字符宽度：无可测字符（或在途探测尚未结束）",
        "info",
      );
      return;
    }
    ctx.self.notice(`重新探测字符宽度：已发起 ${queued} 个字符的实测`, "info");
  }

  /** /stats（别名 /usage、`/context`）：token 用量**双口径**——「最近一次调用」（`state.usage`，
   *  状态行 ctx 段同源）与「本会话累计」（`state.usageTotals`，逐次 usage 事件求和、会话切换清零）。
   *  contextWindow 缺失或为 0 → 只显绝对量（不除零）。 */
  function handleStatsCommand(): void {
    const usage = ctx.state.usage;
    const totals = ctx.state.usageTotals;
    const totalsLine = `本会话累计：输入 ${totals.input} · 输出 ${totals.output} · 缓存读 ${totals.cacheRead}`;
    // usage 缺失（新会话 / 刚切换会话）：最近一次调用不可知 → `—` / `n/a` 占位，
    // 双口径恒四行（BACKLOG TUI#12：不再回落「暂无数据」单行提示）
    if (!usage) {
      ctx.self.notice(
        ["最近一次调用：—", totalsLine, "上下文：—", "缓存命中率：n/a"].join(
          "\n",
        ),
        "info",
      );
      return;
    }
    const { input, output, cacheRead, contextWindow } = usage;
    // 上下文口径与状态行 ctx 段一致：input + cacheRead（均为最近一次调用）
    const context = input + cacheRead;
    const lines = [
      `最近一次调用：输入 ${input} · 输出 ${output} · 缓存读 ${cacheRead}`,
      totalsLine,
      contextWindow !== undefined && contextWindow > 0
        ? `上下文：${context} / ${contextWindow}（${Math.round((context / contextWindow) * 100)}%）`
        : `上下文：${context}`,
      `缓存命中率：${context > 0 ? `${Math.round((cacheRead / context) * 100)}%` : "n/a"}（最近一次）`,
    ];
    ctx.self.notice(lines.join("\n"), "info");
  }

  /** /help 双列表格：命令列定宽对齐、描述列固定起点。折行交给渲染层按
   *  hanging 悬挂缩进（续行停靠描述列、不穿回第一列；resize 后重排仍对齐）。 */
  function helpLines(): { text: string; hanging?: number; noCompact: true }[] {
    const commands: { cmd: string; desc: string }[] = [
      { cmd: "/help", desc: "显示本帮助" },
      {
        cmd: "/clearscreen (/cls)",
        desc: "清空缓冲(只清显示，不动上下文)",
      },
      { cmd: "/quit", desc: "退出" },
      {
        cmd: "/cleanquit",
        desc: "清理本会话（删除记录与历史）并退出（需确认）",
      },
      {
        cmd: "/restart",
        desc: "重启 dsh（保留会话；需由启动器启动，未设置 DSH_RESTART_FILE 时只提示）",
      },
      {
        cmd: "/theme [dark|light|toggle]",
        desc: "切换主题(默认 dark=fffdark, light=ffflight)",
      },
      {
        cmd: "/collapse on|off",
        desc: "回合区详略：on=紧凑（每条目 1 行 + 行尾省略号）/ off=完整折行",
      },
      {
        cmd: "/verbose think|tool|step",
        desc: "回合区输出内容：think=思考+正文+工具 / tool=正文+工具 / step=正文+工具调用行",
      },
      {
        cmd: "/symbol-unify on|off",
        desc: "模型输出符号统一：on=变体替换为推荐符号并提醒 / off=原样（不替换不提醒）",
      },
      {
        cmd: "/session",
        desc: "会话列表：Enter 切换到已持久化会话（live 会话不可续）",
      },
      {
        cmd: "/continue",
        desc: "加载当前目录下最近退出的会话（等价 /session + 自动选中；无匹配给提示）",
      },
      {
        cmd: "/goal",
        desc: "当前会话 goal：全形态交宿主 dsh-command-goal（无参看状态与可用命令，<目标> 新建，edit/pause/resume/clear 管理）；goal/todo 详情同时常驻左侧状态列",
      },
      { cmd: "/copy", desc: "复制最后一条模型回复到剪贴板(OSC52)" },
      {
        cmd: "/model [provider/]model[:effort]",
        desc: "切换当前会话模型（可带思考等级后缀）；无参打开交互选择面板",
      },
      {
        cmd: "/provider <name>、/effort <level> (/thinking)",
        desc: "带参直接切换 provider / 思考等级（组合不存在则警告并保持）；无参打开 /model 面板并定位到对应列",
      },
      {
        cmd: "/policy [ask|never]",
        desc: "审批策略：无参打开选项面板，带参直接设置",
      },
      {
        cmd: "/permission [预设名]",
        desc: "权限预设（sandbox+审批捆绑；无参列当前与可用，带参切换）",
      },
      {
        cmd: "/jobs",
        desc: "后台任务面板（只读列表；↑/↓ 选择、PgUp/PgDn 翻页、Enter 取消、Esc 关闭）",
      },
      {
        cmd: "/init",
        desc: "初始化 AGENTS.md（当前目录缺失时由模型阅读目录生成；已存在则提示退出）",
      },
      {
        cmd: "/stats (/usage /context)",
        desc: "本回合 token 用量与上下文占比（最近一次模型调用）",
      },
      { cmd: "/rename <标题>", desc: "重命名当前会话标题" },
      {
        cmd: "/skills [过滤]",
        desc: "技能目录面板（↑/↓ 选择、PgUp/PgDn 翻页、Enter 详情、Esc 关闭）",
      },
      {
        cmd: "/agents",
        desc: "子代理面板（↑/↓ 选择、PgUp/PgDn 翻页、r 刷新、Enter 直接中断选中项、Esc 关闭）",
      },
      {
        cmd: "/tools [过滤]",
        desc: "工具目录面板（↑/↓ 选择、PgUp/PgDn 翻页、Enter 详情、Esc 关闭）",
      },
      {
        cmd: "/settings",
        desc: "只读展示配置（ns：value，secret 脱敏）",
      },
      {
        cmd: "/fork",
        desc: "分叉当前会话为新会话（成功提示 + 必要时提示用 /session 查看）",
      },
      {
        cmd: "/task",
        desc: "任务面板（TaskEngine 只读：↑/↓ 选择、PgUp/PgDn 翻页、Enter 详情、Esc 关闭）",
      },
      {
        cmd: "/guard",
        desc: "守卫面板（拦截/放行记录：↑/↓ 选择、PgUp/PgDn 翻页、Enter 看策略、Esc 关闭）",
      },
      {
        cmd: "/memory",
        desc: "知识库（缺省概要；review [tier] 审阅面板；search <query> [--all-projects]；add <tier> [--kind k] <内容>）",
      },
      {
        cmd: "/loop",
        desc: "循环面板（活动/历史循环：↑/↓ 选择、PgUp/PgDn 翻页、Enter 详情、Esc 关闭）",
      },
      {
        cmd: "/contract",
        desc: "契约概览（当前目标 + Done-when 条款摘要；无 goal 给出提示）",
      },
      {
        cmd: "/workflows",
        desc: "工作流运行面板（只读：↑/↓ 选择、PgUp/PgDn 翻页、Esc 关闭）",
      },
      {
        cmd: "/council [N]",
        desc: "二次意见（并行 N 个评审子代理，对当前目标独立评审；默认 2）",
      },
      {
        cmd: "/search <query>",
        desc: "网页搜索（多 provider 聚合；Enter 查看来源 URL、Esc 关闭）",
      },
    ];
    // 按键表（2026-10-16 新增，BACKLOG「按键提示信息与实际绑定对齐」决策 3）：全局键全量，
    // 含提示行按「只放冷门 / 易忘键」口径不再列出的常用键；**固定顺序**（滚动 → 编辑 →
    // 提交与模式 → 历史 / 清空 → 视图与焦点 → 退出），不走 sortHelpRows——键位按功能相邻好查。
    // 键列记号沿用提示行口径（`C-` / `A-` 缩写），并压在 HELP_CMD_MAX 内避免长键拆行。
    const keys: { cmd: string; desc: string }[] = [
      {
        cmd: "↑/↓",
        desc: "滚动一行（回合区 / 状态列 / 会话区）；补全候选间移动",
      },
      { cmd: "C-↑/↓", desc: "半屏滚动（回合区 / 会话区）" },
      { cmd: "PgUp/PgDn", desc: "面板整页滚动；会话区跳上 / 下一条用户输入" },
      {
        cmd: "Home/End",
        desc: "翻到最旧已加载内容（再按再物化一批）/ 回到最新",
      },
      { cmd: "←/→", desc: "输入区光标移动" },
      {
        cmd: "Backspace",
        desc: "删除光标前字符；输入为空时回退输入模式到 `>`",
      },
      {
        cmd: "Enter",
        desc: "按输入模式提交（`>` 发送 / `<` 排队等下一回合 / `!` 打断并发送）",
      },
      {
        cmd: "$ / < / !",
        desc: "输入为空时按其中之一切换输入模式（`/` 同时是斜杠命令前缀；Backspace 回退 `>`）",
      },
      {
        cmd: "A-Enter",
        desc: "等效 `Enter`（旧「打断并发送」入口，2026-10-15 起废弃）",
      },
      { cmd: "C-p/n", desc: "输入历史回溯（上一条 / 下一条）" },
      { cmd: "C-j", desc: "输入区插入换行（Enter 仍为提交）" },
      { cmd: "C-c", desc: "清空输入区；750ms 内双击请求退出" },
      { cmd: "C-l", desc: "强制整帧重绘" },
      {
        cmd: "C-e/t/s",
        desc: "聚焦会话区 / 回合区 / 状态列（再按一次收起或退出焦点）",
      },
      { cmd: "Tab", desc: "接受补全候选（命令名 / `@` 文件提及）；面板内切窗" },
      {
        cmd: "Esc",
        desc: "关闭面板 / 收起补全候选；输入为空且有焦点时退出焦点",
      },
      { cmd: "C-d", desc: "请求退出（仅空闲且输入区为空时）" },
    ];
    return [
      { text: "按键：", noCompact: true },
      ...helpTableLines(keys),
      { text: "面板内按键见提示行区（随面板切换）。", noCompact: true },
      { text: "本地命令：", noCompact: true },
      // 条目按命令名字母序展示（口径：整体字母序、不保留手写分组）
      ...helpTableLines(sortHelpRows(commands)),
      {
        text: "其他 /name 通过 commands 注册表执行(未命中则提示未知命令)。",
        noCompact: true,
      },
    ];
  }

  return {
    handleSlash,
    applyTheme,
    handleThemeCommand,
    handleCollapseCommand,
    handleVerboseLevelCommand,
    handleSymbolUnifyCommand,
    handleDetectCharWidthCommand,
    handleStatsCommand,
    helpLines,
  };
}
