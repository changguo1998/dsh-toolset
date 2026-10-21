/**
 * 包入口（编译产物 `dist/src/index.js` 供宿主按 bundle 契约加载）。
 *
 * 导出分层：公共类型 → 纯函数（选择器 / 到期）→ 落地件（任务表 / 流水）→ 投递 / 调度 →
 * 可见性面（命令 / 服务 / 工具）→ 装配。
 */

export * from "./types.ts";
export {
  canonicalTimeOfDay,
  canonicalizeSelector,
  describeSelector,
  firstNext,
  isCanonicalSelector,
  isPeriodic,
  MIN_EVERY_SECONDS,
  nextAfter,
  normalizeSelector,
  parseTimeOfDay,
  SELECTOR_KINDS,
  type AtSelector,
  type AfterSecondsSelector,
  type DailySelector,
  type EverySecondsSelector,
  type NormalizeResult,
  type Selector,
  type SelectorError,
  type SelectorErrorCode,
  type SelectorKind,
  type WeeklySelector,
} from "./selectors.ts";
export {
  decide,
  DEFAULT_CATCH_UP_WINDOW_MS,
  isDue,
  nextWakeAt,
  type DueDecision,
  type DueInput,
} from "./due.ts";
export {
  TASK_STORE_VERSION,
  TaskStore,
  type TaskStoreLoadResult,
  type TaskWriteOptions,
} from "./store.ts";
export {
  ControlLog,
  type ControlAction,
  type ControlEntry,
  type ControlLogOptions,
} from "./control.ts";
export {
  DEFAULT_JOURNAL_LIMIT,
  Journal,
  type JournalAppendOptions,
  type JournalOptions,
} from "./journal.ts";
export {
  buildDeliverMessage,
  CommandChannel,
  INJECTION_PREFIX,
  parseCommandLine,
  TextChannel,
  type CommandChannelOptions,
  type CommandRuntimeLike,
  type SessionsLike,
  type TextChannelOptions,
} from "./deliver.ts";
export {
  ChannelRegistry,
  DEFAULT_MAX_DELAY_MS,
  Scheduler,
  type AgentsLike,
  type ControlApplier,
  type SchedulerOptions,
  type SchedulerStatus,
  type TimerLike,
} from "./scheduler.ts";
export {
  COMMAND_NAME,
  registerDaemonCommand,
  renderDetail,
  renderJournal,
  renderList,
  runDaemonCommand,
  SUBCOMMANDS,
  type CommandRegistrarLike,
  type DaemonCommandDeps,
  type DaemonCommandResult,
} from "./commands.ts";
export {
  createDaemonService,
  SERVICE_FACE_METHODS,
  type BackgroundDaemonService,
  type DaemonStatusView,
} from "./service.ts";
export {
  createDaemonTaskTool,
  executeDaemonTool,
  TOOL_NAME,
  type DaemonToolDeps,
} from "./tools.ts";
export {
  makeCommandGuard,
  type CommandCheckResult,
  type CommandChecker,
} from "./guard.ts";
export {
  createRunSink,
  DAEMON_KINDS,
  decodeTaskSnapshot,
  encodeTaskSnapshot,
  isTier,
  KIND_RUN,
  KIND_TASK,
  loadTasks,
  MemoryTaskMirror,
  registerDaemonKinds,
  taskTierFor,
  tierForTask,
  TIERS,
  type DaemonKinds,
  type KindSpecLike,
  type KindVerdictLike,
  type KindWriteInputLike,
  type ListOptionsLike,
  type LoadedTasks,
  type LoadTasksOptions,
  type MemoryScopeLike,
  type MemoryServiceLike,
  type MemoryTaskMirrorOptions,
  type PutResultLike,
  type RecordsBackend,
  type RunSinkOptions,
  type ScopePutInputLike,
  type StoreRowLike,
  type Tier,
} from "./records.ts";
export { readService } from "./services.ts";
export { DaemonSwitch } from "./switch.ts";
export {
  createTargetValidator,
  TARGET_UNRESOLVABLE,
  type TargetValidator,
} from "./target.ts";
export {
  apply,
  bootDaemon,
  createDaemonRuntime,
  defaultStateDir,
  inject,
  name,
  provide,
  resolveControlPath,
  resolveJournalPath,
  resolveStorePath,
  type Config,
  type DaemonConfig,
  type DaemonRuntime,
} from "./main.ts";
