// TUI/src/app/adapter/types.ts — DSH 适配层类型契约（按类型域拆在 ./types/ 下，本文件只做入口重导出）

export type {
  AgentRowInfo,
  AgentStatus,
  ApprovalItem,
  CompactionSummaryPayloadLike,
  ContentBlockLike,
  GoalActivation,
  GoalChangeLike,
  GoalOperation,
  GoalRefLike,
  GoalSnapshotLike,
  NoticeTone,
  SessionMeta,
  SubagentDescriptorLike,
  TodoItemLike,
} from "./types/core.ts";
export type { DshEvent } from "./types/events.ts";
export type { DshAdapter } from "./types/adapter-contract.ts";
export type {
  ModelCatalog,
  ModelInfo,
  ModelReasoning,
  ModelSelection,
  SessionModelSelectionRef,
  TokenUsage,
} from "./types/model.ts";
export type {
  ApprovalOutcome,
  ApprovalRequest,
  AssistantStreamRecord,
  ModelSelectionLike,
  QuestionAnswer,
  QuestionAnswerItem,
  QuestionIntent,
  QuestionItem,
  QuestionOption,
  SessionEvent,
  SessionEventDataMap,
  SessionEventType,
  StreamChunk,
  UserQuestionRequestLike,
} from "./types/session-events.ts";
export type {
  AgentDefaultModelLike,
  DshAgentLike,
  DshCommandLike,
  DshRuntime,
  DshUserMessageLike,
  LlmLike,
} from "./types/runtime.ts";
export type {
  HistoryMessage,
  LiveSessionHandle,
  SessionDeleteResult,
  SessionInfo,
  SessionQueryLike,
  SessionStoreLike,
  SessionSurfaceView,
  SessionTitleLike,
  SessionTitleSnapshotLike,
} from "./types/session.ts";
export type {
  AgentRegistryLike,
  CommandPanelKind,
  CommandPanelRow,
  JobInfo,
  PermissionPresetInfo,
  PermissionPresetServiceLike,
  SkillDefinitionLike,
  SkillSummaryLike,
  SkillsLike,
  SubagentEntryLike,
  SubagentRunLike,
  SubagentsLike,
} from "./types/agent.ts";
export type {
  ConfigEditorEntryLike,
  ConfigEditorLike,
  ConfigEditorRowLike,
  ConfigEntrySummary,
  ScopeKeyLike,
  SettingsDescriptorLike,
  SettingsLike,
  ToolSchemaLike,
  ToolsLike,
} from "./types/tools.ts";
export type {
  AgentGroupLike,
  AgentGroupViewLike,
  GuardRecordLike,
  PolicySnapshotLike,
  SecurityGuardLike,
  TaskEngineLike,
  TaskEngineQueryLike,
  TaskEngineTaskLike,
} from "./types/services.ts";
export { SESSION_TIER, isManagedTier } from "./types/memory.ts";
export type {
  KnowledgeBundleSummaryLike,
  KnowledgeServiceLike,
  LoopSummaryLike,
  ManagedTier,
  MemoryRowRef,
  MetricLoopLike,
  SymbolNormalizerLike,
} from "./types/memory.ts";
export type {
  AgentPresetInfo,
  AgentPresetsLike,
  ContractClauseLike,
  ContractParseResult,
  GoalContractServiceLike,
  JobsLike,
  RuleEngineLike,
  RuleEngineNotice,
  SearchProviderLike,
  SearchSourceLike,
  SessionChannelLike,
  WebSearchLike,
  WorkflowEngineLike,
  WorkflowRunLike,
} from "./types/channel.ts";
export type {
  FileReferenceLike,
  RealAdapterOptions,
} from "./types/adapter-options.ts";
