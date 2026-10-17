/**
 * agent-group 的类型面：配置、组状态（落盘形状）、端口（传输 / 存储 / 镜像）与结果信封。
 *
 * 设计依据：`docs/implementation/2026-10-16-peer-group-protocol-design.md` 的决策项 1-20。
 * 落盘与工具返回一律要求 lossless JSON：可选字段**缺失即不存在**，不写 `undefined`
 * （宿主 `INVALID_TOOL_OUTPUT` 的成因，见 session-channel 的同名口径）。
 */

/** 插件配置（profile 的 cordis.patch.yml 在本条目 `config` 键下）。 */
export interface AgentGroupConfig {
  /** 是否启用（缺省 `true`；显式 `false` 关闭，不注册工具）。 */
  enabled?: boolean;
  /** `send` 未显式给 `timeoutMs` 时的等待上限（毫秒；缺省 30 分钟）。 */
  defaultTimeoutMs?: number;
  /** 每个组保留的指令记录条数上限（缺省 50；超出从最旧裁）。 */
  maxInstructionRecords?: number;
  /** 是否把组状态镜像进 memory-base（缺省 `true`；memory-base 缺失时跳过并计数）。 */
  mirror?: boolean;
  /** 状态文件名（缺省 `agent-group.json`；只允许 `[A-Za-z0-9._-]`，落在管理者会话目录里）。 */
  stateFileName?: string;
}

/** 归一化后的配置。 */
export interface ResolvedConfig {
  enabled: boolean;
  defaultTimeoutMs: number;
  maxInstructionRecords: number;
  mirror: boolean;
  stateFileName: string;
}

/**
 * 单条指令的收场（决策项 14 / 16）：成功 / 失败 / 受阻，另加「超时」与「成员被移除」
 * 两种失败成因 —— 后两者是结算时能明确区分的成因，故各有独立值。
 */
export type InstructionOutcome =
  "success" | "failure" | "blocked" | "timeout" | "removed";

/** 指令状态：`open` = 未结（每条主从连接同时至多一条）。 */
export type InstructionStatus = InstructionOutcome | "open";

/** 组内成员（管理者本身也作为固定的 `manager` 成员，等级恒 0）。 */
export interface GroupMember {
  /** 组内名字（本包自管，不占用全机别名空间，决策项 12）。 */
  name: string;
  /** 登记时的写法：别名或会话 id（原样保留，便于排障）。 */
  target: string;
  /** 解析到的会话 id（登记时要求目标在线，故正常非空）。 */
  sessionId: string;
  /** 等级：无主者 0；从方 = 主方 + 1（决策项 8）。 */
  level: number;
  role: "manager" | "member";
  addedAt: number;
}

/** 主从连接：以**从方**名为主键 —— 每 agent 至多一个主（决策项 7）。 */
export interface GroupLink {
  /** 主方组内名。 */
  from: string;
  /** 从方组内名。 */
  to: string;
  /** 从方等级（= 主方等级 + 1，决策项 8）。 */
  level: number;
  createdAt: number;
}

/** 指令记录（未结 + 已结算；每连接同时至多一条 `open`，决策项 14）。 */
export interface GroupInstruction {
  /** 本地指令 id（回报按它归属）。 */
  id: string;
  /** 主方组内名（逻辑上发指令的一方）。 */
  from: string;
  /** 从方组内名。 */
  to: string;
  /** 指令正文（原样投递，不解析）。 */
  text: string;
  /** 投递时使用的 `from` 会话 id（主方会话 id；未知时回落管理者会话 id）。 */
  fromSessionId: string;
  /** session-channel 的任务 id（投递成功后写入；也是收取回报的句柄）。 */
  taskId?: string;
  /** 等待上限（毫秒）。 */
  timeoutMs: number;
  sentAt: number;
  /** 截止时刻（= `sentAt + timeoutMs`，结算时懒判定）。 */
  deadline: number;
  status: InstructionStatus;
  /** 回报正文（原样，不解析，决策项 16）。 */
  result?: string;
  /** 成因（失败 / 受阻 / 超时 / 移除时给）。 */
  cause?: string;
  settledAt?: number;
}

/** 一个组的状态。 */
export interface AgentGroupState {
  /** 组 id（uuid；镜像的 `source.ref` 用它）。 */
  id: string;
  /** 组名（同一管理者下唯一）。 */
  name: string;
  /** 管理者会话 id（= 建组时的调用方会话；组状态落它的会话目录）。 */
  managerSessionId: string;
  createdAt: number;
  /** 组内名 → 成员；含固定的 `manager`。 */
  members: Record<string, GroupMember>;
  /** 从方组内名 → 主从连接。 */
  links: Record<string, GroupLink>;
  /** 指令记录（按 `sentAt` 升序追加；超出上限从最旧裁）。 */
  instructions: GroupInstruction[];
}

/** 一个管理者会话的全量状态（落盘形状：`<管理者会话目录>/agent-group.json`）。 */
export interface AgentGroupBook {
  version: 1;
  managerSessionId: string;
  /** 组名 → 组（通常只有一个）。 */
  groups: Record<string, AgentGroupState>;
}

/**
 * 失败信封（决策项 18：**所有**拒绝都带原因 + 下一步）。
 * `error` 是稳定错误码（机器可读），`reason` 与 `next` 是人话。
 */
export interface GroupFailure {
  ok: false;
  error: string;
  reason: string;
  next: string;
  [key: string]: unknown;
}

/** 成功信封（可选字段按需拼装；`next` 是给调用方的下一步提示）。 */
export interface GroupSuccess {
  ok: true;
  [key: string]: unknown;
}

export type ActionResult = GroupSuccess | GroupFailure;

/** 传输端口：本包对 session-channel 的唯一依赖面（实现见 `src/transport.ts`）。 */
export interface GroupTransport {
  /** 解析寻址（会话 id 精确 → 别名）；离线 / 歧义由实现报。 */
  resolve(
    target: string,
  ): Promise<{ ok: true; sessionId: string } | GroupFailure>;
  /** 投递指令（= session-channel 的 `delegate`），返回任务 id。 */
  delegate(input: {
    from: string;
    to: string;
    text: string;
    timeoutSec: number;
  }): Promise<{ ok: true; taskId: string } | GroupFailure>;
  /** 读取任务（= session-channel 的 `taskStatus`；**读取时懒判定超时**）。 */
  taskStatus(
    taskId: string,
  ): Promise<{ ok: true; task: TaskSnapshot } | GroupFailure>;
}

/** 传输侧任务快照（只用本包需要的字段）。 */
export interface TaskSnapshot {
  status: "pending" | "running" | "done" | "failed" | "canceled" | "timeout";
  result?: string;
  error?: string;
  resultTruncated?: boolean;
}

/** 状态存储端口（实现见 `src/store.ts`：文件 / 内存）。 */
export interface BookStore {
  load(managerSessionId: string): Promise<AgentGroupBook>;
  save(book: AgentGroupBook): Promise<void>;
}

/** 可选镜像端口（实现见 `src/mirror.ts`：memory-base）。 */
export interface GroupMirror {
  put(input: {
    managerSessionId: string;
    group: AgentGroupState;
    view: GroupView;
  }): Promise<void>;
}

/** 只读视图（`status` 动作的返回体，也是镜像写入的正文）。 */
export interface GroupView {
  name: string;
  id: string;
  manager: { name: string; sessionId: string };
  createdAt: number;
  members: Array<{
    name: string;
    target: string;
    sessionId: string;
    level: number;
    role: "manager" | "member";
    /** 主方组内名；自由代理为 `null`。 */
    principal: string | null;
    /** 名下的从代理（组内名，按名字排序）。 */
    subordinates: string[];
  }>;
  links: Array<{ from: string; to: string; level: number; createdAt: number }>;
  /** 指令记录（最新在前，最多 `instructionLimit` 条）。 */
  instructions: Array<{
    id: string;
    from: string;
    to: string;
    status: InstructionStatus;
    text: string;
    taskId?: string;
    sentAt: number;
    deadline: number;
    settledAt?: number;
    result?: string;
    cause?: string;
  }>;
  summary: {
    members: number;
    links: number;
    open: number;
    success: number;
    failure: number;
    blocked: number;
    timeout: number;
    removed: number;
  };
}
