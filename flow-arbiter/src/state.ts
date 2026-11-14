/**
 * flow-arbiter/src/state.ts — 流程选择仲裁的纯逻辑（无 IO、无宿主面）。
 *
 * 两条规则（决策项 7 / 8）：
 * - **同一会话同一时刻只选一个流程**：`selected` 按会话存（进程内内存，不落盘）；
 * - **只有被选中流程的入口工具放行**：入口工具名 → 流程 id 由登记表（`flows`）给出，
 *   拦截发生在 `tools/pre-execute`，工具面本身不增删（决策项 9①：保缓存命中）。
 *
 * 冲突处理（决策项 8 的「实现时定」）：**自动顶替**——选另一个流程时直接切换，
 * 回执带 `replaced` 说明被顶替的是谁，不要求先手动取消。
 */

/** 一条流程登记：流程 id、显示名与它的入口工具名。 */
export interface FlowRegistration {
  id: string;
  name: string;
  /** 流程入口工具名（如 `flow_start` / `plan_start`）。 */
  entry: string;
}

/** 内置流程登记（本仓两个流程定义插件；新流程经配置或服务面 `register` 追加）。 */
export const DEFAULT_FLOWS: readonly FlowRegistration[] = [
  { id: "standard", name: "标准流程八阶段", entry: "flow_start" },
  { id: "plan", name: "plan 模式三段", entry: "plan_start" },
];

/** 选中的回执。 */
export type SelectResult =
  | { ok: true; flow: FlowRegistration; replaced?: FlowRegistration }
  | { ok: false; error: "unknown_flow"; message: string };

/** 入口工具调用的裁决。 */
export type EntryDecision =
  { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "skip" };

/** 登记失败的可读原因。 */
export interface RegisterRejection {
  ok: false;
  error: "invalid_registration" | "duplicate_entry";
  message: string;
}

export class FlowArbiterState {
  private readonly flows = new Map<string, FlowRegistration>();
  /** 会话 id → 选中的流程 id（进程内内存，插件卸载即丢） */
  private readonly selected = new Map<string, string>();

  constructor(initial: readonly FlowRegistration[] = DEFAULT_FLOWS) {
    for (const flow of initial) this.flows.set(flow.id, flow);
  }

  /** 登记一条流程（同 id 覆盖；入口工具名不允许一条工具挂两个流程）。 */
  register(flow: FlowRegistration): { ok: true } | RegisterRejection {
    if (
      typeof flow?.id !== "string" ||
      flow.id.trim() === "" ||
      typeof flow.name !== "string" ||
      flow.name.trim() === "" ||
      typeof flow.entry !== "string" ||
      flow.entry.trim() === ""
    ) {
      return {
        ok: false,
        error: "invalid_registration",
        message: "流程登记需要非空的 id / name / entry",
      };
    }
    for (const [id, known] of this.flows) {
      if (id !== flow.id && known.entry === flow.entry) {
        return {
          ok: false,
          error: "duplicate_entry",
          message: `入口工具 ${flow.entry} 已登记给流程 ${id}：一条入口只能对应一个流程`,
        };
      }
    }
    this.flows.set(flow.id, {
      id: flow.id,
      name: flow.name,
      entry: flow.entry,
    });
    return { ok: true };
  }

  /** 全部登记（按登记顺序）。 */
  list(): FlowRegistration[] {
    return [...this.flows.values()];
  }

  /** 按流程 id 取登记。 */
  flowById(id: string): FlowRegistration | undefined {
    return this.flows.get(id);
  }

  /** 按入口工具名取登记（不是入口工具 → undefined）。 */
  flowByEntry(entry: string): FlowRegistration | undefined {
    for (const flow of this.flows.values()) {
      if (flow.entry === entry) return flow;
    }
    return undefined;
  }

  /** 某会话当前选中的流程（未选中 → undefined）。 */
  current(sessionId: string): FlowRegistration | undefined {
    const id = this.selected.get(sessionId);
    return id === undefined ? undefined : this.flows.get(id);
  }

  /** 选中一个流程（顶替同会话的旧选择）。 */
  select(sessionId: string, flowId: string): SelectResult {
    const flow = this.flows.get(flowId);
    if (flow === undefined) {
      return {
        ok: false,
        error: "unknown_flow",
        message: `未知流程「${flowId}」：可选 ${this.list()
          .map((item) => `${item.id}（${item.name}）`)
          .join(" / ")}`,
      };
    }
    const replaced = this.current(sessionId);
    this.selected.set(sessionId, flow.id);
    return replaced === undefined || replaced.id === flow.id
      ? { ok: true, flow }
      : { ok: true, flow, replaced };
  }

  /** 取消选择（返回是否本来有选择）。 */
  clear(sessionId: string): boolean {
    return this.selected.delete(sessionId);
  }

  /**
   * 入口工具调用裁决：不是入口工具 → `skip`（直接放行）；选中同一流程 → `allow`；
   * 未选中 / 选的是别的流程 / 认不出会话 → `deny` 并给可操作的说明。
   */
  decide(sessionId: string | undefined, toolName: string): EntryDecision {
    const flow = this.flowByEntry(toolName);
    if (flow === undefined) return { kind: "skip" };
    if (sessionId === undefined || sessionId === "") {
      return {
        kind: "deny",
        reason:
          `「${flow.name}」的入口 ${toolName} 需要会话归属才能判定流程选择，当前调用没有会话 id：` +
          "请在有会话的回合里调用（或先 flow_select 选中流程）。",
      };
    }
    const selected = this.current(sessionId);
    if (selected === undefined) {
      return {
        kind: "deny",
        reason:
          `未选中流程：先用 flow_select 选中「${flow.name}」（流程 id ${flow.id}）再调 ${toolName}；` +
          "其它流程的入口在选中前一律拒绝（工具恒注册，拦截在执行前判定）。",
      };
    }
    if (selected.id !== flow.id) {
      return {
        kind: "deny",
        reason:
          `当前会话选中的是「${selected.name}」（${selected.id}），不能用「${flow.name}」的入口 ${toolName}：` +
          `先用 flow_select 切到 ${flow.id}（会顶替当前选择）再启动。`,
      };
    }
    return { kind: "allow" };
  }
}
