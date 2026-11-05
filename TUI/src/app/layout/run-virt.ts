// TUI/src/app/layout/run-virt.ts — 运行指示：虚拟速度 / 虚拟 token / ●○ 与用户块符号

import type {
  AppState,
  InputMode,
  GoalHistory,
  ModeState,
  StreamKind,
} from "../state.ts";
import { isCompacting } from "../state.ts";
import type { TodoItemLike } from "../adapter/dsh.ts";
import type { ColorName } from "../../renderer/theme.ts";
import type { UserRowInfo } from "./pipeline/ir.ts";
import { charWidth } from "./markdown.ts";

// TUI/src/app/layout/run-virt.ts — 运行指示：虚拟速度 / 虚拟 token / ●○ 与用户块符号

/**
 * 运行中符号交替阈值：每累计 RUN_TOGGLE_TOKENS 个**虚拟 token** 切换一次 ●/○。
 * 虚拟 token 由虚拟速度对时间积分而来（见 nextRunVirt），因此
 * **切换率（toggle/s，每秒符号变化次数）= 虚拟速度 / RUN_TOGGLE_TOKENS**；
 * 相位停留时长 = 其倒数，完整周期（●→○→●）= 2 × 相位停留。
 */
export const RUN_TOGGLE_TOKENS = 16;

/** 发送中两态符号（虚线圆 → 实线圆交替, 视觉上像未送达 → 已送达的等待提示）。
 *  首字节未到时随 250ms virt-tick 进相位, 两态一轮 0.5s。 */
export const SPINNER = ["◌", "○"] as const;

// ---- 参数层次（P4）：语义参数（频率/时长）在前，派生量在后，调参只动语义参数 ----

/**
 * 符号切换率下限（toggle/s：**每秒符号变化次数**，非完整周期数——完整周期频率
 * 为该值的一半，即 1 toggle/s ⟺ ●→○→● 一个周期 2s）。真实速率再低也保持此
 * 切换率（防卡死感）：相位停留 1s。
 */
export const RUN_TOGGLE_FREQ_MIN = 1;
/**
 * 符号切换率上限（toggle/s：每秒符号变化次数）：真实速率再高也不超过此切换率
 * （防闪瞎）：相位停留 0.1s，完整周期 0.2s（2026-10-13 由 5 提到 10）。
 */
export const RUN_TOGGLE_FREQ_MAX = 10;
/** 虚拟速度下限（估算 token/s）= 最低切换率 × 每切换 token 数（相位停留 1s） */
export const VIRT_SPEED_MIN = RUN_TOGGLE_FREQ_MIN * RUN_TOGGLE_TOKENS; // 16
/** 虚拟速度上限（估算 token/s）= 最高切换率 × 每切换 token 数（相位停留 0.1s） */
export const VIRT_SPEED_MAX = RUN_TOGGLE_FREQ_MAX * RUN_TOGGLE_TOKENS; // 160
/** 速率估计窗口时间常数（秒）：指数加权窗口（分子分母分别衰减）——速率估计
 *  的时间尺度与事件频率无关（P1 时间一致），且抗单帧 chunk 噪声（P2）。
 *  2026-10-13 由 0.5 拉长到 2：窗口更宽 → 估计更平滑、爬升/回落更慢 */
export const VIRT_RATE_TAU = 2;
/** 虚拟速度从下限爬到上限的过渡时长（秒）：slew 速率 = 速度范围 / 该时长，
 *  使"防突变"与时间尺度无关（P1：速率限制而非每帧绝对量） */
export const RUN_SPEED_RAMP_SECS = 2 / 3;
/** 虚拟速度最大变化率（估算 token/s²）：目标突变时按此速率平滑逼近 */
export const VIRT_SLEW_RATE =
  (VIRT_SPEED_MAX - VIRT_SPEED_MIN) / RUN_SPEED_RAMP_SECS; // 216
/** 虚拟速度无数据时的指数衰减时间常数（秒）：没有流式数据到达时速度按
 *  v(t) = MIN + (v₀ − MIN)·e^(−t/τ) 回落，虚拟总 token 按衰减中的速度持续积分——
 *  闪烁频率逐渐降到最低而不会停止（前提：agent 仍活跃，App 持续发 virt-tick） */
export const VIRT_DECAY_TAU = 6;
/** 估算 token 校准系数范围（P5）：用流末 usage 真值校正启发式估算，限定合理区间 */
export const TOKEN_CALIB_MIN = 0.25;
export const TOKEN_CALIB_MAX = 4;
/** 校准系数 EMA 平滑（新样本权重）：单次 usage 波动大，平滑后跨 step 稳定生效 */
export const TOKEN_CALIB_ALPHA = 0.3;

/**
 * 流式文本 → 估算 token 数（消费端近似，与宿主 token-meter 同族启发式）：
 * 宽字符（CJK/全角/emoji，显示宽 2 列）≈ 1 token，窄字符 ≈ 0.25 token，
 * 零宽不计。全中文 16 字符 ≈ 16 token、全英文 64 字符 ≈ 16 token。
 * 可用流末 usage 真值经 tokenCalib 校正（见 TOKEN_CALIB_*）。
 */
export function estimateOutputTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (w >= 2) tokens += 1;
    else if (w === 1) tokens += 0.25;
  }
  return tokens;
}

/** 运行中闪烁虚拟状态（与真实 tps 解耦的“速度”与“总 token”） */
export interface RunVirtState {
  /** 虚拟速度（估算 token/s；窗口速率估计 + slew 速率限制 + 上下限 clamp） */
  speed: number;
  /** 虚拟总 token（按虚拟速度对时间积分；触发 ●/○ 切换；run 边界见 state.ts） */
  tokens: number;
  /** 上次流式更新时刻（ms；undefined = 本 run 尚无时间基准） */
  lastTime?: number | undefined;
  /** 速率估计窗口：指数加权累计数据量（估算 token） */
  winTokens: number;
  /** 速率估计窗口：指数加权累计时长（秒）；速率 = winTokens / winSecs */
  winSecs: number;
  /** 发送中旋转相位（首字节未到前置位；`lastTime` 有值后不再使用）。
   *  每 250ms virt-tick 进 1 拍，两态一轮 0.5s（`SPINNER`）。 */
  sendPhase: number;
}

/** 空虚拟状态（run 开始/用户输入重置用）：速度为下限（保证 speed 恒在
 *  [VIRT_SPEED_MIN, VIRT_SPEED_MAX] 界内，避免首帧被下限 clamp 绕过 slew 跳升） */
export function emptyRunVirt(): RunVirtState {
  return {
    speed: VIRT_SPEED_MIN,
    tokens: 0,
    lastTime: undefined,
    winTokens: 0,
    winSecs: 0,
    sendPhase: 0,
  };
}

/** 虚拟总 token → 闪烁相位（0 = ●，1 = ○）；App 据此判断是否需要重绘（P5） */
export function runPhase(tokens: number): 0 | 1 {
  return (Math.floor(tokens / RUN_TOGGLE_TOKENS) % 2 === 0 ? 0 : 1) as 0 | 1;
}

/**
 * 每次收到流式输出时推进虚拟状态（时间一致，P1/P2）：
 *  - 速率估计：指数加权窗口（P2）——分子（数据量）与分母（时长）分别按
 *    e^(−Δt/τ) 衰减后累计，速率 = Σw·Δtoken / Σw·Δt；比两点差分抗单帧噪声，
 *    且窗口权重只依赖真实时长（P1，与事件频率无关）
 *  - 目标速度 = clamp(窗口速率, [MIN, MAX])
 *  - 变化率限制（P1）：单帧最多移动 VIRT_SLEW_RATE × Δt（速率限制，非每帧绝对量）
 *  - 虚拟总 token 按虚拟速度积分（与真实速率解耦）
 * 无时间基准或时间未推进时不更新（仅登记基准）。`delta` 为本次估算 token 数
 * （调用方已按 tokenCalib 校正）。
 */
export function nextRunVirt(
  prev: RunVirtState,
  time: number | undefined,
  delta: number,
): RunVirtState {
  if (
    time === undefined ||
    prev.lastTime === undefined ||
    time <= prev.lastTime
  ) {
    return { ...prev, lastTime: time ?? prev.lastTime };
  }
  // P5：Δt 下限 1ms（事件循环批量处理时可能同 tick 多帧，防速率被极端放大）
  const dtSec = Math.max(time - prev.lastTime, 1) / 1000;
  // P2：速率估计窗口（分子分母分别指数衰减 → 加权总速率）
  const decay = Math.exp(-dtSec / VIRT_RATE_TAU);
  const winTokens = prev.winTokens * decay + delta;
  const winSecs = prev.winSecs * decay + dtSec;
  const real = winSecs > 0 ? winTokens / winSecs : 0;
  // 目标速度（clamp 到频率界限）
  const target = Math.min(VIRT_SPEED_MAX, Math.max(VIRT_SPEED_MIN, real));
  // P1：变化率限制（速率化 slew）
  const maxDelta = VIRT_SLEW_RATE * dtSec;
  const stepped =
    prev.speed + Math.min(maxDelta, Math.max(-maxDelta, target - prev.speed));
  const speed = Math.min(VIRT_SPEED_MAX, Math.max(VIRT_SPEED_MIN, stepped));
  return {
    speed,
    tokens: prev.tokens + speed * dtSec,
    lastTime: time,
    winTokens,
    winSecs,
    sendPhase: prev.sendPhase,
  };
}

/**
 * 无流式数据到达时推进虚拟状态（时间驱动，App 在 running 期间周期性调用）：
 * 虚拟速度按指数衰减回落到下限（v(t) = MIN + (v₀−MIN)·e^(−t/τ)），虚拟总 token
 * 按衰减中的速度**持续积分**（∫v(s)ds = MIN·Δt + (v₀−MIN)·τ·(1−e^(−Δt/τ))）——
 * 即使一段时间没有数据，闪烁也不停止，只逐渐降到最低频率。速率估计窗口同步
 * 按 VIRT_RATE_TAU 衰减（忘记旧数据，避免下次数据到达时速率被长期均值拖住）。
 * 无时间基准或时间未推进时原样返回。
 * @扩展：首字节未到（`lastTime === undefined`）属**发送中**——旋转箭头按 tick 进相位
 *  （`SPINNER` 两态, 250ms 一拍），不积分 token；首块到达后 `lastTime` 有值, 走衰减分支。
 */
export function virtTick(prev: RunVirtState, time: number): RunVirtState {
  if (prev.lastTime === undefined) {
    const sendPhase = (prev.sendPhase + 1) % SPINNER.length;
    return { ...prev, sendPhase };
  }
  if (time <= prev.lastTime) return prev;
  const dtSec = (time - prev.lastTime) / 1000;
  const decay = Math.exp(-dtSec / VIRT_DECAY_TAU);
  const speed = Math.max(
    VIRT_SPEED_MIN,
    VIRT_SPEED_MIN + (prev.speed - VIRT_SPEED_MIN) * decay,
  );
  const tokens =
    prev.tokens +
    VIRT_SPEED_MIN * dtSec +
    (prev.speed - VIRT_SPEED_MIN) * VIRT_DECAY_TAU * (1 - decay);
  const winDecay = Math.exp(-dtSec / VIRT_RATE_TAU);
  return {
    speed,
    tokens,
    lastTime: time,
    winTokens: prev.winTokens * winDecay,
    winSecs: prev.winSecs * winDecay,
    sendPhase: prev.sendPhase,
  };
}

/** 运行中状态符号：按虚拟总 token 相位取 ●（偶数段）/ ○（奇数段）；
 *  无计数（直接调用方未提供）时回落空心圆 ○ */
export function runningSymbol(runVirtTokens: number | undefined): string {
  if (runVirtTokens === undefined) return "○";
  return runPhase(runVirtTokens) === 0 ? "●" : "○";
}

/** P1：用户块首行左侧状态符号与配色（2 列前缀 = 符号 + 1 空格）：
 *  绿 ✓ 成功 / 红 ✗ 失败 / 灰 ■ 中止；无终态回退默认前景 `?`。 */
const USER_BLOCK_SYMBOL: Record<
  "success" | "failure" | "aborted",
  { text: string; fg: ColorName }
> = {
  success: { text: "✓", fg: "green" },
  failure: { text: "✗", fg: "red" },
  aborted: { text: "■", fg: "gray" },
};

/** 接收中类型 → 运行符号着色（`streamKind` 记录当前流式内容类型; undefined 回退黄）。
 *  思考紫 / 正文蓝 / 工具黄 / notice 灰 / shell 青。 */
export const STREAM_KIND_COLOR: Record<StreamKind, ColorName> & {
  undefined: ColorName;
} = {
  thinking: "brightMagenta",
  assistant: "brightBlue",
  tool: "yellow",
  notice: "gray",
  shell: "cyan",
  undefined: "yellow",
};

/** 按流类型取运行符号颜色（undefined = 未定, 回退黄） */
export function streamKindColor(kind: StreamKind | undefined): ColorName {
  return kind === undefined
    ? STREAM_KIND_COLOR.undefined
    : STREAM_KIND_COLOR[kind];
}

/** P1：用户块首行符号解析器——状态在 layout 侧算定，结构层（pipeline/structure）只负责画。
 *  - 终态：取本行 `status`（`turn-end` 的原因经节 → 条目 → box 透传，批 B1）；
 *  - 活跃块（`line.active`：会话区最后一条终态未定的用户输入，由 `panes.ts` 打标）：
 *    等待交互（审批/问答面板打开）显示黄 △；运行中分两段——**发送中**（首字节未到,
 *    `runVirt.lastTime === undefined`）显示黄两态等待符号（`SPINNER` 随 tick 轮换）;
 *    **接收中**（首字节已到）显示 `●`/`○`（沿用虚拟 token 交替相位）并按当前流类型
 *    `state.streamKind` 着色（思考紫 / 正文蓝 / 工具黄 / notice 灰 / shell 青）;
 *  - 其余无终态块回退 `?`（恢复的历史、未收到 turn/end 的块）；
 *  - 排队块（布局层由 `state.queued` 单独渲染）不显示符号。 */
export function userBlockSymbolResolver(
  state: AppState,
): (info?: UserRowInfo) => { text: string; fg?: ColorName } | undefined {
  const waiting =
    state.approval !== null ||
    state.question !== null ||
    state.inputStatus === "waiting";
  // P8：压缩上下文期间也算「忙」（用户块显示运行中 ●/○）
  const running =
    !waiting &&
    (state.agentStatus !== "idle" ||
      state.inputStatus === "running" ||
      isCompacting(state));
  const runSymbol = runningSymbol(state.runVirt.tokens);
  return (info) => {
    // info 缺省 = 无状态（非用户块 / 排队块 / 无符号）
    if (info === undefined) return undefined;
    // 排队中的 followup/steer 用户消息：不显符号（旧口径）
    if (info.queued !== undefined) return undefined;
    // 终态 / 续接 / 活跃三个事实都由流水线条目自带（批 B1：单源在节模型）
    if (info.steerContinued === true) return { text: "←" };
    if (info.status) return USER_BLOCK_SYMBOL[info.status];
    if (info.active === true) {
      if (waiting) return { text: "△", fg: "yellow" as ColorName };
      if (running) {
        // 发送中（首字节未到）：旋转箭头（4 态, 黄）
        if (state.runVirt.lastTime === undefined) {
          return {
            text: SPINNER[state.runVirt.sendPhase % SPINNER.length]!,
            fg: "yellow" as ColorName,
          };
        }
        // 接收中：●/○ 闪烁, 按当前流类型着色
        return { text: runSymbol, fg: streamKindColor(state.streamKind) };
      }
    }
    return { text: "?" }; // 无终态
  };
}
/** 提示符 = 当前输入模式符号（steer > / shell $ / slash / / followup < / interrupt !；
 *  默认前景色，不着色） */
export const MODE_SYMBOL: Record<InputMode, string> = {
  steer: ">",
  shell: "$",
  slash: "/",
  followup: "<",
  interrupt: "!",
};

/** 当前活跃会话的目标/todo/模式/策略/预设/运行中任务数（状态行与整页高度共用口径） */
export function activeSessionFields(state: AppState): {
  goals?: GoalHistory | undefined;
  todos?: TodoItemLike[] | undefined;
  mode?: ModeState | undefined;
  policy?: "ask" | "never" | undefined;
  preset?: string | undefined;
} {
  const goals = state.activeSessionId
    ? state.goalBySession[state.activeSessionId]
    : undefined;
  const todos = state.activeSessionId
    ? state.todoBySession[state.activeSessionId]
    : undefined;
  const mode = state.activeSessionId
    ? state.modeBySession[state.activeSessionId]
    : undefined;
  // C 阶段：当前活跃会话审批策略（approval/policy 事件 latest-wins；无=undefined 省略徽标）
  const policy = state.activeSessionId
    ? state.policyBySession[state.activeSessionId]
    : undefined;
  // P3：当前活跃会话 agent 预设（标题栏 preset 符号段显示当前值）
  const preset = state.activeSessionId
    ? state.presetBySession[state.activeSessionId]
    : undefined;
  return { goals, todos, mode, policy, preset };
}
