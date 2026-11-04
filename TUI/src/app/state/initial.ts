// TUI/src/app/state/initial.ts — 初始状态装配

import type { ActivityPlacement } from "../config.ts";
import { DIALOGUE_KEEP_REPLIES, emptyRunVirt } from "../layout.ts";
import { DEFAULT_THEME, type ThemeId } from "../../renderer/theme.ts";
import {
  ACTIVITY_COMPACT_DEFAULT,
  ACTIVITY_SHOW_DEFAULT,
  DEFAULT_MESSAGE_GUTTER,
  goalActivationDisplay,
} from "./types.ts";
import type { AppState } from "./types.ts";

// TUI/src/app/state/initial.ts — 初始状态装配

export function initialState(
  themeId: ThemeId = DEFAULT_THEME,
  opts?: {
    messageGutter?: number;
    footerHeight?: number;
    activityDivisor?: number;
    activityTopRow?: "half" | number;
    activityPlacement?: ActivityPlacement;
    statusDivisor?: number;
    /** 声音提醒总开关（缺省 true，与 App 的 `deps.notify?.enabled ?? true` 同口径） */
    notifyEnabled?: boolean;
  },
): AppState {
  const messageGutter =
    opts?.messageGutter === undefined
      ? DEFAULT_MESSAGE_GUTTER
      : Math.max(0, Math.floor(opts.messageGutter));
  const footerHeight =
    opts?.footerHeight === undefined
      ? undefined
      : Math.max(1, Math.floor(opts.footerHeight));
  const activityDivisor =
    opts?.activityDivisor === undefined
      ? undefined
      : Math.max(1, Math.floor(opts.activityDivisor));
  const activityTopRow =
    opts?.activityTopRow === "half"
      ? "half"
      : typeof opts?.activityTopRow === "number" &&
          Number.isFinite(opts.activityTopRow)
        ? Math.max(0, Math.floor(opts.activityTopRow))
        : undefined;
  const statusDivisor =
    opts?.statusDivisor === undefined
      ? undefined
      : Math.max(1, Math.floor(opts.statusDivisor));
  const activityPlacement: ActivityPlacement | undefined =
    opts?.activityPlacement === "auto" ||
    opts?.activityPlacement === "vertical" ||
    opts?.activityPlacement === "horizontal"
      ? opts.activityPlacement
      : undefined;
  return {
    sessions: [],
    activeSessionId: null,
    sessionTitle: "", // 默认标题为空，渲染层（renderStatusLine）用 <title> 占位
    goalBySession: {},
    // goal 自动续轮开关（进程本地态，无初值：宿主重启后 setActivation(disarmed) 与初值
    // 相同不发事件，故「无记录」即不显示（selector 不再推导），见 goalActivationDisplay）
    goalActivationBySession: {},
    todoBySession: {},
    agentsBySession: {},
    modeBySession: {},
    policyBySession: {},
    compactionBySession: {},
    compactingBySession: {},
    stepGroup: null,
    presetBySession: {},
    modelBySession: {},
    permissionOptions: [],
    presetOptions: [],
    jobs: [],
    jobsPanel: null,
    commandPanel: null,
    statusColumnScroll: 0,
    focusedPanel: null, // 无焦点（会话区默认）；Ctrl+E / Ctrl+T / Ctrl+S 一键聚焦对应区域
    activityScroll: 0,
    activityCompact: { ...ACTIVITY_COMPACT_DEFAULT }, // 缺省完整折行
    activityShow: { ...ACTIVITY_SHOW_DEFAULT }, // 缺省三类全显示
    symbolUnify: true, // 模型输出符号统一（缺省开）；/symbol-unify off 切原样
    notifyEnabled: opts?.notifyEnabled ?? true, // 声音提醒（配置项，只读展示）
    statusColumnVisible: true, // P7：垂直状态列默认显示（Ctrl+S 切换）
    lowerPanesVisible: true, // #9：下半区（Turn/Tool）默认显示（Ctrl+T 切换）
    strippedChars: 0, // 本回合剔除的非打印控制字符计数（turn-begin 清零）
    runVirt: emptyRunVirt(), // 运行中闪烁虚拟状态（下次用户输入时重置）
    stepEstTokens: 0, // 本 step 估算 token 累计（usage 真值到达时校准）
    tokenCalib: 1, // 估算 token 校准系数（usage 真值/估算值 EMA，跨 step 保留）
    usageTotals: { input: 0, output: 0, cacheRead: 0 }, // 本会话累计（/stats；会话切换清零）
    local: [],
    followBottom: true,
    scrollOffset: 0,
    dialogueTop: null,
    activityTop: null,
    windowGroups: DIALOGUE_KEEP_REPLIES,
    inputText: "",
    inputCursor: 0,
    inputHistory: [], // 输入历史：进程内、随会话生命周期（不写入 tui-state.json）
    inputHistoryCursor: 0,
    inputHistoryDraft: "",
    inputHistoryDraftMode: "steer",
    queued: [], // 无排队（agent 运行期间 Enter 的文本登记在此，核心认领后转入历史）
    inputMode: "steer",
    inputStatus: "idle",
    approval: null,
    approvalScroll: 0,
    approvalFocus: "approve",
    approvalWindow: "options",
    approvalDeadline: null,
    approvalHint: null,
    picker: null,
    question: null,
    statusPanel: null,
    completion: null,
    registryCommands: [],
    fileMentionAvailable: false,
    history: null,
    agentStatus: "idle",
    themeId,
    systemStatus: {
      time: "—",
      cwd: "—",
      git: "—",
      model: "—",
      contextLen: "—",
      cacheHit: "—",
    },
    messageGutter,
    footerHeight,
    activityDivisor,
    activityTopRow,
    activityPlacement,
    statusDivisor,
  };
}
