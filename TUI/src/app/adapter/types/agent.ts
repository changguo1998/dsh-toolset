// src/app/adapter/types/agent.ts — 代理注册表、权限预设、技能与子代理

import type { ContentBlockLike } from "./core.ts";

/** 结构面：ctx.agents 注册表（仅需 resume：加载持久化会话继续对话）。
 *  官方 AgentRegistry.resume(ownerCtx, {resumeSessionId, agentOptions?, setup?, signal?})
 *  委托给 agent-loop 工厂；要求宿主加载 sessionPersistence 后端。 */
export interface AgentRegistryLike {
  resume(opts: {
    resumeSessionId: string;
    agentOptions?: Record<string, unknown>;
    setup?: (agentCtx: unknown) => unknown;
    signal?: AbortSignal;
  }): Promise<{ agent: unknown; dispose(): Promise<void> }>;
  /** 新建会话（官方 agents.create；sessionId 缺省由宿主生成）。/new 用；
   *  老宿主只暴露 resume 时省略 → /new 提示不可用。 */
  create?(opts: {
    sessionId?: string;
    meta?: { cwd?: string };
    agentOptions?: Record<string, unknown>;
    setup?: (agentCtx: unknown) => unknown;
  }): Promise<{ agent: unknown; dispose(): Promise<void> }>;
}

/** 权限预设目录信息（rc.2 ctx.permissionPresets 结构面：names + current + 展示描述） */
export interface PermissionPresetInfo {
  /** 当前有效预设名（不匹配表内任何预设时为 'custom'） */
  current: string;
  /** 可切换预设名（表声明顺序） */
  names: string[];
  /** 预设展示名与说明（PresetSpec.name/description；缺省回落键名） */
  entries: { key: string; name: string; description?: string }[];
}

/** ctx.get('permissionPresets') 结构面（rc.2 PermissionPresetService：names + current） */
export interface PermissionPresetServiceLike {
  names: readonly string[];
  current(events: readonly unknown[]): string;
  /** 新会话默认预设（dsh-permission-presets defaultPreset；缺失时 Mode 快照跳过兜底） */
  readonly defaultPreset?: string;
}

/** 单后台任务快照（rc.2 JobSnapshot 结构面子集：id/kind/label/status/detail；供 UI 展示） */
export interface JobInfo {
  id: string;
  kind: string;
  label: string;
  status: string;
  detail?: string;
}

// ---------- 共享列表面板（/skills、/agents、/tools；契约见 COMMANDS-SPEC.md §4） ----------

/** 共享列表面板 kind（批次 2 仅 skills；agents/tools 由批次 3 接入） */
export type CommandPanelKind =
  | "skills"
  | "agents"
  | "tools"
  | "task"
  | "guard"
  | "loop"
  | "workflows"
  | "search";

/** 共享列表面板行（kind 无关的归一化渲染输入） */
export interface CommandPanelRow {
  /** 主文本（skill 名 / agent label / 工具名） */
  title: string;
  /** 副文本（描述 / detail；可空） */
  detail?: string;
  /** 状态语义（可选；渲染层经 JobsPanel.statusMark 映射符号与颜色，无则默认前景） */
  status?: string;
  /** 主操作载荷（Enter 时回传，如 skill 名称） */
  payload?: string;
  /** Enter 被禁用时的原因说明（如 agents 的一次性条目不可中断）：设置时 Enter 只提示不改状态 */
  blockedReason?: string;
}

/** 宿主 skills 服务条目结构面（dsh-skill SkillSummary 子集） */
export interface SkillSummaryLike {
  name: string;
  description?: string;
  whenToUse?: string;
  provider?: string;
}

/** 宿主 skills 服务完整定义结构面（SkillDefinition 子集，含正文） */
export interface SkillDefinitionLike extends SkillSummaryLike {
  content?: string;
}

/** 宿主 skills 服务结构面（ctx.get('skills')，@deepseek-ai/dsh-skill）；
 *  服务层 `list()` / `get(name)` 均为同名/skill 名字符串（provider 层 candidate 不出现）。 */
export interface SkillsLike {
  /** 可用 skill 元数据（无参调用；options 省略 = 全局层） */
  list?(): Promise<readonly SkillSummaryLike[]>;
  /** 单个 skill 定义（含 content 正文；Enter 详情用） */
  get?(name: string): Promise<SkillDefinitionLike | undefined>;
}

// ---------- subagents / tools 服务结构面（批次 3：/agents、/tools） ----------

/** 宿主 subagents 服务条目结构面（dsh-subagent `SubagentCatalogEntry` 富条目子集）。
 *  经 `listDescendants`（depth=1 即请求根的直接子代）获取；诊断条目带 `kind:'diagnostic'`。 */
export interface SubagentEntryLike {
  /** 判别：child = 可用条目；diagnostic = 投影失败条目（只读展示，不可中断） */
  kind?: string;
  /** 子会话 id（可中断目标；diagnostic 条目即使带 id 也不可中断） */
  id?: string;
  /** 子代理类型：one-shot / continuable / unknown */
  mode?: string;
  /** 创建标签（continuable 恒有） */
  label?: string;
  /** 存活态：running / inactive */
  activity?: string;
  /** 是否有子代 */
  hasChildren?: boolean;
  /** diagnostic 条目的原因：corrupt / unsupported / unavailable */
  reason?: string;
  /** `listDescendants` 条目：与请求根的距离（直接子代 = 1） */
  depth?: number;
  /** `listDescendants` 条目：所属父会话 id */
  parentId?: string;
}

/** 子代理一次 one-shot run 的返回（dsh-subagent SubagentRun 结构化子集） */
export interface SubagentRunLike {
  /** parent 作用域 run id（本地即子会话 id） */
  id?: string;
  /** 结算结果：run 不 reject 于子级失败（stopReason:'error' 消费方映射） */
  result?: Promise<{
    output?: readonly ContentBlockLike[];
    text?: string;
    stopReason?: string;
    error?: string;
  }>;
}

/** 宿主 subagents 服务结构面（ctx.get('subagents')，@deepseek-ai/dsh-subagent）；
 *  列条目用 `listDescendants(rootSessionId)` 取 depth=1 的直接子代。 */
export interface SubagentsLike {
  /** 递归目录（富条目 + parentId/depth），取 depth=1 即直接子代；宿主未提供时 /agents 提示不可用 */
  listDescendants?(
    rootSessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly SubagentEntryLike[]>;
  /** 中断一个 live 子代理的当前 turn（authority = {kind:'user', parentSessionId}） */
  interrupt?(
    targetSessionId: string,
    authority: { kind: "user"; parentSessionId: string },
  ): void;
  /** 拉起一个 one-shot 子代理（dsh-subagent `start(name, request)`；/council 评审用）。
   *  request: { label?, prompt: ContentBlock[], parent, signal?, agentOptions? }。
   *  宿主未提供 → /council 提示不可用不假启动。 */
  start?(
    name: string,
    request: {
      label?: string;
      prompt: readonly ContentBlockLike[];
      parent: unknown;
      signal?: AbortSignal;
      /** 高规格评审模型偏好（宿主暴露 agentOptions 能力时透传，否则默认） */
      agentOptions?: Record<string, unknown>;
    },
  ): Promise<SubagentRunLike> | SubagentRunLike;
}
