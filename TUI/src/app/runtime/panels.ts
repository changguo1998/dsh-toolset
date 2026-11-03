// TUI/src/app/runtime/panels.ts — 面板与模型选择: 列表面板、状态面板、/jobs、模型选择交互
//
// 2026-11-04 拆分自 TUI/src/app/index.ts 的 App 类体: 方法体只做 this. -> ctx. 改写,
// 跨模块调用经 ctx.self, 公共状态在 ./context.ts.

import type { StatusPanelState } from "../state.ts";
import { reduceState } from "../state.ts";
import type {
  ModelCatalog,
  ModelSelection,
  CommandPanelKind,
} from "../adapter/dsh.ts";
import {
  buildPickerInit,
  pickerEffortIndex,
  planModelSwitch,
  resolvePickerSelection,
} from "../model-transition.ts";
import { pickerFocusedValues } from "../picker-filter.ts";
import { modelLabel } from "../layout.ts";
import type { AppContext } from "./context.ts";

export function createPanelsPart(ctx: AppContext) {
  /** 面板打开期间定时刷新（/agents、/workflows 共用；间隔 agentsRefreshIntervalMs 默认 2s）。
   *  增量事件面不实时推全量（/agents 无事件面、/workflows 增量仅维护内部集合），由本定时器
   *  tick 自检面板 kind 仍匹配时重拉；否则停表（覆盖 Esc/Enter/重复 kind 关闭等全部关闭路径）。 */
  function startPanelRefresh(opts: {
    kind: CommandPanelKind;
    refresh: (() => Promise<void>) | undefined;
    label: string;
  }): void {
    if (ctx.panelRefreshTimer || ctx.disposed) return;
    ctx.panelRefreshCtx = opts;
    const intervalMs = ctx.deps.agentsRefreshIntervalMs ?? 2000;
    ctx.panelRefreshTimer = setInterval(() => panelRefreshTick(), intervalMs);
  }

  function stopPanelRefresh(): void {
    if (ctx.panelRefreshTimer) {
      clearInterval(ctx.panelRefreshTimer);
      ctx.panelRefreshTimer = null;
    }
    ctx.panelRefreshCtx = null;
  }

  function panelRefreshTick(): void {
    if (ctx.disposed) {
      stopPanelRefresh();
      return;
    }
    const panel = ctx.state.commandPanel;
    const panelCtx = ctx.panelRefreshCtx;
    if (!panel || !panelCtx || panel.kind !== panelCtx.kind) {
      // 面板已关或切到别的 kind：停表（不空刷）
      stopPanelRefresh();
      return;
    }
    void panelCtx.refresh
      ?.call(ctx.deps.adapter)
      .catch(() => ctx.self.notice(`${panelCtx.label} 服务不可用`, "warn"));
  }

  /** 无参 /model：进入交互选择模式（当前模型行始终显示，不在候选目录中也补行）；
   *  phase 为焦点列（/model 缺省 model 列；/provider、/effort 别名显式传入） */
  function openModelPicker(catalog: ModelCatalog, phase: 0 | 1 | 2 = 1): void {
    const init = buildPickerInit(catalog);
    if (!init.ok) {
      ctx.self.notice(
        "no available models (llm service missing or no adapter registered)",
        "warn",
      );
      return;
    }
    ctx.self.apply((s) =>
      reduceState(s, {
        type: "picker-open",
        picker: { ...init.picker, phase },
      }),
    );
    ctx.self.paint();
    void reloadPickerEfforts();
  }

  /** 按选中（星号）model 异步加载思考等级，落定后再下发（面板可能已关闭/换选） */
  async function reloadPickerEfforts(): Promise<void> {
    const picker = ctx.state.picker;
    if (!picker) return;
    // 思考等级列表跟随选中（星号）模型，不随 > 焦点变化；未选中回退焦点行
    // （焦点行按可见列表取 —— 与渲染同源，见 picker-filter.ts）
    const focused = pickerFocusedValues(picker);
    const model = picker.selectedModel ?? focused.model;
    const provider = picker.selectedProvider ?? focused.provider;
    if (!model) return;
    try {
      const meta = await ctx.deps.adapter.modelReasoning?.(
        provider ?? "",
        model,
      );
      if (ctx.disposed) return;
      const cur = ctx.state.picker;
      if (!cur) return;
      const curFocused = pickerFocusedValues(cur);
      const prevModel = cur.selectedModel ?? curFocused.model;
      const prevProvider = cur.selectedProvider ?? curFocused.provider;
      if (prevModel !== model || prevProvider !== provider) {
        return; // 已切换选中模型/provider 或面板关闭，丢弃旧结果
      }
      // 当前生效模型自带等级时，预设为列表中同一等级；未显式选择时按 provider
      // 默认等级（defaultEffort）预设，保证面板高亮与实际生效 effort 一致
      const expectedIndex = pickerEffortIndex(
        cur,
        model,
        provider,
        meta?.efforts,
        meta?.defaultEffort,
      );
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "picker-efforts",
          efforts: meta?.efforts ?? [],
          effortIndex: expectedIndex,
        }),
      );
      ctx.self.paint();
    } catch {
      // 加载失败保持空列表（面板显示"unsupported"）
    }
  }

  /** 选择面板确认：应用各列选中值（星号所指，回退焦点/当前）后退出 */
  async function confirmModelPicker(): Promise<void> {
    const picker = ctx.state.picker;
    if (!picker) return;
    const selection = resolvePickerSelection(picker);
    ctx.self.apply((s) => reduceState(s, { type: "picker-close" }));
    if (!selection) return;
    try {
      await applyModelSelection(selection);
    } catch (err) {
      ctx.self.notice("model command failed: " + String(err), "error");
    }
  }

  /** 切换当前会话模型（只改会话内引用，不写宿主设置）；/model 带参与交互选择共用 */
  async function applyModelSelection(selection: ModelSelection): Promise<void> {
    const catalog = await ctx.deps.adapter.modelCatalog();
    const plan = planModelSwitch(selection, catalog.current);
    if (plan.same) {
      const label = modelLabel(selection);
      ctx.self.notice(`already on current model ${label}`, "info");
      return;
    }
    const saved = await ctx.deps.adapter.setSessionModel(plan.selection);
    const label = modelLabel(saved);
    const thinking = await ctx.self.resolveThinking(
      saved.provider,
      saved.model,
      saved.reasoningEffort,
    );
    if (ctx.disposed) return;
    ctx.self.apply((s) =>
      reduceState(s, {
        type: "status",
        status: { model: label, modelThinking: thinking },
      }),
    );
    // 记入会话状态（modelBySession 同时是快照的模型来源；切回本会话时按它恢复）
    ctx.self.apply((s) =>
      reduceState(s, {
        type: "model-selection",
        sessionId:
          ctx.state.activeSessionId ?? ctx.deps.adapter.sessionId ?? "",
        provider: saved.provider,
        model: saved.model,
        ...(saved.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: saved.reasoningEffort }),
      }),
    );
    ctx.self.scheduleSessionStateSave();
    ctx.self.notice(`current model -> ${label}`, "success");
  }

  /** 打开通用状态选项面板（/policy /permission 无参路径） */
  function openStatusPanel(panel: StatusPanelState): void {
    if (ctx.disposed) return;
    ctx.self.apply((s) => reduceState(s, { type: "status-panel-open", panel }));
    ctx.self.paint();
  }

  /** 提交状态面板：取预选（无预选回退焦点行）→ 按命令写路径应用 → 关闭面板 */
  async function commitStatusPanel(): Promise<void> {
    const panel = ctx.state.statusPanel;
    if (!panel) return;
    const id = panel.selected ?? panel.options[panel.index]?.id ?? null;
    // 先关面板再应用（“提交修改后直接关闭”）
    ctx.self.apply((s) => reduceState(s, { type: "status-panel-close" }));
    ctx.self.paint();
    if (!id) return;
    const adapter = ctx.deps.adapter;
    if (panel.kind === "policy") {
      const setPolicy = adapter.setApprovalPolicy;
      if (!setPolicy) {
        ctx.self.notice("审批策略服务不可用", "warn");
        return;
      }
      // SAFETY: 接收者绑定调用（见 handlePolicyCommand 注释）
      try {
        await setPolicy.call(adapter, id as "ask" | "never");
        ctx.self.notice(
          id === "ask"
            ? "审批策略：ask（每次工具调用询问）"
            : "审批策略：never（工具调用自动放行）",
          "success",
        );
      } catch {
        ctx.self.notice("审批策略服务不可用", "warn");
      }
      return;
    }
    if (panel.kind === "permission") {
      // 权限预设：转发宿主 /permission（宿主校验预设名 + 写路径）
      adapter.runCommand(
        "/permission " + id,
        ctx.state.activeSessionId ?? undefined,
      );
      return;
    }
  }

  /** 通用列表面板命令（/skills、/agents、/tools）：服务缺失 → warn 且不空开面板
   *  （面板占回合区、会盖住瞬态输出）；无参重复调用同 kind = 关闭（交互路径需先 Esc，
   *  面板态按键被吞、与 /jobs 一致）；打开时互斥关闭 history / picker / jobsPanel；
   *  随后经 refresh 拉数据（filter 为空时传 undefined）。 */
  function openListPanel(opts: {
    kind: CommandPanelKind;
    /** 服务名（notice 文案：`<label> 服务不可用`） */
    label: string;
    refresh?: (filter?: string) => Promise<void>;
    /** 命令参数（skills/tools 作 filter；agents 传 ""） */
    filter: string;
  }): void {
    const { kind, label, refresh, filter } = opts;
    if (!refresh) {
      ctx.self.notice(`${label} 服务不可用`, "warn");
      return;
    }
    if (ctx.state.commandPanel?.kind === kind && filter === "") {
      ctx.self.apply((s) => reduceState(s, { type: "command-panel-close" }));
      ctx.self.paint();
      return;
    }
    // 互斥：打开时关闭 history / picker / jobsPanel（其余 kind 由 open 覆盖）
    ctx.self.apply((s) => {
      let next = s;
      if (next.history) next = reduceState(next, { type: "history-close" });
      if (next.picker) next = reduceState(next, { type: "picker-close" });
      if (next.jobsPanel)
        next = reduceState(next, { type: "jobs-panel-close" });
      return reduceState(next, { type: "command-panel-open", kind });
    });
    ctx.self.paint();
    void refresh
      .call(ctx.deps.adapter, filter === "" ? undefined : filter)
      .catch(() => {
        // 拉取失败（如 /search 全部 provider 失败、服务缺失返回 reject）：
        // 先关面板再 notice——面板占满回合区会遮住瞬态 notice；也不留空面板。
        stopPanelRefresh();
        ctx.self.apply((s) =>
          s.commandPanel ? reduceState(s, { type: "command-panel-close" }) : s,
        );
        ctx.self.paint();
        ctx.self.notice(`${label} 服务不可用`, "warn");
      });
    // C2/#16：面板打开期间定时刷新（/agents 无事件面、/workflows 增量仅维护集合；
    // Esc/Enter/重复 kind 关闭时 tick 自检停表）
    if (kind === "agents" || kind === "workflows") {
      startPanelRefresh({ kind, refresh, label });
    }
  }

  /** 面板 Enter（详情型 kind：skills / tools）：读取正文并以 info notice 展示；
   *  服务缺失/失败 → warn。面板占满回合区会遮住瞬态 notice（与 /jobs 一致），
   *  故先关面板再提示详情。 */
  async function showPanelDetail(
    kind: "skills" | "tools" | "task" | "loop" | "search",
    name: string,
  ): Promise<void> {
    const adapter = ctx.deps.adapter;
    const label =
      kind === "task" ? "taskEngine" : kind === "loop" ? "metricLoop" : kind;
    if (kind === "search") {
      // 搜索行 payload = url：Enter 展示来源地址（无详情服务调用）
      ctx.self.apply((s) => reduceState(s, { type: "command-panel-close" }));
      ctx.self.notice(name, "info");
      return;
    }
    const detail =
      kind === "skills"
        ? adapter.skillDetail
        : kind === "tools"
          ? adapter.toolDetail
          : kind === "task"
            ? adapter.taskDetail
            : adapter.loopDetail;
    if (!detail) {
      ctx.self.notice(`${label} 服务不可用`, "warn");
      return;
    }
    ctx.self.apply((s) => reduceState(s, { type: "command-panel-close" }));
    try {
      const text = await detail.call(adapter, name);
      ctx.self.notice(
        text && text.trim() !== "" ? text : `${name}（无详情）`,
        "info",
      );
    } catch {
      ctx.self.notice(`${label} 服务不可用`, "warn");
    }
  }

  /** 面板 Enter（kind=guard）：展示策略快照（policy() → 4 行摘要）；先关面板再 notice
   *  （面板占满回合区会遮住瞬态输出）；服务缺失 → warn。 */
  async function showGuardPolicy(): Promise<void> {
    const adapter = ctx.deps.adapter;
    const policy = adapter.guardPolicy;
    if (!policy) {
      ctx.self.notice("guard 服务不可用", "warn");
      return;
    }
    ctx.self.apply((s) => reduceState(s, { type: "command-panel-close" }));
    try {
      const text = await policy.call(adapter);
      ctx.self.notice(
        text && text.trim() !== "" ? text : "（无策略快照）",
        "info",
      );
    } catch {
      ctx.self.notice("guard 服务不可用", "warn");
    }
  }

  /** 面板 Enter（kind=agents）：直接中断选中子代理（面板内高亮即选择，照 /jobs 先例，
   *  不引入二次确认）；服务缺失 → warn，调用失败 → error。 */
  async function interruptAgent(childSessionId: string): Promise<void> {
    const adapter = ctx.deps.adapter;
    const interrupt = adapter.interruptAgent;
    if (!interrupt) {
      ctx.self.notice("subagents 服务不可用", "warn");
      return;
    }
    ctx.self.apply((s) => reduceState(s, { type: "command-panel-close" }));
    try {
      await interrupt.call(adapter, childSessionId);
      ctx.self.notice(`已请求中断子代理 ${childSessionId}`, "success");
    } catch (err) {
      // 带出宿主/适配器给出的原因（如 authority 不匹配的 UNAUTHORIZED），不再只给笼统文案
      ctx.self.notice(
        `中断失败：${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }

  /** /jobs：打开后台任务面板（复用既有面板模式），随后经 refreshJobs 拉取全量快照 */
  function handleJobsCommand(): void {
    const refresh = ctx.deps.adapter.refreshJobs;
    if (!refresh) {
      // 宿主未挂载 ctx.jobs：不开空面板（面板后置回合区、会盖住 hint），仅提示
      ctx.self.notice("jobs 服务不可用", "warn");
      return;
    }
    ctx.self.apply((s) => {
      let next = s;
      if (next.jobsPanel) {
        next = reduceState(next, { type: "jobs-panel-close" });
      } else {
        if (next.history) next = reduceState(next, { type: "history-close" });
        if (next.picker) next = reduceState(next, { type: "picker-close" });
        next = reduceState(next, { type: "jobs-panel-open" });
      }
      return next;
    });
    ctx.self.paint();
    void refresh.call(ctx.deps.adapter).catch(() => {
      ctx.self.notice("jobs 服务不可用", "warn");
    });
  }

  /** 取消后台任务（/jobs 面板 Enter；宿主缺失 → notice，面板保持） */
  async function killJob(id: string): Promise<void> {
    const adapter = ctx.deps.adapter;
    const kill = adapter.killJob;
    if (!kill) {
      ctx.self.notice("jobs 服务不可用", "warn");
      return;
    }
    try {
      await kill.call(adapter, id);
      ctx.self.notice("job " + id + " 取消请求已发送", "success");
    } catch {
      ctx.self.notice("jobs 服务不可用", "warn");
    }
  }

  return {
    startPanelRefresh,
    stopPanelRefresh,
    panelRefreshTick,
    openModelPicker,
    reloadPickerEfforts,
    confirmModelPicker,
    applyModelSelection,
    openStatusPanel,
    commitStatusPanel,
    openListPanel,
    showPanelDetail,
    showGuardPolicy,
    interruptAgent,
    handleJobsCommand,
    killJob,
  };
}
