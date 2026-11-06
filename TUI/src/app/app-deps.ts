// TUI/src/app/app-deps.ts — App 装配依赖面（main.ts 与测试注入的接线契约）

import type { Renderer } from "../renderer/index.ts";
import type { ThemeId } from "../renderer/theme.ts";
import type {
  DshAdapter,
  SecurityGuardLike,
  SessionChannelLike,
  SymbolNormalizerLike,
  RuleEngineLike,
} from "./adapter/dsh.ts";
import type { BlockDelivery } from "./layout/pipeline/types.ts";
import type { StatusQueries } from "./status.ts";
import type { ActivityPlacement } from "./config.ts";

/** flow-track 只读服务面（`ctx.get('flowTrack')`，flow-track 插件 provide）：开关态懒读用。 */
export interface FlowTrackLike {
  /** 开关 + 每 slug 最新流程记录（状态列 Flow 块；缺省 = 无摘要面）。 */
  summary?(): {
    enabled: boolean;
    records: Array<{
      slug: string;
      stage: string;
      status: string;
      active: boolean;
    }>;
  };
  enabled?(): boolean;
}
import type { ShellRunner } from "./local-shell.ts";
import type { LocalLogWriteOptions } from "./adapter/local-log.ts";

export interface AppDeps {
  renderer: Renderer;
  adapter: DshAdapter;
  /** 可选：状态行数据源；提供后 App 自动启动合并节流 ticker */
  status?: {
    queries: StatusQueries;
    intervalMs?: number | undefined;
    /** 调度器（可注入；缺省 setInterval）。定时器统一面（`clock` 服务）经 main.ts 接成
     *  `(fn, ms) => timers.interval(ms, fn)`，未挂载时回落进程内 setInterval。 */
    schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  };
  /** 初始主题（默认 dark=fffdark；/theme 切换仅当前会话） */
  initialTheme?: ThemeId | undefined;
  /** 跨回合最小帧间隔(ms)：>0 时限帧到该频率（窗口内跨宏任务的标脏合并到窗口末
   *  统一出帧）；缺省 0=不限帧（测试/演示保持立即出帧）。真实接线 main.ts 传 100=10Hz。 */
  frameIntervalMs?: number | undefined;
  /** 用户块左缘/回复右缘对称留空(列数，默认 4，经 initialState 落到 state) */
  messageGutter?: number | undefined;
  /** 输入区 + 提示行绝对行数（tui.config.json layout.footerHeight；缺省自动 1/5 上限 4） */
  footerHeight?: number | undefined;
  /** 回合区高分母（tui.config.json layout.activityHeightDivisor；1/2 → 2） */
  activityHeightDivisor?: number | undefined;
  /** 回合区分隔行锚定（tui.config.json layout.activityTopRow；"half" = floor(rows/2) 或绝对行号；
   *  配置后替代 activityHeightDivisor 的比例分配，缺省走 divisor） */
  activityTopRow?: "half" | number | undefined;
  /** 回合区排列方式（tui.config.json layout.activityPlacement；"auto" 按黄金分割比
   *  自动在上下/左右间选择，缺省恒上下排列。见 layout.ts topPaneSplit） */
  activityPlacement?: ActivityPlacement | undefined;
  /** 状态列宽分母（tui.config.json layout.statusColumnDivisor；1/3 → 3） */
  statusColumnDivisor?: number | undefined;
  /** /agents 面板定时刷新间隔(ms)；缺省 2000。宿主无 subagent 状态事件面，由
   *  打开期间定时 + 手动 `r` 双路保鲜（C2；评估结论见 TUI/docs/DESIGN.md「非显然实现要点」） */
  agentsRefreshIntervalMs?: number | undefined;
  /** 声音提醒（P2#33）：任务运行结束 / 等待用户输入超阈值 → 终端 BEL（\x07）。
   *  可选；不传=默认开启。配置源 tui.config.json `notify`（见 config.ts）。 */
  notify?:
    | {
        /** bell 总开关；缺省 true */
        enabled?: boolean | undefined;
        /** 等待用户输入超时(ms)；缺省 8000。最小 1000（由 config 归一化兜底） */
        idleThresholdMs?: number | undefined;
      }
    | undefined;
  /**
   * 六步流水线装配：App 在此注册「块交付」sink 并
   * 自己持有节缓存（`state.pipeline`）。缺省不注册 → adapter 零开销、旧路径不变。
   */
  pipelineSink?: { current?: (delivery: BlockDelivery) => void } | undefined;
  /** 符号服务读取器（懒读，容忍插件装载顺序）：返回 undefined = symbol-normalizer 未挂载，
   *  此时展示层原文透传、无 notice（BACKLOG TUI#18 / 项目级 #48） */
  getSymbols?: (() => SymbolNormalizerLike | undefined) | undefined;
  /** 会话通道读取器（懒读）：返回 undefined = session-channel 未挂载，状态行不显示别名段
   *  （BACKLOG TUI#48） */
  getSessionChannel?: (() => SessionChannelLike | undefined) | undefined;
  /** rule-engine 服务读取器（懒读）：返回 undefined（或未实现 onNotice）= 告警不经总线，
   *  由插件侧 stderr 兜底（BACKLOG「rule-engine 的用户提示应显示在回合区」） */
  getRuleEngine?: (() => RuleEngineLike | undefined) | undefined;
  /** flow-track 开关读取器（懒读）：返回 undefined = 未挂载 → 标题栏不渲染该符号 */
  getFlowTrack?: (() => FlowTrackLike | undefined) | undefined;
  /** 状态列 Task 块：任务引擎只读快照。 */
  /** 状态列 Task 块：任务引擎只读快照（结构化读取）。 */
  getTaskEngine?: (() => unknown) | undefined;
  /** 状态列 Pin 块：pin-note 的会话摘要面。 */
  /** 状态列 Pin 块：pin-note 的会话摘要面。 */
  getPinNotes?: (() => unknown) | undefined;
  /** 状态列 Daemon 块：background-daemon 只读面。 */
  /** 状态列 Daemon 块：background-daemon 只读面。 */
  getDaemon?: (() => unknown) | undefined;
  /** 状态列 Group 块：agent-group 的按会话摘要面。 */
  /** 状态列 Group 块：agent-group 的按会话摘要面。 */
  getAgentGroup?: (() => unknown) | undefined;
  /** 运行期告警出口（缺省静默；真实接线由 main.ts 写 stderr，格式 `warn: …`） */
  logger?: ((message: string) => void) | undefined;
  /** 启动自检 kickoff 正文（门控通过时由 main.ts 传入；App 代替用户发出以完成锚定解锁）。
   *  不传 / adapter 未实现 sendBootstrapKickoff = 不发送 */
  bootstrapKickoffText?: string | undefined;
  /** `/new` 的启动自检惰性门控（BACKLOG TUI#57；main.ts 接线）：每次新建会话**切换完成后**
   *  调用，返回正文则补发 kickoff，undefined = 不发。不能复用 `bootstrapKickoffText`——
   *  那是按启动会话判定的静态值（启动会话已解锁时为空） */
  bootstrapKickoffForNewSession?: (() => string | undefined) | undefined;
  /** 自动清理空会话（tui.config.json `session.autoCleanEmpty`；main.ts 接线缺省 true）。
   *  true 时 start() 异步扫描全部目录删除空会话（notice 汇报），且优雅退出时
   *  （/quit、Ctrl+D、双击 Ctrl+C、插件 unload）先打印提示并等待清理完成再关闭渲染器。 */
  autoCleanEmpty?: boolean | undefined;
  /** 重启交接文件路径（main.ts 从 `process.env.DSH_RESTART_FILE` 接线；BACKLOG #51）。
   *  非空 = 由会处理退出码 75 的启动器启动：退出确认面板才提供「重启 dsh（保留会话）」，
   *  选中后把当前活跃会话 id 写进该文件并置退出码 75（不自己 respawn）。 */
  restartHandoffPath?: string | undefined;
  /** `$` 模式本地执行器（BACKLOG TUI#37）：缺省走 node:child_process（local-shell.ts），
   *  测试可注入假实现避免真起进程 */
  runShell?: ShellRunner | undefined;
  /** `$` 模式执行前复查的 security-guard 服务读取器（懒读，容忍插件装载顺序；BACKLOG
   *  「TUI `$` 模式执行面不经 guard」）：main.ts 接 `ctx.get("guard")`；返回 undefined /
   *  无 inspectCommand / 读取或调用抛错 → fail-open 照常执行 + 每种失效模式告警一次。
   *  缺省（不传）= 未接线：不复查也不告警（测试与无 guard 的嵌入方保持原行为）。 */
  getGuard?: (() => SecurityGuardLike | undefined) | undefined;
  /** profile 目录（main.ts 从 `ctx.get('profileContext').dir` 接线）：实测宽度表
   *  落盘位置（`<profile 目录>/tui-width-symbols.json`）。缺省 / 空串 = 不落盘
   *  （仍按需实测，只是不跨会话复用）；见 TUI/src/app/layout/width-symbols.ts。 */
  profileDir?: string | undefined;
  /** 本地输出旁路日志（模型侧工具 `tui_local_log` 的数据源；见 TUI/src/app/adapter/local-log.ts）：
   *  main.ts 从 tui.config.json 的 localLog 段归一化后传入（缺省开启）。
   *  缺省不传 = 不落盘（测试与嵌入方保持原行为）。 */
  localLog?: LocalLogWriteOptions | undefined;
}
