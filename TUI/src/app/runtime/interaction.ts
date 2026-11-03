// TUI/src/app/runtime/interaction.ts — 按键与交互: 按键表与路由、审批 / 问答、退出确认、编辑与补全、@ 提及
//
// 2026-11-04 拆分自 TUI/src/app/index.ts 的 App 类体: 方法体只做 this. -> ctx. 改写,
// 跨模块调用经 ctx.self, 公共状态在 ./context.ts.

import type { KeyEvent } from "../../renderer/index.ts";
import { writeFileSync } from "node:fs";
import type {
  AppState,
  InputMode,
  QuestionPanelState,
  CompletionState,
} from "../state.ts";
import {
  historyVisibleRecords,
  inputLineBounds,
  inputLineMove,
  reduceState,
} from "../state.ts";
import { mentionInsertText, replaceActiveToken } from "../file-mention.ts";
import { maxDescScrollFor } from "../components/QuestionPrompt.ts";
import { maxApprovalScroll } from "../components/ApprovalPrompt.ts";
import {
  buildQuestionAnswers,
  questionKeyDecision,
} from "../question-transition.ts";
import {
  pickerFilterColumn,
  pickerFilterInput,
  pickerFilterText,
} from "../picker-filter.ts";
import type { KeyActionName } from "../keys.ts";
import {
  APPROVAL_KEYS,
  COMMAND_PANEL_KEYS,
  EDITOR_KEYS,
  HISTORY_CONFIRM_KEYS,
  HISTORY_ERROR_KEYS,
  HISTORY_LIST_KEYS,
  HISTORY_VIEW_KEYS,
  JOBS_PANEL_KEYS,
  PICKER_KEYS,
  STATUS_PANEL_KEYS,
  lookupKey,
} from "../keys.ts";
import {
  WINDOW_GROW_STEP,
  dialogueHalfPage,
  frameGeometry,
  userRowJump,
} from "../layout.ts";
import {
  createLineTable,
  MARKER_KEY,
  positionAt,
} from "../layout/pipeline/rows.ts";
import { sectionGroupCount, sectionsOf } from "../layout/pipeline/frame.ts";
import {
  CLEAN_QUIT_CONFIRM_LABEL,
  CLEAN_QUIT_PANEL_ID,
  DSH_RESTART_EXIT_CODE,
  EXIT_CONFIRM_CLEAN_LABEL,
  EXIT_CONFIRM_RESTART_LABEL,
  CTRL_C_DOUBLE_MS,
  EXIT_CONFIRM_PANEL_ID,
  canExitOnCtrlD,
} from "../exit-guards.ts";
import { focusedLineScroll, focusedPageScroll } from "../scroll-helpers.ts";
import type { AppContext } from "./context.ts";

/** 审批超时回落值（ms）= 1 min：adapter 未提供 `approvalTimeoutMs()` 时使用（BACKLOG 3.2.5 / 3.3.2） */
const APPROVAL_TIMEOUT_FALLBACK_MS = 60_000;

/** `@` 提及候选查询的去抖窗口(ms)：连续输入合并为一次宿主查询（provider 侧有索引与缓存，
 *  窗口取小值——面板要跟手，但不能每个字符都发一次查询） */
const MENTION_DEBOUNCE_MS = 60;

export function createInteractionPart(ctx: AppContext) {
  /**
   * 按键动作表：动作名 -> 实现。按键表与上下文见 `app/keys.ts`；`handleKey` 查表命中即调用，
   * 未命中的键由各上下文自己兜底（无效键提示 / 筛选词编辑 / 模式键 / 可打印字符）。
   * 函数体与拆分前的 if / switch 分支逐行对应，paint 时机保持原样。
   */
  const keyActions: Record<KeyActionName, (k: KeyEvent) => void> = {
    // ── 审批面板 ────────────────────────────────────────────────
    "approval-allow": () => finishApproval(true),
    "approval-deny": () => finishApproval(false),
    "approval-submit": () =>
      finishApproval(ctx.state.approvalFocus === "approve"),
    "approval-switch": () => moveApprovalFocus(),
    "approval-scroll": (k) => {
      // ↑/↓ 语义随焦点窗（3.3.4）：描述窗滚草稿、选项窗移动「批准 / 拒绝」
      if (ctx.state.approvalWindow === "desc") {
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "approval-scroll",
            delta: k.name === "down" ? 1 : -1,
            max: approvalScrollMax(),
          }),
        );
      } else {
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "approval-focus",
            focus: ctx.state.approvalFocus === "approve" ? "reject" : "approve",
          }),
        );
      }
      ctx.self.paint();
    },
    "approval-tab": () => {
      // Tab：草稿 <-> 选项焦点窗（BACKLOG 3.3.4，与问答面板同构）
      ctx.self.apply((s) => reduceState(s, { type: "approval-tab" }));
      ctx.self.paint();
    },
    "approval-cancel": () => {
      ctx.deps.adapter.cancelApproval(ctx.state.approval!.id);
      ctx.self.apply((s) =>
        reduceState(s, { type: "approval", approval: null }),
      );
      ctx.self.paint();
    },

    // ── /model 选择面板 ─────────────────────────────────────────
    "picker-move": (k) => {
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "picker-move",
          delta: k.name === "down" ? 1 : -1,
        }),
      );
      ctx.self.paint();
    },
    "picker-select": () => {
      ctx.self.apply((s) => reduceState(s, { type: "picker-select" }));
      ctx.self.paint();
      // provider/model 区星号移动后重载思考等级列表（thinking 区选择不变列表）
      const phase = ctx.state.picker?.phase;
      if (phase === 0 || phase === 1) void ctx.self.reloadPickerEfforts();
    },
    "picker-tab": () => {
      ctx.self.apply((s) => reduceState(s, { type: "picker-tab" }));
      ctx.self.paint();
    },
    "picker-phase": (k) => {
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "picker-phase",
          delta: k.name === "right" ? 1 : -1,
        }),
      );
      ctx.self.paint();
    },
    "picker-submit": () => {
      void ctx.self.confirmModelPicker();
    },
    "picker-cancel": () => {
      // Esc：本列有筛选词时只清空（再按一次才关面板）
      if (pickerFilterText(ctx.state.picker!) !== "") {
        ctx.self.apply((s) =>
          reduceState(s, { type: "picker-filter", text: "" }),
        );
        ctx.self.paint();
        return;
      }
      // 关闭面板（并重置输入模式为 normal；提交后的自动回退见 submit）
      ctx.self.apply((s) => reduceState(s, { type: "picker-close" }));
      ctx.self.apply((s) =>
        reduceState(s, { type: "input-mode", mode: "steer" }),
      );
      ctx.self.paint();
    },

    // ── 通用状态选项面板（/policy /permission） ─────────────────
    "status-move": (k) => {
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "status-panel-move",
          delta: k.name === "down" ? 1 : -1,
        }),
      );
      ctx.self.paint();
    },
    "status-select": () => {
      ctx.self.apply((s) => reduceState(s, { type: "status-panel-select" }));
      ctx.self.paint();
    },
    "status-submit": () => {
      void ctx.self.commitStatusPanel();
    },
    "status-cancel": () => {
      ctx.self.apply((s) => reduceState(s, { type: "status-panel-close" }));
      ctx.self.paint();
    },

    // ── /jobs 任务面板 ──────────────────────────────────────────
    "jobs-move": (k) => {
      const focus = ctx.state.jobsPanel!.index;
      const delta = k.name === "down" ? 1 : -1;
      ctx.self.apply((st) =>
        reduceState(st, { type: "jobs-panel-move", focus, delta }),
      );
    },
    "jobs-page": (k) => {
      // 翻页页高 = 回合区可视行数（与 shared commandPanel 同一 frameGeometry 口径）
      const page = frameGeometry(
        ctx.state,
        ctx.deps.renderer.getSize(),
      ).activityH;
      const delta = k.name === "pageup" ? -1 : 1;
      ctx.self.apply((st) =>
        reduceState(st, { type: "jobs-panel-page", delta, page }),
      );
    },
    "jobs-enter": () => {
      const job = ctx.state.jobs[ctx.state.jobsPanel!.index];
      if (job) void ctx.self.killJob(job.id);
    },
    "jobs-close": () => {
      ctx.self.apply((st) => reduceState(st, { type: "jobs-panel-close" }));
    },

    // ── 共享列表面板（/skills /agents /tools 等） ───────────────
    "panel-move": (k) => {
      const delta = k.name === "down" ? 1 : -1;
      ctx.self.apply((st) =>
        reduceState(st, { type: "command-panel-move", delta }),
      );
    },
    "panel-page": (k) => {
      // 翻页页高 = 回合区可视行数（与面板窗口同口径，见 COMMANDS-SPEC.md §4 接线点 5）
      const page = frameGeometry(
        ctx.state,
        ctx.deps.renderer.getSize(),
      ).activityH;
      const delta = k.name === "pageup" ? -1 : 1;
      ctx.self.apply((st) =>
        reduceState(st, { type: "command-panel-page", delta, page }),
      );
    },
    "panel-enter": () => {
      const panel = ctx.state.commandPanel!;
      const row = panel.rows[panel.index];
      if (row === undefined) {
        // 空态/占位：无行可操作，吞掉
      } else if (panel.kind === "guard") {
        // 守卫行恒无 payload：Enter 统一展示策略快照（policy()）
        void ctx.self.showGuardPolicy();
      } else if (!row.payload) {
        // 无可中断 id 的条目（agents 的 diagnostic / 一次性等）：灰显 + 说明，不发服务调用；
        // 与其它 Enter 行为一致先关面板——否则说明 notice 会被面板占用的回合区遮住
        ctx.self.apply((s) => reduceState(s, { type: "command-panel-close" }));
        ctx.self.notice(
          row.blockedReason ??
            (panel.kind === "agents"
              ? "该条目不可中断（无可用会话 id）"
              : "该条目无详情载荷"),
          "info",
        );
      } else if (panel.kind === "agents") {
        void ctx.self.interruptAgent(row.payload);
      } else if (panel.kind === "workflows") {
        // 只读运行列表：Enter 无操作（吞键，面板保持）
      } else {
        void ctx.self.showPanelDetail(panel.kind, row.payload);
      }
    },
    "panel-refresh": () => {
      // C2：/agents 手动刷新（无宿主事件面时的手动保鲜路径）
      if (ctx.state.commandPanel!.kind !== "agents") return;
      void ctx.deps.adapter
        .refreshAgents?.()
        .catch(() => ctx.self.notice("subagents 服务不可用", "warn"));
    },
    "panel-close": () => {
      ctx.self.apply((st) => reduceState(st, { type: "command-panel-close" }));
    },

    // ── /history 历史会话面板 ───────────────────────────────────
    "history-move": (k) => {
      const delta = k.name === "down" ? 1 : -1;
      ctx.self.apply((st) => reduceState(st, { type: "history-move", delta }));
    },
    "history-enter": () => {
      const rec = historyVisibleRecords(ctx.state)[ctx.state.history!.index];
      if (!rec) return;
      if (rec.live) {
        ctx.self.notice("live 会话不可续（仅 persisted 会话可切换）", "warn");
        return;
      }
      void ctx.self.resumeToSession(rec.id);
    },
    "history-scope": () => {
      // [Tab]：切换列表范围（当前目录 ⇄ 全部目录），默认当前目录
      ctx.self.apply((st) => reduceState(st, { type: "history-scope-toggle" }));
    },
    "history-mark": () => {
      // Space：批量标记/取消（不可删项以 notice 说明原因）
      ctx.self.toggleMarkRecord();
    },
    "history-mark-all": () => {
      // a：全选当前范围可删项（批量删除入口的快捷全选）
      ctx.self.markAllRecords();
    },
    "history-unmark-all": () => {
      // c：清空批量标记
      ctx.self.clearMarkedRecords();
    },
    "history-delete": () => {
      ctx.self.confirmDeleteRecord();
    },
    "history-clean": () => {
      ctx.self.confirmClean();
    },
    "history-close": () => {
      ctx.self.apply((st) => reduceState(st, { type: "history-close" }));
    },
    "history-view-scroll": (k) => {
      ctx.self.apply((st) =>
        reduceState(st, {
          type: "history-scroll",
          delta: k.name === "down" ? 1 : -1,
        }),
      );
    },
    "history-view-page": (k) => {
      ctx.self.apply((st) =>
        reduceState(st, {
          type: "history-scroll",
          delta: k.name === "pageup" ? -10 : 10,
        }),
      );
    },
    "history-back": () => {
      // 返回列表（列表数据仍在内存）
      ctx.self.apply((st) => reduceState(st, { type: "history-back" }));
    },
    "history-confirm-run": () => {
      void ctx.self.runPendingHistoryOp();
    },
    "history-confirm-cancel": () => {
      ctx.self.apply((st) =>
        reduceState(st, { type: "history-confirm-cancel" }),
      );
    },

    // ── 编辑区（无面板） ────────────────────────────────────────
    "editor-escape": () => {
      // 补全候选打开时 Esc 只收起候选（不打断运行、不动焦点）
      if (ctx.state.completion) {
        ctx.self.apply((s) => reduceState(s, { type: "completion-close" }));
        ctx.self.paint();
        return;
      }
      // Esc：自 2026-10-15 起**不再打断**运行、也**不再退回排队登记**（打断收敛到 `!` 模式，
      // 见 BACKLOG「Esc 取消打断，打断统一由 `!` 模式承担」）——排队内容留在核心 next-turn
      // 队列里等下一回合认领，退回输入区会让同一条消息既在队列又在输入区而重复发送。
      // 剩余语义 = 空输入时退出面板焦点（有焦点 → 回到无焦点 = 跟随最新；聚焦改用
      // Ctrl+E / T / S，Tab 不再进焦点）——**运行中同样生效**（2026-10-15 真机裁定：
      // 忙时 Esc 不打断，但要能回到默认状态）；补全候选与各面板（picker / 审批 / 问答）
      // 已在上方分支处理。
      if (ctx.state.inputText === "" && ctx.state.focusedPanel) {
        ctx.self.apply((s) => ({ ...s, focusedPanel: null }));
      }
    },
    "editor-tab": () => {
      // 补全候选打开时 Tab 接受默认选中的候选（补全不提交）
      if (ctx.state.completion) {
        acceptCompletion();
      }
      // 顶部面板焦点已改由 Ctrl+E / Ctrl+T / Ctrl+S 独占（一键一区域），
      // Tab 不再有全局语义：仅「补全 / 面板内切窗」——编辑输入时也不打断输入
    },
    "editor-scroll": (k) => {
      const name = k.name;
      // 补全候选打开时 ↑/↓ 只在候选间移动（不滚动面板）
      if (ctx.state.completion) {
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "completion-move",
            delta: name === "down" ? 1 : -1,
            // 超出回合区可视行的候选已丢弃：焦点导航同样不超出可视范围
            max: completionVisibleRows(),
          }),
        );
        ctx.self.paint();
        return;
      }
      // 输入历史见 Ctrl+P / Ctrl+N（readline 惯例）：↑/↓ 不再接管输入历史 ——
      // 用户 2026-10-10 裁定，↑/↓ 专用于会话区翻页（含到顶加载更旧回合）
      // 焦点面板滚动（2026-10-10 用户裁定，两处同款）：裸 ↑/↓ = **一行**；Ctrl+↑/↓ =
      // **半屏**（快速翻页）。会话区（history 焦点/无焦点默认）走 scrollDialogueBy；
      // 回合区（回合区）走 focusedLineScroll —— 半屏在此前只落在会话区，
      // 回合区按 Ctrl+↑ 与裸 ↑ 同效（用户真机缺陷）
      const dir: 1 | -1 = name === "up" ? 1 : -1;
      const panel = ctx.state.focusedPanel;
      // 无面板焦点 = 正在编辑输入：↑/↓ 在输入区上下移一行（同显示列），不翻页
      // （2026-10-27 用户裁定：翻页键只在会话 / 回合区聚焦时生效）
      if (panel === null) {
        // 注意方向口径与翻页相反：翻页 +1 = 上滚，输入区 -1 = 上一行
        const cur = inputLineMove(
          ctx.state.inputText,
          ctx.state.inputCursor,
          name === "up" ? -1 : 1,
        );
        ctx.self.apply((s) =>
          reduceState(s, { type: "move-cursor", delta: cur - s.inputCursor }),
        );
        ctx.self.paint();
        return;
      }
      // 可滚动上限由渲染层按内容/窗口算好（上一帧回填或就地补算）：滚键据此收敛
      // 偏移，否则越界偏移（连续上滚越顶、End）会累积成"按了没反应"的假死
      const max = ctx.self.paneScrollMaxOf(panel);
      if (panel === "activity") {
        const step =
          k.ctrl && panel === "activity"
            ? dialogueHalfPage(
                frameGeometry(ctx.state, ctx.deps.renderer.getSize()).activityH,
              )
            : 1;
        // 回合区按「节键 + 行偏移」滚动（与会话区同口径）: 位置锚在活动段键,
        // 扩窗/上方插段不动画面
        ctx.self.scrollActivityBy(dir * step);
      } else if (panel === "status") {
        ctx.self.apply((s) =>
          reduceState(s, focusedLineScroll(panel, dir, max)),
        );
      } else {
        // 位移基准 = 本帧可视行数（缺省回落到几何口径）
        const vh =
          ctx.self.paneMaxes().dialogueViewportH ||
          frameGeometry(ctx.state, ctx.deps.renderer.getSize()).viewportH;
        // 2026-10-10 用户裁定：裸 ↑/↓ = **一行**（默认滚动粒度）；Ctrl+↑/↓ = **半屏**
        // （快速翻页）。两者都走同一套「先扩窗、再按扩窗后的段表施加位移」，
        // 所以 1 行步进到窗口顶时同样只多物化、不多滚（见 scrollDialogueBy）
        ctx.self.scrollDialogueBy(dir * (k.ctrl ? dialogueHalfPage(vh) : 1));
      }
    },
    "editor-page": (k) => {
      const name = k.name;
      // 焦点面板翻页：回合区/状态列保持整页滚动（页 = 面板当前可视行数）；
      // 会话区（history 焦点/无焦点默认）PgUp/PgDn 跳上/下一条用户输入
      const dir: 1 | -1 = name === "pageup" ? 1 : -1;
      const panel = ctx.state.focusedPanel;
      // 无面板焦点 = 编辑输入：PgUp = 行首、PgDn = 行尾（不翻页）
      if (panel === null) {
        const bounds = inputLineBounds(
          ctx.state.inputText,
          ctx.state.inputCursor,
        );
        const target = name === "pageup" ? bounds.start : bounds.end;
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "move-cursor",
            delta: target - s.inputCursor,
          }),
        );
        ctx.self.paint();
        return;
      }
      if (panel === "activity") {
        // 回合区 PgUp/PgDn = 移一个 Step（等级错开: 会话区整 Turn、回合区整 Step）
        ctx.self.scrollActivityStep(dir);
      } else if (panel === "status") {
        const page = frameGeometry(ctx.state, ctx.deps.renderer.getSize());
        ctx.self.apply((s) =>
          reduceState(
            s,
            focusedPageScroll(
              panel,
              dir,
              page,
              ctx.self.paneScrollMaxOf(panel),
            ),
          ),
        );
      } else {
        // 跳转只在已物化范围内找目标：目标不在窗口里（更早回合未物化）→ 先扩窗再翻页。
        // 条目 7 选项 1 回归：恢复出的历史只物化最近 N 组，PgUp 在窗口顶此前直接无反应
        // ——「先按 ↑ 扩窗」这条前提在折叠窗口上不成立（用户真机：按键没有翻页）
        let r = ctx.self.paneMaxes();
        const jump = (): number | undefined =>
          userRowJump(
            r.dialogueUserRows,
            r.dialogueTopIdx,
            r.dialogueViewportH,
            r.dialogueTotal,
            dir,
          );
        let target = jump();
        for (
          let guard = 0;
          target === undefined && dir === 1 && guard < 4;
          guard++
        ) {
          if (
            ctx.state.windowGroups >= sectionGroupCount(sectionsOf(ctx.state))
          )
            break; // 更早回合已全部物化，没有可扩的窗口
          const before = r.dialogueTotal;
          ctx.self.apply((s) =>
            reduceState(s, {
              type: "window-grow",
              groups: s.windowGroups + WINDOW_GROW_STEP,
            }),
          );
          r = ctx.self.paneMaxes();
          if (r.dialogueTotal <= before) break; // 没有更多内容可纳入
          target = jump();
        }
        if (target === undefined) {
          // PgDn 无下一条 → 回到底部跟随最新
          if (dir === -1)
            ctx.self.apply((s) => reduceState(s, { type: "scroll-to-bottom" }));
        } else {
          ctx.self.apply((s) =>
            reduceState(s, {
              type: "dialogue-scroll",
              top: positionAt(
                createLineTable(r.dialogueCounts),
                r.dialogueKeys,
                target,
              ),
              offset: Math.max(0, r.dialogueMaxScroll - target),
            }),
          );
        }
      }
    },
    "editor-home": () => {
      // 无面板焦点（输入区）时：Home = 光标跳到输入开头；面板焦点下仍走会话区滚动
      if (ctx.state.focusedPanel === null) {
        ctx.self.apply((s) =>
          reduceState(s, { type: "move-cursor", delta: -s.inputCursor }),
        );
        ctx.self.paint();
        return;
      }
      // 回合区：Home 一次 → 顶部；再按已到顶 → 无操作（回合区不加载更旧历史）
      if (ctx.state.focusedPanel === "activity") {
        ctx.self.scrollActivityHome();
        return;
      }
      // Home = 往回翻到最旧「已加载」内容（2026-10-06 用户裁定；不一次性全量物化）；
      // 已在最旧已加载处再按 → 再物化一批更早回合，锚点段键不变（内容从上方长出）
      const r = ctx.self.paneMaxes();
      // 「最旧已加载内容」= 段表里第一个**节内容段**（跳过折叠占位行与边界项：
      // 分隔行 / step 头 / 空行 / step 摘要）。钉在边界段键上会在扩窗后解析不到
      // （边界项随窗口重算，如 `sep@18` 消失）→ 走「距底偏移」兜底把视口弹走。
      const firstContent = ((): number => {
        const at = r.dialogueKeys.findIndex(
          (k) =>
            k !== "" &&
            k !== MARKER_KEY &&
            !/^(sep|step|blank|summary)@/.test(k),
        );
        return at >= 0 ? at : 0;
      })();
      if (r.dialogueTopIdx > firstContent) {
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "dialogue-scroll",
            top: positionAt(
              createLineTable(r.dialogueCounts),
              r.dialogueKeys,
              firstContent,
            ),
            offset: Math.max(0, r.dialogueMaxScroll - firstContent),
          }),
        );
        return;
      }
      // 已在最旧已加载：再物化一批，并把视口**显式钉回原内容行**
      if (ctx.state.windowGroups >= sectionGroupCount(sectionsOf(ctx.state)))
        return; // 更早回合已全部物化：无更旧内容，静默不动作
      // 新物化的行都插在视口上方 → 顶行号平移「新增行数」。不靠段键跨扩窗解析：
      // 键随窗口重建会失效，`indexOfTop` 兜底「距底偏移」会把视口弹到新窗口顶部
      // （实测 3 → 6 组时画面从 ⇆18 跳到 ⇆2）。
      const beforeTop = r.dialogueTopIdx;
      const beforeTotal = r.dialogueTotal;
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "window-grow",
          groups: s.windowGroups + WINDOW_GROW_STEP,
        }),
      );
      const after = ctx.self.paneMaxes();
      const target = Math.min(
        after.dialogueMaxScroll,
        beforeTop + Math.max(0, after.dialogueTotal - beforeTotal),
      );
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "dialogue-scroll",
          top: positionAt(
            createLineTable(after.dialogueCounts),
            after.dialogueKeys,
            target,
          ),
          offset: Math.max(0, after.dialogueMaxScroll - target),
        }),
      );
    },
    "editor-end": () => {
      // 无面板焦点（输入区）时：End = 光标跳到输入末尾；面板焦点下仍翻到最新
      if (ctx.state.focusedPanel === null) {
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "move-cursor",
            delta: s.inputText.length - s.inputCursor,
          }),
        );
        ctx.self.paint();
        return;
      }
      // End = 翻到最新（2026-10-06 用户裁定，接管原 Home 行为）：跟随底部 + 渐进窗口复位
      ctx.self.apply((s) => reduceState(s, { type: "scroll-to-bottom" }));
    },
    "editor-left": () => {
      ctx.self.apply((s) => reduceState(s, { type: "move-cursor", delta: -1 }));
    },
    "editor-right": () => {
      ctx.self.apply((s) => reduceState(s, { type: "move-cursor", delta: 1 }));
    },
    "editor-backspace": () => {
      // 光标在开头（含输入为空）时 Backspace 回退模式：切了模式但还没输入时用 Backspace
      // 回 >；有内容时把光标移到最前按 Backspace 同样能回退（2026-10-27 用户裁定）
      if (ctx.state.inputCursor === 0 && ctx.state.inputMode !== "steer") {
        ctx.self.apply((s) =>
          reduceState(s, { type: "input-mode", mode: "steer" }),
        );
      } else {
        ctx.self.apply((s) => backspace(s));
      }
    },
    "editor-enter": () => {
      // Enter 的语义只由**输入模式**决定（2026-10-15 起）：`!` 模式 = 打断并发送（空输入则
      // 只打断）；其余模式 = 排队 / 发送。Alt+Enter（解码层仍把 `ESC CR` / `ESC LF` 合并为
      // 单个 meta+enter）不再有独立语义 → 忽略 `meta`，等效普通 Enter（解码层不动：删合并会
      // 让它退化成「独立 Esc + Enter」两个事件，凭空带出 Esc 的副作用）
      ctx.self.submit(ctx.state.inputMode === "interrupt");
    },
    "editor-paste": (k) => {
      if (k.text) {
        const t = k.text;
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "input",
            text:
              s.inputText.slice(0, s.inputCursor) +
              t +
              s.inputText.slice(s.inputCursor),
            cursor: s.inputCursor + t.length,
          }),
        );
      }
    },
  };

  /** 审批应答：提交裁定、关面板、重绘（原 handleKey 内的本地闭包） */
  function finishApproval(allow: boolean): void {
    ctx.deps.adapter.approve(ctx.state.approval!.id, allow);
    ctx.self.apply((s) => reduceState(s, { type: "approval", approval: null }));
    ctx.self.paint();
  }

  /** 审批焦点窗左右切换（批准 ⇄ 拒绝） */
  function moveApprovalFocus(): void {
    const focus = ctx.state.approvalFocus === "approve" ? "reject" : "approve";
    ctx.self.apply((s) => reduceState(s, { type: "approval-focus", focus }));
    ctx.self.paint();
  }

  function handleKey(k: KeyEvent): void {
    // BACKLOG 3.4.3：任意用户输入（含无效键，人在终端前即算操作）即停止需交互催促响铃，
    // 且同一次交互内不再重启
    ctx.self.clearInteractiveBell();
    if (ctx.disposed) return;
    const { name, ctrl } = k;

    // 审批模式：y/n 应答 + ↑/↓ 滚动描述窗（长草稿查看，BACKLOG 3.2.1）；
    // 其余按键（含 Esc、Ctrl+D、Ctrl+L）一律吞掉——不打断运行、不关闭弹窗、
    // 不改输入模式（“审批模式不变”契约；白名单与无效键提示见 BACKLOG 3.3.1）
    if (ctx.state.approval) {
      // 用户在面板内有过任何操作 → 停止自动超时（BACKLOG 3.3.5：与问答面板「人在场就不催」
      // 一致；此后不再自动裁定，倒计时一并隐藏）。在按键分发前统一处理，含无效键。
      ctx.deps.adapter.stopApprovalTimeout?.(ctx.state.approval!.id);
      if (ctx.state.approvalDeadline !== null) {
        ctx.self.apply((s) => reduceState(s, { type: "approval-no-timeout" }));
      }
      // 审批按键白名单（BACKLOG 3.2.4 / 3.2.6 / 3.3.1）：y/n 与数字键直答、Enter 提交
      // 焦点项、←/→ 切换焦点、↑/↓ 滚草稿、Esc 取消；白名单外按键不落输入区，改在提示行
      // 给出「无效键」提示（提示由 state.approvalHint 承载，任一有效键即清空）。
      const action = lookupKey(APPROVAL_KEYS, name);
      if (action !== undefined) {
        keyActions[action](k);
        return;
      }
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "approval-hint",
          text: "[无效键] 审批仅响应 ←/→ · 1/2 · y/n · Enter · Esc",
        }),
      );
      ctx.self.paint();
      return;
    }

    // 问答面板：↑/↓ 移动选项高亮，←/→ 切换题目（第 n/m 题），Tab 选项<->自定义切换，
    // 空格标记/取消标记选项，Enter 提交整批答案，Esc 仅取消问答（reject ask，不打断 turn）；
    // 自定义输入焦点时可打印字符/退格编辑文本；其余按键吞掉不落入输入区。
    if (ctx.state.question) {
      handleQuestionKey(k);
      return;
    }

    // /model 交互面板：↑/↓ 移动焦点箭头（位置指示），空格把焦点行写入
    // 选中（星号，Enter 提交它，不提交；真实键盘空格为普通字符 " "）；
    // model/思考等级列表跟随星号（选中），不随 > 焦点切换，
    // ←/→ 左右切换三列焦点区（clamp 不循环），Tab 循环切换，Enter 提交各列选中值
    // Esc 先清空本列筛选词、再按一次才关面板；可打印字符 / Backspace 编辑
    // **当前焦点列**的筛选词（provider / model 列各记各的；effort 列不筛，吞掉），
    // 命中项按匹配度排序（见 picker-filter.ts）；其余按键忽略
    if (ctx.state.picker) {
      const action = lookupKey(PICKER_KEYS, name);
      if (action !== undefined) {
        keyActions[action](k);
        return;
      }
      // 筛选词编辑：只在可筛列（provider / model）生效
      if (pickerFilterColumn(ctx.state.picker.phase) !== null) {
        const text = pickerFilterInput(
          pickerFilterText(ctx.state.picker),
          name,
          k.ctrl,
        );
        if (text !== null) {
          ctx.self.apply((s) =>
            reduceState(s, { type: "picker-filter", text }),
          );
          ctx.self.paint();
        }
      }
      return;
    }

    // 通用状态选项面板（/policy /permission）：↑/↓ 移动焦点、空格预选
    // （星号，再按取消）、Enter 提交预选（无预选回退焦点）并关闭、Esc 取消
    if (ctx.state.statusPanel) {
      const action = lookupKey(STATUS_PANEL_KEYS, name);
      if (action !== undefined) keyActions[action](k);
      return;
    }

    // /jobs 任务面板：↑/↓ 移动高亮、PgUp/PgDn 整页（页高=回合区可视行数，与共享面板
    // 同 frameGeometry 口径）、Enter 取消高亮任务、Esc 关闭；其余按键吞掉
    if (ctx.state.jobsPanel) {
      const action = lookupKey(JOBS_PANEL_KEYS, name);
      if (action !== undefined) keyActions[action](k);
      ctx.self.paint();
      return;
    }

    // 共享列表面板（/skills 等）：↑/↓ 移动、PgUp/PgDn 整页、Enter 主操作、Esc 关闭；其余吞掉
    if (ctx.state.commandPanel) {
      const action = lookupKey(COMMAND_PANEL_KEYS, name);
      if (action !== undefined) keyActions[action](k);
      ctx.self.paint();
      return;
    }

    // /history 历史会话面板：list 阶段 ↑/↓ 移动、Enter 查看、Esc 关闭；
    // view 阶段 ↑/↓/PgUp/PgDn 滚动、Esc 返回列表；loading/error 阶段吞键（error 可 Esc 关闭）
    if (ctx.state.history) {
      const h = ctx.state.history;
      if (h.phase === "list") {
        const action = lookupKey(HISTORY_LIST_KEYS, name);
        if (action !== undefined) keyActions[action](k);
      } else if (h.phase === "view") {
        const action = lookupKey(HISTORY_VIEW_KEYS, name);
        if (action !== undefined) keyActions[action](k);
      } else if (h.phase === "confirm-delete" || h.phase === "confirm-clean") {
        // 二次确认：y/Enter 执行、n/Esc 取消（其余键吞掉，避免误触）
        const action = lookupKey(HISTORY_CONFIRM_KEYS, name);
        if (action !== undefined) keyActions[action](k);
      } else if (h.phase === "deleting" || h.phase === "cleaning") {
        // 进行中：吞键；完成后由 history-delete-done / history-clean-done 回列表
      } else if (h.phase === "error") {
        const action = lookupKey(HISTORY_ERROR_KEYS, name);
        if (action !== undefined) keyActions[action](k);
      }
      ctx.self.paint();
      return;
    }

    // Ctrl+D：仅 idle 且输入区为空时**请求退出确认**（输入非空时按无操作忽略）；
    // 确认走 App.dispose——单字节误触（如终端/复用器注入的 0x04）不再直接结束会话
    if (ctrl && name === "d") {
      if (canExitOnCtrlD(ctx.state)) {
        requestExitConfirm();
      }
      return;
    }

    // Ctrl+S：聚焦状态列；该列已聚焦时收起（隐藏）+ 焦点回会话区。
    // 「一键一区域」（2026-10-14 用户裁定，取代「Tab 焦点循环 + 纯显隐开关」两态）；
    // 收起后会话区变宽，需要整帧重排；显隐状态随会话持久化（tui-state.json）。
    if (ctrl && name === "s") {
      ctx.self.apply((s) =>
        reduceState(s, { type: "focus-panel", panel: "status" }),
      );
      ctx.self.scheduleSessionStateSave();
      ctx.self.paint();
      return;
    }

    // Ctrl+T：聚焦回合区（下半区：Turn 流 + 工具区）；已聚焦时收起 + 焦点回会话区（同上口径）。
    // 收起后会话区变高，需要整帧重排；显隐状态随会话持久化（tui-state.json）。
    if (ctrl && name === "t") {
      ctx.self.apply((s) =>
        reduceState(s, { type: "focus-panel", panel: "activity" }),
      );
      ctx.self.scheduleSessionStateSave();
      ctx.self.paint();
      return;
    }

    // Ctrl+E：聚焦会话区（会话区）；已聚焦时回到无焦点（= 跟随最新）。会话区恒显示，
    // 无显隐可持久化，故不触发 sessionStateSave。
    if (ctrl && name === "e") {
      ctx.self.apply((s) =>
        reduceState(s, { type: "focus-panel", panel: "history" }),
      );
      ctx.self.paint();
      return;
    }

    // Ctrl+P / Ctrl+N：输入历史回溯（BACKLOG TUI#34；readline 惯例）。
    // 2026-10-10 裁定（用户）：**↑/↓ 专用于会话区翻页**（含到顶加载更旧回合），
    // 输入历史改用 Ctrl+P / Ctrl+N —— 原先 ↑ 在「空输入 + 历史非空」时也会接管，
    // 按 ↑ 看到的是输入区在旧输入之间循环、会话区纹丝不动。
    if (ctrl && (name === "p" || name === "n")) {
      if (ctx.state.focusedPanel !== null) return; // 面板焦点下不接管（面板自有键位）
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "input-history",
          action: name === "p" ? "prev" : "next",
        }),
      );
      ctx.self.paint();
      return;
    }

    // Ctrl+L：强制整帧重绘（绕过 delta 优化）。放在 switch 前，避免吞掉普通 'l' 输入。
    if (ctrl && name === "l") {
      ctx.self.refresh();
      return;
    }

    // Ctrl+J：输入区插入换行符（Enter 仍为发送；renderer 将裸 LF 0x0a 解码为 ctrl+j）
    if (ctrl && name === "j") {
      insertChar("\n");
      ctx.self.paint();
      return;
    }

    // Ctrl+C：清空输入区（不发送）；750ms 双击窗口内再次 Ctrl+C **请求退出确认**
    // （输入为空时首次只计数不清空，第二次请求；输入非空时首次清空并计入）
    if (ctrl && name === "c") {
      const now = Date.now();
      if (now - ctx.lastCtrlCAt <= CTRL_C_DOUBLE_MS) {
        requestExitConfirm();
        return;
      }
      ctx.lastCtrlCAt = now;
      if (ctx.state.inputText !== "") {
        ctx.self.apply((s) =>
          reduceState(s, { type: "input", text: "", cursor: 0 }),
        );
        ctx.self.paint();
      }
      return;
    }

    // 编辑区按键：查表（见 app/keys.ts 的 EDITOR_KEYS）；未命中的键走下方缺省分支
    const action = lookupKey(EDITOR_KEYS, name);
    if (action !== undefined) {
      keyActions[action](k);
      ctx.self.paint();
      return;
    }

    // 缺省分支 —— 模式键：光标在**整个输入的开头**时按 $ / / / < / ! 切换模式并吞键（$ shell /
    // / slash / < followup / ! interrupt（打断并发送）；同符号幂等；提交后自动回退默认 >）。
    // 判据是「光标在开头」而非「输入为空」：已有内容时把光标移到最前也能切模式，
    // 切完再打字即带模式提交（2026-10-27 用户裁定）。
    if (
      name.length === 1 &&
      !ctrl &&
      ctx.state.inputCursor === 0 &&
      (name === "$" || name === "/" || name === "<" || name === "!")
    ) {
      const mode: InputMode =
        name === "$"
          ? "shell"
          : name === "/"
            ? "slash"
            : name === "<"
              ? "followup"
              : "interrupt";
      if (ctx.state.inputMode !== mode) {
        ctx.self.apply((s) => reduceState(s, { type: "input-mode", mode }));
      }
      ctx.self.paint();
      return;
    }
    // 可打印字符：插入输入区（Esc/Ctrl+C 已在上方 Ctrl 分支处理，不落入此处）
    if (name.length === 1 && !ctrl) insertChar(name);
    ctx.self.paint();
  }

  /** 问答面板按键路由（approval 之后 picker 之前，见 handleKey）：
   * 路由决策为纯函数 questionKeyDecision，副作用（adapter 调用 / paint）在此执行 */
  /** 问答描述窗滚动上界（BACKLOG 3.2.1）：按当前几何算折行后的最大首行偏移 */
  function questionDescScrollMax(): number {
    const panel = ctx.state.question;
    if (!panel) return 0;
    const geom = frameGeometry(ctx.state, ctx.deps.renderer.getSize());
    return maxDescScrollFor(panel, geom.activityH, geom.activityTextW);
  }

  /** 审批描述窗滚动上界（长草稿可滚动，BACKLOG 3.2.1） */
  function approvalScrollMax(): number {
    const approval = ctx.state.approval;
    if (!approval) return 0;
    const geom = frameGeometry(ctx.state, ctx.deps.renderer.getSize());
    return maxApprovalScroll(approval, geom.activityH, geom.activityTextW);
  }

  /** 审批超时（ms）：优先取 adapter 实际生效值（保证倒计时与裁定同源，BACKLOG 3.3.2） */
  function approvalTimeoutMs(): number {
    const fromAdapter = ctx.deps.adapter.approvalTimeoutMs?.();
    return typeof fromAdapter === "number" && fromAdapter > 0
      ? fromAdapter
      : APPROVAL_TIMEOUT_FALLBACK_MS;
  }

  function handleQuestionKey(k: KeyEvent): void {
    const panel = ctx.state.question;
    if (!panel) return;
    const d = questionKeyDecision(panel, k.name, k.ctrl);
    switch (d.kind) {
      case "cancel":
        // Esc：cancelQuestion 内部完成关面板 + adapter.cancelQuestion + paint
        cancelQuestion();
        return;
      case "submit":
        submitQuestion(); // 内部已含 paint
        ctx.self.paint(); // 保持原实现的二次 paint 时机
        return;
      case "nav":
        ctx.self.apply((s) =>
          reduceState(s, { type: "question-nav", delta: d.delta }),
        );
        break;
      case "move":
        ctx.self.apply((s) =>
          reduceState(s, { type: "question-move", delta: d.delta }),
        );
        break;
      case "custom-edit":
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "question-custom",
            text: d.text,
            caret: d.caret,
          }),
        );
        break;
      case "custom-caret":
        ctx.self.apply((s) =>
          reduceState(s, { type: "custom-caret", delta: d.delta }),
        );
        break;
      case "select":
        ctx.self.apply((s) => reduceState(s, { type: "question-select" }));
        break;
      case "digit": {
        // 数字键直接标记第 n 项（BACKLOG 3.2.6）：越界吞掉；只标记不提交（提交仍由 Enter）
        const item = panel.items[panel.itemIndex];
        const total = item?.options.length ?? 0;
        if (d.n < 1 || d.n > total) return;
        const cur = item?.optionIndex ?? 0;
        if (cur !== d.n - 1) {
          ctx.self.apply((s) =>
            reduceState(s, { type: "question-move", delta: d.n - 1 - cur }),
          );
        }
        ctx.self.apply((s) => reduceState(s, { type: "question-select" }));
        break;
      }
      case "focus":
        // Tab：描述窗 <-> 选项窗切换（BACKLOG 3.2.1）
        ctx.self.apply((s) => reduceState(s, { type: "question-focus" }));
        break;
      case "desc-scroll":
        // 描述窗逐行滚动：上界按当前几何算定（state 层不知道折行宽度）
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "question-desc-scroll",
            delta: d.delta,
            max: questionDescScrollMax(),
          }),
        );
        break;
      case "none":
        // 其余按键吞掉（不落入主输入区）
        return;
    }
    ctx.self.paint();
  }

  /** 退出确认（BACKLOG「tmux 断连后 dsh 退出」）：以合成问答面板请求确认——默认高亮
   *  「取消/留在 TUI」，Esc 取消，Enter 确认高亮项；仅在确认「退出 dsh」后 `dispose()`。
   *  复用问答面板机制（零新增按键路由），不调用 adapter（合成面板无宿主 ask）。
   *  已打开时幂等（不叠面板）；已 dispose 时无操作。 */
  function requestExitConfirm(): void {
    if (ctx.disposed || ctx.exitConfirmOpen) return;
    ctx.exitConfirmOpen = true;
    // 第三项仅在「有人接住退出码 75」时提供（启动器经 DSH_RESTART_FILE 声明；BACKLOG #51）
    const options = [
      { label: "取消", description: "留在 TUI（默认）" },
      { label: "退出 dsh", description: "关闭会话并退出" },
    ];
    options.push({
      label: EXIT_CONFIRM_CLEAN_LABEL,
      description: "删除本会话的记录与历史后退出（不可恢复）",
    });
    if (restartAvailable()) {
      options.push({
        label: EXIT_CONFIRM_RESTART_LABEL,
        description: "保留会话，由启动器重启 dsh",
      });
    }
    ctx.self.apply((s) =>
      reduceState(s, {
        type: "question-open",
        id: EXIT_CONFIRM_PANEL_ID,
        questions: [
          {
            id: EXIT_CONFIRM_PANEL_ID,
            question: "确认退出 dsh？",
            header: "退出",
            options,
          },
        ],
      }),
    );
    ctx.self.paint();
  }

  /** 重启可用性：启动器已给出交接文件路径（空串/缺省 = 直接启动，不提供重启项） */
  function restartAvailable(): boolean {
    const path = ctx.deps.restartHandoffPath;
    return typeof path === "string" && path !== "";
  }

  /** 写重启交接文件：当前活跃会话 id 单行（`0600`）。写失败只告警——退出码 75 不变，
   *  启动器读不到 id 会自动退回 `-c`（见 DESIGN 契约）。无活跃会话时不写文件。 */
  function writeRestartHandoff(): void {
    const path = ctx.deps.restartHandoffPath;
    if (typeof path !== "string" || path === "") return;
    const sessionId =
      ctx.state.activeSessionId ?? ctx.deps.adapter.sessionId ?? "";
    if (sessionId === "") return;
    try {
      writeFileSync(path, `${sessionId}\n`, { mode: 0o600 });
    } catch (err) {
      process.stderr.write(
        `[tui] warn: 重启交接文件写入失败（${String(err)}），启动器将退回 -c\n`,
      );
    }
  }

  /** 请求重启（单一来源）：写交接文件 → 置退出码（renderer.close 尊重既有 exitCode）→
   *  跳过空会话清理收尾。退出确认面板第三项与 `/restart` 共用（BACKLOG TUI「/restart 命令」）。 */
  function requestRestart(): void {
    writeRestartHandoff();
    process.exitCode = DSH_RESTART_EXIT_CODE;
    ctx.restartPending = true;
    ctx.self.dispose();
  }

  /** `/restart`：显式命令直接执行（不弹确认面板，与 `/quit` 同口径）。无启动器声明
   *  （`DSH_RESTART_FILE` 未设，见 DESIGN「退出确认 ·「重启」方案」）时只提示、不退出——
   *  没有接收方的退出码 75 会退化成「静默普通退出」。 */
  function handleRestartCommand(): void {
    if (!restartAvailable()) {
      ctx.self.notice(
        "重启不可用：需由启动器启动（未设置 DSH_RESTART_FILE）",
        "warn",
      );
      return;
    }
    requestRestart();
  }

  /** 合成退出确认面板的收尾：确认「退出 dsh」才走原 dispose，否则仅关面板 */
  function finishExitConfirm(panel: QuestionPanelState): void {
    ctx.exitConfirmOpen = false;
    const answer = buildQuestionAnswers(panel);
    ctx.self.apply((s) => reduceState(s, { type: "question-close" }));
    const picked = answer.answers[0]?.selected[0];
    if (picked === EXIT_CONFIRM_RESTART_LABEL) {
      requestRestart();
      return;
    }
    if (picked === EXIT_CONFIRM_CLEAN_LABEL) {
      requestCleanQuit();
      return;
    }
    if (picked !== "退出 dsh") {
      ctx.self.paint();
      return;
    }
    ctx.self.dispose();
  }

  /** 请求「清理并退出」（单一来源）：删除当前会话的记录与历史后退出。删除动作不在
   *  这里执行——先置 `cleanQuitPending`，由 dispose 收尾在 adapter.dispose()（handle 已释放）
   *  之后、renderer.close() 之前删除（顺序见 `finishDispose`）。
   *  退出确认面板的「清理并退出」项与 `/cleanquit`（后者先弹确认面板）共用本方法。 */
  function requestCleanQuit(): void {
    ctx.cleanQuitConfirmOpen = false;
    ctx.cleanQuitPending = true;
    ctx.self.dispose();
  }

  /** `/cleanquit`：显式命令也走二次确认（删除不可逆）——弹合成确认面板，默认高亮「取消」，
   *  Esc 取消；确认后才 `requestCleanQuit()`。 */
  function openCleanQuitConfirm(): void {
    if (ctx.disposed || ctx.cleanQuitConfirmOpen) return;
    ctx.cleanQuitConfirmOpen = true;
    const sessionId =
      ctx.state.activeSessionId ?? ctx.deps.adapter.sessionId ?? "";
    ctx.self.apply((s) =>
      reduceState(s, {
        type: "question-open",
        id: CLEAN_QUIT_PANEL_ID,
        questions: [
          {
            id: CLEAN_QUIT_PANEL_ID,
            question:
              sessionId === ""
                ? "清理并退出？将删除本会话的记录与历史（不可恢复）"
                : `清理并退出？将删除会话 ${sessionId} 的记录与历史（不可恢复）`,
            header: "清理并退出",
            options: [
              { label: "取消", description: "留在 TUI（默认）" },
              {
                label: CLEAN_QUIT_CONFIRM_LABEL,
                description: "删除本会话的记录与历史后退出",
              },
            ],
          },
        ],
      }),
    );
    ctx.self.paint();
  }

  /** 合成「清理并退出」确认面板收尾：确认才 `requestCleanQuit()`，否则仅关面板 */
  function finishCleanQuitConfirm(panel: QuestionPanelState): void {
    ctx.cleanQuitConfirmOpen = false;
    const answer = buildQuestionAnswers(panel);
    ctx.self.apply((s) => reduceState(s, { type: "question-close" }));
    const picked = answer.answers[0]?.selected[0];
    if (picked !== CLEAN_QUIT_CONFIRM_LABEL) {
      ctx.self.paint();
      return;
    }
    requestCleanQuit();
  }

  /** 提交问答：整批 answer 交给 adapter（answerQuestion → resolve ask）并关闭面板 */
  function submitQuestion(): void {
    const panel = ctx.state.question;
    if (!panel) return;
    if (panel.id === EXIT_CONFIRM_PANEL_ID) {
      finishExitConfirm(panel);
      return;
    }
    if (panel.id === CLEAN_QUIT_PANEL_ID) {
      finishCleanQuitConfirm(panel);
      return;
    }
    const answer = buildQuestionAnswers(panel);
    ctx.self.apply((s) => reduceState(s, { type: "question-close" }));
    ctx.deps.adapter.answerQuestion(panel.id, answer);
    ctx.self.paint();
  }

  /** 取消问答：reject ask（不打断 turn），关闭面板 */
  function cancelQuestion(): void {
    const panel = ctx.state.question;
    if (!panel) return;
    if (panel.id === EXIT_CONFIRM_PANEL_ID) {
      ctx.exitConfirmOpen = false;
      ctx.self.apply((s) => reduceState(s, { type: "question-close" }));
      ctx.self.paint();
      return;
    }
    if (panel.id === CLEAN_QUIT_PANEL_ID) {
      ctx.cleanQuitConfirmOpen = false;
      ctx.self.apply((s) => reduceState(s, { type: "question-close" }));
      ctx.self.paint();
      return;
    }
    ctx.self.apply((s) => reduceState(s, { type: "question-close" }));
    ctx.deps.adapter.cancelQuestion(panel.id);
    ctx.self.paint();
  }

  /** 接受补全候选（Tab）：候选名写入输入区并补尾随空格（便于接参数），
   *  列表随输入重算自动收起（`/name ` 已非命令 token）。 */
  /** 补全面板可显示的候选行数（回合区可视行 - 标题行；与 CommandCompletion 渲染同口径） */
  function completionVisibleRows(): number {
    const activityH = frameGeometry(
      ctx.state,
      ctx.deps.renderer.getSize(),
    ).activityH;
    return Math.max(1, activityH - 1);
  }

  function acceptCompletion(): void {
    const c = ctx.state.completion;
    if (!c) return;
    if (c.kind === "file") {
      acceptFileMention(c);
      return;
    }
    // 可见候选内取焦点项（可视行之外的候选已被渲染丢弃，不需也不应被接受）
    const visible = Math.min(c.items.length, completionVisibleRows());
    const item = c.items[Math.min(c.index, Math.max(0, visible - 1))];
    if (!item) return;
    const text = (ctx.state.inputMode === "slash" ? "" : "/") + item.name + " ";
    ctx.self.apply((s) =>
      reduceState(s, { type: "input", text, cursor: text.length }),
    );
    ctx.self.paint();
  }

  /**
   * 接受提及候选（Tab）：按活动 token 的 prefix **就地**替换——`@` 前后的正文都保留
   * （与命令候选的整串替换不同）。文件补尾随空格收尾该提及；目录不加空格、引号保持打开，
   * 面板由输入重算自动续开到下一级（新 token 触发下一轮查询）。路径无法安全表示时
   * （控制字符 / 内嵌引号）不插入、不改输入。
   */
  function acceptFileMention(
    c: Extract<CompletionState, { kind: "file" }>,
  ): void {
    const visible = Math.min(c.items.length, completionVisibleRows());
    const item = c.items[Math.min(c.index, Math.max(0, visible - 1))];
    if (!item) return;
    const insert = mentionInsertText(item, c.token.quoted);
    if (insert === undefined) return;
    const { text, cursor } = replaceActiveToken(
      ctx.state.inputText,
      ctx.state.inputCursor,
      c.token.prefix,
      insert,
    );
    ctx.self.apply((s) => reduceState(s, { type: "input", text, cursor }));
    ctx.self.paint();
  }

  /**
   * 提及候选请求的唯一调度点（每次 apply 后判定）：只认「当前 completion 是 file 类」，
   * 且 token 与上一状态相比**发生了变化**（连续输入合并到一次查询；同一 token 的重绘
   * 不重发）。面板收起 / 切到命令候选 → 取消排队与在途请求，不留悬挂。
   */
  function syncFileMentionRequest(prev: AppState): void {
    const c = ctx.state.completion;
    if (!c || c.kind !== "file") {
      cancelMentionRequest();
      return;
    }
    const p = prev.completion;
    const sameToken =
      p?.kind === "file" &&
      p.token.prefix === c.token.prefix &&
      p.token.query === c.token.query &&
      p.token.quoted === c.token.quoted;
    if (sameToken) return;
    const token = c.token;
    cancelMentionRequest();
    ctx.mentionTimer = setTimeout(() => {
      ctx.mentionTimer = null;
      const list = ctx.deps.adapter.listFileCandidates;
      if (!list) return;
      const ac = new AbortController();
      ctx.mentionAbort = ac;
      // 服务缺失（旧接线）/ 抛错都已由 adapter 归一为空数组；这里只兜住 Promise 面
      void list
        .call(ctx.deps.adapter, token.query, ac.signal)
        .then((items) => {
          if (ctx.mentionAbort === ac) ctx.mentionAbort = null;
          if (ctx.disposed) return;
          ctx.self.apply((s) =>
            reduceState(s, { type: "completion-data", token, items }),
          );
          ctx.self.paint();
        })
        .catch(() => {
          if (ctx.mentionAbort === ac) ctx.mentionAbort = null;
        });
    }, MENTION_DEBOUNCE_MS);
    ctx.mentionTimer.unref?.(); // 不阻止测试进程退出
  }

  /** 取消提及候选的排队与在途请求（面板收起 / 切类 / 新 token / 释放） */
  function cancelMentionRequest(): void {
    if (ctx.mentionTimer !== null) {
      clearTimeout(ctx.mentionTimer);
      ctx.mentionTimer = null;
    }
    if (ctx.mentionAbort !== null) {
      ctx.mentionAbort.abort();
      ctx.mentionAbort = null;
    }
  }

  /** 探测宿主文件提及服务（ctx.fileReferences）：可用则打开 `@` 补全；缺失则 `@`
   *  按普通字符输入（无面板、无报错），与「服务未挂载」的降级口径一致 */
  function refreshFileMention(): void {
    const available = typeof ctx.deps.adapter.listFileCandidates === "function";
    ctx.self.apply((s) =>
      reduceState(s, { type: "file-mention-available", available }),
    );
  }

  function insertChar(c: string): void {
    const cur = ctx.state.inputCursor;
    const text =
      ctx.state.inputText.slice(0, cur) + c + ctx.state.inputText.slice(cur);
    ctx.self.apply((s) =>
      reduceState(s, { type: "input", text, cursor: cur + c.length }),
    );
  }

  function backspace(s: AppState): AppState {
    const cur = Math.max(0, s.inputCursor - 1);
    const text = s.inputText.slice(0, cur) + s.inputText.slice(s.inputCursor);
    return reduceState(s, { type: "input", text, cursor: cur });
  }

  return {
    finishApproval,
    moveApprovalFocus,
    handleKey,
    questionDescScrollMax,
    approvalScrollMax,
    approvalTimeoutMs,
    handleQuestionKey,
    requestExitConfirm,
    restartAvailable,
    writeRestartHandoff,
    requestRestart,
    handleRestartCommand,
    finishExitConfirm,
    requestCleanQuit,
    openCleanQuitConfirm,
    finishCleanQuitConfirm,
    submitQuestion,
    cancelQuestion,
    completionVisibleRows,
    acceptCompletion,
    acceptFileMention,
    syncFileMentionRequest,
    cancelMentionRequest,
    refreshFileMention,
    insertChar,
    backspace,
  };
}
