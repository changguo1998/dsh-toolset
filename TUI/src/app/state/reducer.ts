// src/app/state/reducer.ts — 纯 reducer：StateAction 到 AppState

import { createSections } from "../layout/pipeline/sections.ts";
import {
  DIALOGUE_KEEP_REPLIES,
  emptyRunVirt,
  virtTick,
  VIRT_SPEED_MIN,
  TOKEN_CALIB_ALPHA,
  TOKEN_CALIB_MAX,
  TOKEN_CALIB_MIN,
} from "../layout.ts";
import {
  codeDispatchLine,
  commandErrorLine,
  commandRunLine,
  hookLine,
  retryStartedLine,
  stepHeaderLine,
  subagentLine,
  toolCallLine,
  toolResultLine,
  workflowLine,
} from "../layout/tool-line.ts";
import {
  cleanableSessionIds,
  currentProjectCwd,
  deletableSession,
  historyVisibleRecords,
  markableSessionIds,
} from "./types.ts";
import type {
  AppState,
  GoalEntry,
  GoalHistory,
  HistoryPanelState,
} from "./types.ts";
import {
  appendNotice,
  appendNoticeLines,
  appendShellLines,
  appendStream,
  appendThinking,
  appendToolLine,
  clearBuffer,
  focusApproval,
  setAgentStatus,
  setApproval,
  setApprovalHint,
  setSessions,
  setSystemStatus,
  toggleApprovalWindow,
} from "./updates.ts";
import type { StateAction } from "./actions.ts";
import { reduceInputHistory, scrollBy } from "./panels.ts";
import {
  fillFileCompletion,
  filterPicker,
  focusQuestionWindow,
  moveCompletion,
  moveCursor,
  moveCustomCaret,
  movePicker,
  moveQuestion,
  moveStatusPanel,
  navQuestion,
  openQuestion,
  phasePicker,
  recomputeCompletion,
  scrollApproval,
  scrollQuestionDesc,
  selectPicker,
  selectQuestionOption,
  selectStatusPanel,
  setInput,
  setPickerEfforts,
  setQuestionCustom,
  tabPicker,
} from "./panels.ts";
import { dropHistoryRecords } from "./types.ts";
import { statusFor } from "./updates.ts";

// src/app/state/reducer.ts — 纯 reducer：StateAction 到 AppState

/** 焦点复位 action 集合：处理完自动回到无焦点（focusedPanel=null）。
 *  **只剩「用户提交输入」两项**（2026-10-15 用户裁定 + 条目验收①：运行中派发 `append` /
 *  `thinking` / `tool-call` / `notice` 等后 `focusedPanel` 保持不变，见 BACKLOG
 *  「模型回复期间区域焦点被内容推进清空」）：
 *  - `user-line`（提交回显）/ `queued-push`（排队登记）——两条都在**提交那一刻**派发，
 *    回无焦点 = 跟随最新（条目期望②）。
 *  **其余一律不复位**：
 *  - 流式内容：`append`（`index.ts` 的 stream 分支直派）/ `thinking` / `tool-*` / `step` /
 *    `subagent` / … —— 回复期间每个 chunk 都到，复位会让 `Ctrl+E` / `Ctrl+T` / `Ctrl+S`
 *    刚聚焦就被清掉、面板滚动随之失效（本条缺陷的现象）。
 *  - 回合边界：`turn-begin` / `turn-end` —— 一次回复可能跨多个回合（核心自发续轮），
 *    同样不能在回复中途把焦点甩掉。
 *  - `queued-claim`：`beginTurnIfNeeded` 在**每个**回合开始都会派发（不只是认领排队消息），
 *    放进集合等于「每个回合清焦点」。
 *  - 「无内容载荷的状态刷新」（`notice` / `goal-change` / `todo-write` / `jobs-changed` /
 *    `permission-catalog` / `agent-preset-catalog`）与 UI 类 action（picker/question/approval/
 *    history/jobs/input/scroll/theme…）同理不复位，避免打断面板内浏览。
 *  退出焦点只剩用户主动动作：idle + 空输入按 `Esc`、再按同一区域键（见 `focus-panel`）。 */
const FOCUS_RESET_ACTIONS: ReadonlySet<string> = new Set([
  "user-line", // 用户消息行（提交回显）
  "queued-push", // 排队消息（agent 运行期间 Enter 提交）
]);

export function reduceState(state: AppState, action: StateAction): AppState {
  // 新输入/输出后焦点回到无焦点（null）；其它 action 原样
  const next: AppState = (() => {
    switch (action.type) {
      case "append":
        return appendStream(state, action.text, "assistant", action.time);
      case "user-line":
        // 用户行（条目 16 段 C2：只记写状态事实——行本体由交付进节缓存）
        return appendStream(state, action.text, "user");
      case "queued-push":
        // 排队消息登记（不合并、不写 buffer）：显示由布局层按 queued 渲染，
        // 核心认领后由 queued-claim / queued-claim-steer 转入历史流；kind 缺省 followup
        return {
          ...state,
          queued: [
            ...state.queued,
            { text: action.text, kind: action.kind ?? "followup" },
          ],
        };
      case "queued-claim":
      case "queued-claim-steer": {
        // TUI#43：按类型认领——回合开始认领**最早一条** followup；step 边界认领**全部**
        // steer（宿主 `inbox.claim("next-step")` 一次摘走整批 pending，见
        // `dsh-agent-loop` 的 claim）。这一批在界面上合成**一个**用户块（原文用换行连接，
        // 不加空行），与宿主一次注入的整批内容对齐。
        if (action.type === "queued-claim-steer") {
          const steers = state.queued.filter((q) => q.kind === "steer");
          if (steers.length === 0) return state;
          const rest = state.queued.filter((q) => q.kind !== "steer");
          return appendStream(
            { ...state, queued: rest },
            steers.map((q) => q.text).join("\n"),
            "user",
          );
        }
        const idx = state.queued.findIndex((q) => q.kind === "followup");
        if (idx < 0) return state;
        const item = state.queued[idx]!;
        const rest = [
          ...state.queued.slice(0, idx),
          ...state.queued.slice(idx + 1),
        ];
        // #4：steer 认领＝插队送达（留白 + 上一条输入打「被 steer 续接」标）与用户块本体
        // 都由 App 的交付带进节缓存（`queued: "steer"` / `spaceBefore`），本地只出队 +
        // 记状态事实（剔除计数，与 `user-line` 同口径）
        return appendStream({ ...state, queued: rest }, item.text, "user");
      }
      case "queued-clear":
        return { ...state, queued: [] };
      case "thinking":
        return appendThinking(state, action.text, action.time);
      case "virt-tick": {
        // 运行中闪烁时间驱动：虚拟速度按指数衰减回落、虚拟总 token 按衰减中的
        // 速度持续积分（无数据时闪烁频率渐降到最低而不断）；速率窗口同步衰减
        return { ...state, runVirt: virtTick(state.runVirt, action.time) };
      }
      case "notice":
        if (action.lines && action.lines.length > 0)
          return appendNoticeLines(state, action.lines, action.tone);
        return appendNotice(state, action.text, action.error, action.tone);
      case "shell-lines":
        return appendShellLines(state, action.lines);
      case "clear-buffer":
        return clearBuffer(state);
      case "agent-status":
        // 外部活动兜底：审批/问答打开保持等待交互(黄△)；thinking/tool 视为
        // 进行中(黄●/○)；idle 不改状态色
        return {
          ...setAgentStatus(state, action.status),
          inputStatus:
            state.approval || state.question
              ? "waiting"
              : action.status === "thinking" || action.status === "tool"
                ? "running"
                : state.inputStatus,
        };
      case "approval":
        return setApproval(state, action.approval, action.deadline ?? null);
      case "approval-focus":
        return focusApproval(state, action.focus);
      case "approval-tab":
        return toggleApprovalWindow(state);
      case "approval-no-timeout":
        // 用户已操作 → 隐藏倒计时（BACKLOG 3.3.5；真正的计时停止在 adapter 侧）
        return state.approval && state.approvalDeadline !== null
          ? { ...state, approvalDeadline: null }
          : state;
      case "approval-hint":
        return setApprovalHint(state, action.text);
      case "sessions":
        return setSessions(state, action.sessions);
      case "picker-open":
        // 面板打开保留输入模式；仅真实 Esc（主输入态或关闭面板）才重置为默认 steer
        return { ...state, picker: action.picker };
      case "picker-move":
        return movePicker(state, action);
      case "picker-tab":
        return tabPicker(state);
      case "picker-phase":
        return phasePicker(state, action);
      case "picker-select":
        return selectPicker(state);
      case "picker-filter":
        return filterPicker(state, action);
      case "picker-efforts":
        return setPickerEfforts(
          state,
          action as {
            type: "picker-efforts";
            efforts: { id: string; name: string }[];
            effortIndex?: number;
          },
        );
      case "picker-close":
        return { ...state, picker: null };
      case "status-panel-open":
        return { ...state, statusPanel: action.panel };
      case "status-panel-move":
        return moveStatusPanel(state, action);
      case "status-panel-select":
        return selectStatusPanel(state);
      case "status-panel-close":
        return { ...state, statusPanel: null };
      case "completion-move":
        return moveCompletion(state, action);
      case "completion-close":
        return { ...state, completion: null };
      case "completion-data":
        return fillFileCompletion(state, action);
      case "file-mention-available":
        return { ...state, fileMentionAvailable: action.available };
      case "command-catalog":
        return {
          ...state,
          registryCommands: action.commands,
          completion: recomputeCompletion(
            { ...state, registryCommands: action.commands },
            state.inputText,
            state.inputCursor,
            state.inputMode,
          ),
        };
      case "question-open":
        return openQuestion(state, action);
      case "question-move":
        return moveQuestion(state, action);
      case "question-nav":
        return navQuestion(state, action);
      case "question-select":
        return selectQuestionOption(state);
      case "question-custom":
        return setQuestionCustom(state, action.text, action.caret ?? null);
      case "custom-caret":
        return moveCustomCaret(state, action.delta);
      case "question-focus":
        return focusQuestionWindow(state);
      case "question-desc-scroll":
        return scrollQuestionDesc(state, action.delta, action.max);
      case "approval-scroll":
        return scrollApproval(state, action.delta, action.max);
      case "question-close": {
        // 关闭问答面板：按 agent 活跃度恢复（运行中/上次结果），不再等待交互
        const next = { ...state, question: null };
        return { ...next, inputStatus: statusFor(next, "success") };
      }
      case "history-refresh": {
        // 删除/清理后重拉列表：保留面板结果提示与高亮位置（按**可见**长度 clamp）；
        // 标记集按新列表裁剪（已消失的 id 不再计入，避免幽灵标记）
        const hrf = state.history;
        if (!hrf || hrf.phase !== "list") return state;
        const alive = new Set(action.records.map((r) => r.id));
        const refreshed: HistoryPanelState = {
          ...hrf,
          records: action.records,
          error: undefined,
          marked: hrf.marked?.filter((id) => alive.has(id)),
        };
        const visible = historyVisibleRecords({ ...state, history: refreshed });
        return {
          ...state,
          history: {
            ...refreshed,
            index: Math.max(0, Math.min(visible.length - 1, hrf.index)),
          },
        };
      }
      case "history-result": {
        // 面板内结果提示：面板已关则忽略（调用方另有 buffer notice 留痕）
        const hrs = state.history;
        if (!hrs) return state;
        return { ...state, history: { ...hrs, result: action.text } };
      }
      case "history-scope-toggle": {
        // 切换列表范围（当前目录 ⇄ 全部）：尽量按 id 保留选中项，不可见则回首项
        const hst = state.history;
        if (!hst || hst.phase !== "list") return state;
        const scope: "project" | "all" =
          hst.scope === "all" ? "project" : "all";
        const prevId = historyVisibleRecords(state)[hst.index]?.id;
        const next: HistoryPanelState = { ...hst, scope };
        const visible = historyVisibleRecords({ ...state, history: next });
        const found =
          prevId === undefined ? -1 : visible.findIndex((r) => r.id === prevId);
        return {
          ...state,
          history: { ...next, index: found < 0 ? 0 : found },
        };
      }
      case "history-open":
        return {
          ...state,
          history: {
            phase: "loading-list",
            scope: "project",
            records: [],
            index: 0,
            messages: [],
            scroll: 0,
          },
        };
      case "history-list":
        // 面板已关闭则丢弃过期结果（异步竞态守卫）
        if (!state.history) return state;
        return {
          ...state,
          history: {
            ...state.history,
            phase: "list",
            records: action.records,
            index: 0,
            error: undefined,
          },
        };
      case "history-list-error":
        if (!state.history) return state;
        return {
          ...state,
          history: { ...state.history, phase: "error", error: action.error },
        };
      case "history-move": {
        if (!state.history || state.history.phase !== "list") return state;
        const hmv = state.history;
        const next = Math.max(
          0,
          Math.min(
            historyVisibleRecords(state).length - 1,
            hmv.index + action.delta,
          ),
        );
        return { ...state, history: { ...hmv, index: next } };
      }
      case "history-mark-toggle": {
        // Space：切换高亮行标记并下移一行（连续标记不必反复按 ↓）；
        // 不可删项（当前活跃 / live / 未持久化）不标记也不移动，由调用方 notice 说明
        const hmt = state.history;
        if (!hmt || hmt.phase !== "list") return state;
        const marked = hmt.marked ?? [];
        const rec = historyVisibleRecords(state)[hmt.index];
        if (!rec || !deletableSession(rec)) return state;
        const next = marked.includes(rec.id)
          ? marked.filter((id) => id !== rec.id)
          : [...marked, rec.id];
        const rows = historyVisibleRecords(state).length;
        return {
          ...state,
          history: {
            ...hmt,
            marked: next,
            index: Math.min(Math.max(0, rows - 1), hmt.index + 1),
          },
        };
      }
      case "history-mark-all": {
        // a：全选当前列表范围的可删项（**替换**标记集：删除集恒等于当前范围可删项，再按 Space 微调）
        const hma = state.history;
        if (!hma || hma.phase !== "list") return state;
        const ids = markableSessionIds(state);
        if (ids.length === 0) return state;
        return { ...state, history: { ...hma, marked: ids } };
      }
      case "history-mark-clear": {
        // c：清空标记集（无标记时不动状态，调用方据此提示）
        const hmc = state.history;
        if (!hmc || hmc.phase !== "list" || (hmc.marked?.length ?? 0) === 0) {
          return state;
        }
        return { ...state, history: { ...hmc, marked: [] } };
      }
      case "history-open-view": {
        if (!state.history || state.history.phase !== "list") return state;
        const hov = state.history;
        const rec = historyVisibleRecords(state)[hov.index];
        if (!rec) return state;
        return {
          ...state,
          history: { ...hov, phase: "loading-view", currentId: rec.id },
        };
      }
      case "history-view":
        if (!state.history || state.history.phase !== "loading-view")
          return state;
        return {
          ...state,
          history: {
            ...state.history,
            phase: "view",
            currentId: action.id,
            messages: action.messages,
            scroll: 0,
            error: undefined,
          },
        };
      case "history-view-error":
        if (!state.history || state.history.phase !== "loading-view")
          return state;
        return {
          ...state,
          history: { ...state.history, phase: "error", error: action.error },
        };
      case "history-scroll": {
        if (!state.history || state.history.phase !== "view") return state;
        const hsc = state.history;
        return {
          ...state,
          history: { ...hsc, scroll: Math.max(0, hsc.scroll + action.delta) },
        };
      }
      case "history-back": {
        if (!state.history || state.history.phase !== "view") return state;
        const hbk = state.history;
        return {
          ...state,
          history: {
            ...hbk,
            phase: "list",
            currentId: undefined,
            messages: [],
            scroll: 0,
          },
        };
      }
      case "history-resume":
        return state.history
          ? {
              ...state,
              history: {
                ...state.history,
                phase: "resuming",
                pendingResume: action.id,
                error: undefined,
              },
            }
          : state;
      case "history-resume-error":
        // 会话陈旧则丢弃（面板已关闭/已切换目标）
        if (
          !state.history ||
          state.history.phase !== "resuming" ||
          state.history.pendingResume !== action.id
        ) {
          return state;
        }
        return {
          ...state,
          history: {
            ...state.history,
            phase: "error",
            error: action.error,
            pendingResume: undefined,
          },
        };
      case "history-resume-ok":
        // 会话陈旧则丢弃（面板已关闭/已切换目标）
        if (
          !state.history ||
          state.history.phase !== "resuming" ||
          state.history.pendingResume !== action.id
        ) {
          return state;
        }
        return {
          ...state,
          activeSessionId: action.id,
          sessionTitle: action.title,
          history: null,
          local: [],
          followBottom: true,
          // 会话切换：清掉上一会话的阅读位置，回到跟随底部（段键跨会话无意义）
          dialogueTop: null,
          activityTop: null,
          scrollOffset: 0,
          activityScroll: 0,
          // TUI#9：会话恢复/切换 → 本会话累计清零（与 buffer 同步换会话）
          usageTotals: { input: 0, output: 0, cacheRead: 0 },
          // TUI#12：最近一次调用属上一会话 → 丢弃（不可知，显示占位）
          usage: undefined,
        };
      case "history-restore": {
        // TUI#40：CLI 启动即恢复（--resume / -c）——把既有消息折叠成历史行。
        // 与 history-resume-ok 的区别：**不依赖 /session 面板状态机**（启动路径没有面板），
        // 但仍守「会话已切走」的陈旧守卫（activeSessionId 必须为空或同 id）
        if (
          state.activeSessionId !== null &&
          state.activeSessionId !== action.id
        ) {
          return state;
        }
        return {
          ...state,
          activeSessionId: action.id,
          sessionTitle: action.title,
          local: [],
          followBottom: true,
          dialogueTop: null,
          activityTop: null,
          scrollOffset: 0,
          activityScroll: 0,
        };
      }
      case "session-switch":
        // /new：全新会话 → 缓冲、滚动、窗口、焦点与排队登记全部归零。
        // 按会话隔离的 mode/goal/todo/model 与 TUI 本地开关由 App 随后的
        // restoreSessionState 回填（新会话无记录 → 各回默认值）。
        return {
          ...state,
          activeSessionId: action.id,
          sessionTitle: action.title,
          history: null,
          local: [],
          // 六步流水线的节缓存同源归零（否则切换后首帧仍渲染旧会话内容）
          ...(state.pipeline === undefined
            ? {}
            : { pipeline: createSections() }),
          followBottom: true,
          scrollOffset: 0,
          dialogueTop: null,
          activityTop: null,
          activityScroll: 0,
          windowGroups: DIALOGUE_KEEP_REPLIES,
          focusedPanel: null,
          queued: [],
          stepGroup: null,
          // TUI#9：/new 全新会话 → 本会话累计清零
          usageTotals: { input: 0, output: 0, cacheRead: 0 },
          // TUI#12：/new 换会话 → 最近一次调用不再适用，清空（显示占位）
          usage: undefined,
        };
      case "history-confirm-delete": {
        const hcd = state.history;
        if (!hcd || hcd.phase !== "list") return state;
        // 有标记 → 批量删除标记集（跨范围保留的标记也计入；已不可删的项自动剔除）
        const batch = (hcd.marked ?? []).filter((id) => {
          const target = hcd.records.find((r) => r.id === id);
          return target !== undefined && deletableSession(target);
        });
        if (batch.length > 0) {
          return {
            ...state,
            history: {
              ...hcd,
              phase: "confirm-delete",
              pendingDelete: undefined,
              pendingDeleteIds: batch,
              result: undefined,
            },
          };
        }
        const rec = historyVisibleRecords(state)[hcd.index];
        // 当前活跃 / live / 未持久化 → 不进入确认（调用方以 notice 说明原因）
        if (!rec || !deletableSession(rec)) {
          return state;
        }
        return {
          ...state,
          history: {
            ...hcd,
            phase: "confirm-delete",
            pendingDelete: rec.id,
            pendingDeleteIds: undefined,
            result: undefined,
          },
        };
      }
      case "history-confirm-clean": {
        const hcc = state.history;
        if (!hcc || hcc.phase !== "list") return state;
        const ids = cleanableSessionIds(state);
        if (ids.length === 0) return state;
        return {
          ...state,
          history: {
            ...hcc,
            phase: "confirm-clean",
            pendingClean: ids,
            cleanCwd: currentProjectCwd(state),
            result: undefined,
          },
        };
      }
      case "history-confirm-cancel": {
        const hcx = state.history;
        if (
          !hcx ||
          (hcx.phase !== "confirm-delete" && hcx.phase !== "confirm-clean")
        ) {
          return state;
        }
        return {
          ...state,
          history: {
            ...hcx,
            phase: "list",
            pendingDelete: undefined,
            pendingDeleteIds: undefined,
            pendingClean: undefined,
            cleanCwd: undefined,
          },
        };
      }
      case "history-delete":
        return state.history?.phase === "confirm-delete"
          ? { ...state, history: { ...state.history, phase: "deleting" } }
          : state;
      case "history-delete-done": {
        // 单条与批量共用：ids = 成功删除的集合（空集 = 全部失败 → 记录与标记原样保留，仍回列表）
        const hdd = state.history;
        if (!hdd || hdd.phase !== "deleting") return state;
        return {
          ...state,
          history: dropHistoryRecords(
            hdd,
            action.ids,
            historyVisibleRecords(state).map((r) => r.id),
          ),
        };
      }
      case "history-clean":
        return state.history?.phase === "confirm-clean"
          ? { ...state, history: { ...state.history, phase: "cleaning" } }
          : state;
      case "history-clean-done": {
        const hcd2 = state.history;
        if (!hcd2 || hcd2.phase !== "cleaning") return state;
        return {
          ...state,
          history: dropHistoryRecords(
            hcd2,
            action.ids,
            historyVisibleRecords(state).map((r) => r.id),
          ),
        };
      }
      case "history-close":
        return { ...state, history: null };
      case "session-identify":
        return {
          ...state,
          activeSessionId: action.id,
          sessionTitle: action.title,
        };
      case "input":
        return setInput(state, action);
      case "input-mode":
        // 模式决定命令 token 语义（slash 模式文本无前导 `/`）：切换即重算候选
        return {
          ...state,
          inputMode: action.mode,
          completion: recomputeCompletion(
            state,
            state.inputText,
            state.inputCursor,
            action.mode,
          ),
        };
      case "input-status":
        // 活跃守卫：agent 非 idle 时绿/红结果不暴露（压回黄），空闲后才显示结果色
        return { ...state, inputStatus: statusFor(state, action.status) };
      case "input-history":
        return reduceInputHistory(state, action);
      case "move-cursor":
        return moveCursor(state, action);
      case "dialogue-scroll":
        // 位移换算在 App（拿到本帧段表与可视高）完成，此处只落位置
        return {
          ...state,
          dialogueTop: action.top,
          followBottom: action.top === null,
          scrollOffset: action.top === null ? 0 : Math.max(0, action.offset),
        };
      case "scroll-to-bottom":
        // 回到最新：跟随底部并复位渐进窗口（窗口内容随之上滚时再按需扩窗）
        return {
          ...state,
          followBottom: true,
          scrollOffset: 0,
          dialogueTop: null,
          activityTop: null,
          windowGroups: DIALOGUE_KEEP_REPLIES,
        };
      case "window-grow":
        // 扩窗（App 在位移前调用）：只多物化更早回合，视口位置不动
        return {
          ...state,
          windowGroups: Math.max(DIALOGUE_KEEP_REPLIES, action.groups),
        };
      case "pipeline-state":
        // 注入节缓存 = 内容单源（条目 16 段 C2 后这是**唯一**内容来源）
        return { ...state, pipeline: action.pipeline };
      case "turn-begin": {
        // 回合开始：内容归节缓存（回合分隔线由 `turn-start` 交付驱动），本地**无内容行可画**；
        // 非打印字符剔除计数按回合清零（turn-end 时警告后不复用旧值）。
        // run 边界 = 两次用户输入之间（见 runVirt 注释）：仅用户输入开启的回合
        // （clearActivity=true，含排队消息被认领）才重置虚拟状态与本 step 累计；
        // 核心自发的回合（goal 轮次/定时唤醒，clearActivity=false）属同一 run，保留。
        // 活动区本地行（notice / 工具行）一并清掉（否则底部 toast 挂着上一回合的提示）。
        const clearActivity = action.clearActivity ?? true;
        return {
          ...state,
          strippedChars: 0,
          stepEstTokens: 0,
          ...(clearActivity
            ? {
                runVirt: emptyRunVirt(),
                local: state.local.filter(
                  (l) => l.kind !== "notice" && l.kind !== "tool",
                ),
                activityScroll: 0,
                activityTop: null,
              }
            : {}),
        };
      }
      case "turn-number":
        // 条目 16 段 C2：缓冲不再承载回合分隔线行（分隔线是节缓存的内容），本地无事可做
        return state;
      case "clear-stripped":
        return { ...state, strippedChars: 0 };
      case "turn-end": {
        // 回合结束（条目 16 段 C2）：定型（finalize）与回合结束（turn-end）信号由宿主事件
        // 投进节缓存，本地只剩状态事实——置成功色（绿）与虚拟速度下限。
        // 虚拟总 token **不清零**（run 边界 = 两次用户输入之间，到下次用户输入
        // turn-begin clearActivity=true 时才重置），lastTime/速率窗口保持。
        // 用户块终态符号（✓/■/✗）由节模型按 reason 打标（`sections.ts`）
        return {
          ...state,
          inputStatus: "success",
          runVirt: { ...state.runVirt, speed: VIRT_SPEED_MIN },
        };
      }
      case "status":
        return setSystemStatus(state, action.status);
      case "set-theme":
        return { ...state, themeId: action.themeId };
      case "status-column": {
        // P7：Ctrl+S 切换垂直状态列显隐（缺省取反）；隐藏时把焦点从状态列移开
        // （否则 0 宽面板仍会被 focusFrame 画出退化边框，压在内容首列上）
        const visible = action.visible ?? !state.statusColumnVisible;
        return {
          ...state,
          statusColumnVisible: visible,
          focusedPanel:
            !visible && state.focusedPanel === "status"
              ? null
              : state.focusedPanel,
        };
      }
      case "lower-panes": {
        // #9：Ctrl+T 切换下半区（Turn 流 + Tool 面板区）显隐（缺省取反）；
        // 隐藏时把焦点从下半区移开（隐藏即不聚焦），输入栏不受影响
        const visible = action.visible ?? !state.lowerPanesVisible;
        return {
          ...state,
          lowerPanesVisible: visible,
          focusedPanel:
            !visible && state.focusedPanel === "activity"
              ? null
              : state.focusedPanel,
        };
      }
      case "activity-compact": {
        // 活动区压缩（按类别）：true=该类条目压 1 行 + 省略号；false=完整折行
        const next = { ...state.activityCompact };
        for (const category of action.categories) next[category] = action.on;
        return { ...state, activityCompact: next };
      }
      case "activity-show": {
        // 活动区显示（按类别）：true=显示该类内容；false=不显示
        const next = { ...state.activityShow };
        for (const category of action.categories) next[category] = action.on;
        return { ...state, activityShow: next };
      }
      case "symbol-unify":
        // 模型输出符号统一开关：true=变体替换为推荐并提醒；false=原样（不替换不提醒）
        return { ...state, symbolUnify: action.on };
      case "tool-call":
        // 工具调用：紧凑工具行（○ <name> <summary> 由 tool-line.ts 组装），不进模型历史。
        // #7 起 step 分割线在 step/start 已画，工具行不再插分组头。
        return appendToolLine(
          state,
          toolCallLine(action.name, action.summary),
          undefined,
          {
            keepLineBreaks: true,
          },
        );
      case "tool-result":
        // 工具结果：✓ 成功 / ✗ 失败（失败红色，tone=error）
        return appendToolLine(
          state,
          toolResultLine(action.ok, action.detail, action.meta),
          action.ok ? undefined : "error",
        );
      case "compaction": {
        // 长会话压缩 toast：start/end 提示；P8：压缩期间把该会话标记为活跃
        const raw = action.sessionId ?? state.activeSessionId;
        const sid = typeof raw === "string" && raw !== "" ? raw : undefined;
        let flags = state.compactingBySession;
        if (sid !== undefined) {
          flags = { ...flags };
          if (action.phase === "start") flags[sid] = true;
          else delete flags[sid];
        }
        return appendNotice(
          { ...state, compactingBySession: flags },
          action.phase === "start" ? "正在压缩上下文..." : "压缩完成",
          false,
          action.phase === "start" ? "info" : "success",
        );
      }
      case "retry":
        // 模型重试 toast：第 attempt/max 次 + 退避 + 失败码（黄色，表进行中）
        return appendNotice(
          state,
          `重试 ${action.attempt}/${action.max} (${(action.delayMs / 1000).toFixed(1)}s): ${action.code}` +
            (action.message ? " " + action.message : ""),
          false,
          "warn",
        );
      case "usage": {
        // 阶段 1：入状态（阶段 2 状态栏 contextLen/cacheHit 从 state.usage 读取）。
        // P5 估算校准：usage 真值（output，每 step 一次）与本 step 估算累计对比，
        // 比例经 EMA 平滑并 clamp 后写入 tokenCalib，供后续 run 校正启发式估算；
        // 本 step 累计清零（真值已消费）。provider 未报 usage（output<=0）不校准。
        const est = state.stepEstTokens;
        const tokenCalib =
          est > 0 && action.output > 0
            ? Math.min(
                TOKEN_CALIB_MAX,
                Math.max(
                  TOKEN_CALIB_MIN,
                  TOKEN_CALIB_ALPHA * (action.output / est) +
                    (1 - TOKEN_CALIB_ALPHA) * state.tokenCalib,
                ),
              )
            : state.tokenCalib;
        return {
          ...state,
          stepEstTokens: 0,
          tokenCalib,
          usage: {
            input: action.input,
            output: action.output,
            cacheRead: action.cacheRead,
            ...(action.contextWindow === undefined
              ? {}
              : { contextWindow: action.contextWindow }),
          },
          // TUI#9：本会话累计 = 逐次 usage 事件求和（事件每次调用即真值，无需另采）
          usageTotals: {
            input: state.usageTotals.input + action.input,
            output: state.usageTotals.output + action.output,
            cacheRead: state.usageTotals.cacheRead + action.cacheRead,
          },
        };
      }
      case "goal-change": {
        // P2：goal 累积为会话历史（index 0 = 当前）——create/未知 id 入栈；edit/pause/
        // resume/complete/block 按 id 原位更新；clear 出栈（墓碑只带 ref，不再展示）
        const prev = state.goalBySession[action.sessionId] ?? [];
        let next: GoalHistory;
        if (action.operation === "clear") {
          next = prev.filter((e) => e.goal.id !== action.cleared.id);
        } else {
          const entry: GoalEntry = {
            operation: action.operation,
            goal: action.goal,
            ...(action.roundsStarted === undefined
              ? {}
              : { roundsStarted: action.roundsStarted }),
            ...(action.createdAt === undefined
              ? {}
              : { createdAt: action.createdAt }),
            ...(action.updatedAt === undefined
              ? {}
              : { updatedAt: action.updatedAt }),
          };
          const at = prev.findIndex((e) => e.goal.id === action.goal.id);
          next =
            at < 0
              ? [entry, ...prev]
              : prev.map((e, i) => (i === at ? entry : e));
        }
        return {
          ...state,
          goalBySession: { ...state.goalBySession, [action.sessionId]: next },
        };
      }
      case "goal-activation": {
        // goal 自动续轮开关：只存**原始边**（展示值直取**原始边**，不推导、不按相位门控——宿主在
        // 同一次提交里先发 activation 边、后发 goal/change，若在此落推导结果会丢边）。
        // 无 activation = 宿主该会话已无当前 goal → 清记录。进程本地态：不落 tui-state.json。
        const next = { ...state.goalActivationBySession };
        if (action.activation === undefined) {
          delete next[action.sessionId];
        } else {
          next[action.sessionId] = action.activation;
        }
        return { ...state, goalActivationBySession: next };
      }
      case "todo-write":
        // P2：todo 全量快照 last-write-wins，按 sessionId 隔离
        return {
          ...state,
          todoBySession: {
            ...state.todoBySession,
            [action.sessionId]: action.todos,
          },
        };
      case "agents-changed":
        // TUI#39：子代理目录全量快照 last-write-wins，按 sessionId 隔离（状态列 Agents 块）
        return {
          ...state,
          agentsBySession: {
            ...state.agentsBySession,
            [action.sessionId]: action.agents,
          },
        };
      case "mode": {
        // P2：模式徽标按 sessionId 隔离（plan/sandbox/permission 三合一，缺省省略）
        const current = state.modeBySession[action.sessionId] ?? {};
        const updated =
          action.kind === "plan"
            ? { ...current, plan: action.value as "on" | "off" }
            : action.kind === "sandbox"
              ? { ...current, sandbox: action.value }
              : { ...current, permission: action.value };
        return {
          ...state,
          modeBySession: {
            ...state.modeBySession,
            [action.sessionId]: updated,
          },
        };
      }
      case "step":
        // #7：step/start **即画真分割线** `hh:mm:ss ⇆N #M`（其后思考/工具/正文都归入该步；
        // 每步都画，含首个 step 与无工具调用的 step）；step/end 关组。
        if (action.phase === "start") {
          // step 0 = 宿主在首个 step/start 之前的占位（「尚未声明任何 step」）→ **不落头行**：
          // 落了会被回放反解成「step 0 已声明」并画出 `╌╌ ⇆N #0 ╌╌` 假头（BACKLOG #21）
          if (action.step === 0) return state;
          // P6：时间取事件时间；mock/合成事件缺 time 时回退当前时刻
          const time = action.time ?? Date.now();
          return {
            ...appendToolLine(
              state,
              stepHeaderLine(action.step, time, action.turn),
              undefined,
              {
                time,
              },
            ),
            stepGroup: {
              sessionId: action.sessionId,
              step: action.step,
              time,
            },
          };
        }
        return { ...state, stepGroup: null };
      case "subagent":
        // B4：subagent 行（`@ <label> <os|ct>`，append-only 不配对不折叠）入 buffer，不进模型历史
        return appendToolLine(
          state,
          subagentLine(action.label, action.mode),
          "info",
        );
      case "compaction-summary": {
        // B5：压缩摘要仅 toast（`压缩完成：<text 首行>`；空摘要给占位）+ 每会话保留最近一条原始载荷（raw，不改写）
        const toast = action.text
          ? "压缩完成：" + action.text.split("\n")[0]
          : "压缩完成（无摘要）";
        return appendNotice(
          {
            ...state,
            compactionBySession: {
              ...state.compactionBySession,
              [action.sessionId]: { raw: action.raw, text: action.text },
            },
          },
          toast,
          false,
          "success",
        );
      }
      case "approval-policy":
        // C 阶段：当前审批策略按 sessionId latest-wins（approval/policy 事件源=宿主 setPolicy）；
        // 无对应会话事件时保留旧值（切会话读对应 policyBySession 键）
        return {
          ...state,
          policyBySession: {
            ...state.policyBySession,
            [action.sessionId]: action.policy,
          },
        };
      case "workflow":
        // P3：workflow 运行行（run-start/agent-start/agent-end 为活动区行，append-only）；
        // run-end 折叠为 toast（携 stopReason detail）。不参与 step 分组（独立运行大动作）。
        if (action.phase === "run-end") {
          return appendNotice(
            state,
            "workflow 结束" + (action.detail ? " (" + action.detail + ")" : ""),
            false,
            "success",
          );
        }
        return appendToolLine(
          state,
          workflowLine(action.phase, action.label, action.detail),
          action.phase === "agent-end" ? "success" : "info",
        );
      case "command":
        // P3：命令执行流——run 低调灰行；done 成功静默（结果由命令自身 notice 呈现，避免重复），
        // 失败红行（✗ /name: text）。append-only 不保留历史命令状态。
        if (action.phase === "done") {
          if (action.ok !== false) return state;
          return appendToolLine(
            state,
            commandErrorLine(action.name, action.text ?? ""),
            "error",
          );
        }
        return appendToolLine(state, commandRunLine(action.name), "log");
      case "code-dispatch":
        // P3：run_code 内子派发——start 灰行；settle 成功静默降噪（子调用多，避免刷屏），
        // 失败红行（✗ <name>）。
        if (action.phase === "settle") {
          if (action.ok) return state;
          return appendToolLine(state, "✗ " + action.name, "error");
        }
        return appendToolLine(
          state,
          codeDispatchLine(action.name, action.summary),
          "log",
        );
      case "hook":
        // P3：hooks 协议事件——invoked 灰行；result 按是否通过着色（失败红）。
        return appendToolLine(
          state,
          hookLine(action.phase, action.point, action.decision, action.ok),
          action.phase === "result" && !action.ok ? "error" : "log",
        );
      case "schedule":
        // P3：schedule 提醒——仅 dispatch 到点提示（create/delete 降噪，无用户可见价值）。
        if (action.operation !== "dispatch") return state;
        return appendNotice(state, "计划提醒触发", false, "log");
      case "compaction-prune":
        // P3：压缩剪枝计数 toast（co tool-result pruner 剪除的节点数/千分 token 启发值）
        return appendNotice(
          state,
          "压缩：已剪除 " +
            action.nodeCount +
            " 个节点 (~" +
            action.tokenCount +
            " tok)",
          false,
          "log",
        );
      case "feedback":
        // P3：feedback/record 确认（/feedback 命令落库后回读）
        return appendNotice(state, "反馈已记录", false, "success");
      case "retry-started":
        // P3：llm/retry-started 启动行（↻ 灰行）——与 retry toast 互补：启动可见 + 失败原因 toast
        return appendToolLine(state, retryStartedLine(action.attempt), "log");
      case "model-selection":
        // 0.1.2-rc.1：会话内生效模型选择事件 → 落 state（状态栏模型徽标可选读取）
        return {
          ...state,
          modelBySession: {
            ...state.modelBySession,
            [action.sessionId]: {
              provider: action.provider,
              model: action.model,
              reasoningEffort: action.reasoningEffort,
            },
          },
        };
      case "agent-preset":
        // P3：agent-preset/selected → 当前预设 latest-wins（会话隔离）
        return {
          ...state,
          presetBySession: {
            ...state.presetBySession,
            [action.sessionId]: action.preset,
          },
        };
      case "permission-catalog":
        // P4：权限预设目录（ctx.permissionPresets.names）——P7 移除状态列 Mode 块后
        // 暂无渲染消费方（保留槽位）
        return { ...state, permissionOptions: action.names };
      case "agent-preset-catalog":
        // P4：agent 预设目录 id 列表（ctx.agentPresets.list）——同上（原 Mode 块 preset 可选项）
        return { ...state, presetOptions: action.ids };
      case "jobs-changed":
        // P3：jobs 快照 last-write-wins（adapter events.subscribe 推送 + 打开时刷新）
        return { ...state, jobs: action.jobs };
      case "jobs-panel-open":
        return { ...state, jobsPanel: { index: 0 } };
      case "jobs-panel-move": {
        // 上下移动高亮行（clamp 到列表范围）
        const size = state.jobs.length;
        if (size === 0) return state;
        const index = Math.max(
          0,
          Math.min(size - 1, action.focus + action.delta),
        );
        return { ...state, jobsPanel: { index } };
      }
      case "jobs-panel-page": {
        // PgUp/PgDn 整页移动（页高由调用方按活动区可视行数给出；与 command-panel-page 同口径）
        const size = state.jobs.length;
        if (size === 0 || !state.jobsPanel) return state;
        const step = Math.max(1, action.page) * action.delta;
        const index = Math.max(
          0,
          Math.min(size - 1, state.jobsPanel.index + step),
        );
        return { ...state, jobsPanel: { index } };
      }
      case "jobs-panel-close":
        return { ...state, jobsPanel: null };
      case "command-panel-open":
        // 打开共享列表面板：先置 loading，数据经 command-panel-data 到达后填充
        return {
          ...state,
          commandPanel: {
            kind: action.kind,
            index: 0,
            rows: [],
            loading: true,
          },
        };
      case "command-panel-move": {
        const panel = state.commandPanel;
        if (!panel || panel.rows.length === 0) return state;
        const index = Math.max(
          0,
          Math.min(panel.rows.length - 1, panel.index + action.delta),
        );
        return { ...state, commandPanel: { ...panel, index } };
      }
      case "command-panel-page": {
        // PgUp/PgDn 整页移动（页高由调用方按活动区可视行数给出）
        const panel = state.commandPanel;
        if (!panel || panel.rows.length === 0) return state;
        const step = Math.max(1, action.page) * action.delta;
        const index = Math.max(
          0,
          Math.min(panel.rows.length - 1, panel.index + step),
        );
        return { ...state, commandPanel: { ...panel, index } };
      }
      case "command-panel-close":
        return { ...state, commandPanel: null };
      case "command-panel-data": {
        // 数据 last-write-wins：仅当前面板 kind 一致时写入（挡迟到数据覆盖新面板）
        const panel = state.commandPanel;
        if (!panel || panel.kind !== action.kind) return state;
        return {
          ...state,
          commandPanel: {
            kind: panel.kind,
            index: Math.max(
              0,
              Math.min(panel.index, Math.max(0, action.rows.length - 1)),
            ),
            rows: action.rows,
            ...(action.error === undefined ? {} : { error: action.error }),
          },
        };
      }
      case "status-column-scroll":
        // 顶部状态列纵向滚动：偏移累加，渲染层按可视行数 clamp；不进入对话区滚动
        return {
          ...state,
          statusColumnScroll: Math.max(
            0,
            state.statusColumnScroll + action.delta,
          ),
        };
      case "focus-panel": {
        // 「一键一区域」三态（2026-10-14 用户裁定，取代 Tab 焦点循环）：
        //  未聚焦 → 显示（若已收起）并聚焦；已聚焦 → 收起该区域 + 焦点回会话区（null）。
        // 可见但未聚焦时首次按键只聚焦（不收起）⟹ 收起可见面板需按两次。
        // 状态列 / 下半区「隐藏即不聚焦」由本分支与 status-column / lower-panes 各自保证；
        // 二者隐藏时「再按区域键」应重新显示并聚焦（不是收起），故按可见性分派而非按焦点。
        const target = action.panel;
        if (target === "history") {
          // 会话区恒显示：已聚焦 → 回无焦点；未聚焦 → 聚焦
          return {
            ...state,
            focusedPanel: state.focusedPanel === "history" ? null : "history",
          };
        }
        if (target === "status") {
          const collapse =
            state.statusColumnVisible && state.focusedPanel === "status";
          return {
            ...state,
            statusColumnVisible: !collapse,
            focusedPanel: collapse ? null : "status",
          };
        }
        const collapse =
          state.lowerPanesVisible && state.focusedPanel === "activity";
        return {
          ...state,
          lowerPanesVisible: !collapse,
          focusedPanel: collapse ? null : "activity",
        };
      }
      case "activity-scroll": {
        // 活动区（流输出）滚动。带 `top` 时按「节键 + 行」定位（App 先算好 positionAt）:
        // 位置用内容段身份表达, 上方插段不改画面; `null` = 跟随最新。
        // 缺 `top`(旧路径) 偏移累加(距底行数), 0=跟随最新; `max` = 上一帧回填的可滚动上限,
        // 先收敛越界再叠加、不超上限(避免"按了没反应"的假死, 与对话区 scrollBy 同口径)。
        if ("top" in action) {
          return {
            ...state,
            activityTop: action.top ?? null,
            activityScroll: Math.max(0, action.offset ?? 0),
          };
        }
        const max = Math.max(0, action.max ?? Number.MAX_SAFE_INTEGER);
        const cur = Math.min(state.activityScroll, max);
        return {
          ...state,
          activityScroll: Math.min(max, Math.max(0, cur + action.delta)),
        };
      }
      default:
        return state;
    }
  })();
  const focused = FOCUS_RESET_ACTIONS.has(action.type)
    ? { ...next, focusedPanel: null }
    : next;
  return focused;
}
