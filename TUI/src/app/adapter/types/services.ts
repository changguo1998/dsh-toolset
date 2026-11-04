// TUI/src/app/adapter/types/services.ts — 任务引擎、守卫、群组服务面

/** task-engine 只读查询面快照（C1 前置；host `TaskEngine.query()` 返回形态的 TUI 侧宽松子集） */
export interface TaskEngineTaskLike {
  id: string;
  parentId: string | null;
  order: number;
  title: string;
  status: string;
  needDecompose: boolean;
  /** 多轮根帧（2026-10-05）：轮次，1 起；只出现在**轮根**上（子帧无）。旧版引擎无此字段 */
  round?: number;
  children?: readonly TaskEngineTaskLike[];
}

export interface TaskEngineQueryLike {
  tasks: readonly TaskEngineTaskLike[];
  frameStack: readonly string[];
  activeCount: number;
  isComplete: boolean;
}

/** ctx.get('taskEngine') 只读查询面（task-engine cordis provide；缺失时 /task 提示不可用） */
export interface TaskEngineLike {
  query?(): TaskEngineQueryLike;
  frameStack?(): readonly string[];
}

/** security-guard 判定记录（C3 前置；`GuardRecord` 的 TUI 侧宽松子集） */
export interface GuardRecordLike {
  toolName: string;
  verdict: "allow" | "deny";
  reason?: string;
  time: number;
}

/** security-guard 策略快照（C3 前置；`PolicySnapshot` 的 TUI 侧宽松子集） */
export interface PolicySnapshotLike {
  enabled: boolean;
  commandBlacklist?: {
    enabled?: boolean;
    rules?: readonly { id: string; reason: string }[];
    allowPatterns?: readonly string[];
  };
  sensitiveFiles?: {
    enabled?: boolean;
    rules?: readonly { id: string; reason: string }[];
    allowedPaths?: readonly { id: string; reason: string }[];
  };
}

/** ctx.get('guard') 只读查询面（security-guard cordis provide；缺失时 /guard 提示不可用） */
export interface SecurityGuardLike {
  recent?(): readonly GuardRecordLike[];
  policy?(): PolicySnapshotLike;
  /** 命令复查入口（不在工具入参里的命令，如 TUI 的 `$` 模式手输命令）：null = 放行，字符串 = deny 回执。
   *  `source` 标注命令来源（TUI 传 `"tui:$"`）。 */
  inspectCommand?(command: string, source?: string): string | null;
}

/** agent-group 只读组视图（`AgentGroupReadService.status` 返回 `view` 的 TUI 侧宽松子集；
 *  `/group` 行内摘要只消费 summary 与成员 / 连接计数）。 */
export interface AgentGroupViewLike {
  name: string;
  createdAt: number;
  members: readonly {
    name: string;
    level: number;
    role: string;
  }[];
  links: readonly unknown[];
  peerLinks: readonly { from: string; to: string }[];
  instructions: readonly unknown[];
  summary: {
    members: number;
    links: number;
    peerLinks: number;
    open: number;
    success: number;
    failure: number;
    blocked: number;
    timeout: number;
    removed: number;
  };
}

/** ctx.get('agentGroup') 只读服务面（agent-group cordis provide（2026-10-20 起）；
 *  缺失时 /group 提示不可用）。按管理者会话 id 读组状态，失败走 `{ok:false}` 信封。 */
export interface AgentGroupLike {
  status(
    managerSessionId: string,
    groupName?: string,
  ): Promise<
    | {
        ok: true;
        groups: readonly { name: string; view: AgentGroupViewLike }[];
      }
    | { ok: false; error: string; reason?: string; next?: string }
  >;
}
