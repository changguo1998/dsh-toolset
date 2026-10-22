/**
 * herdr-use 的库面入口（DSH bundle 的 `main` 指向本文件）。
 *
 * 双出口（对齐 `ast-tools` 的既有先例）：
 *   - **工具面**：`apply` 注册单个模型侧工具 `herdr_use`（十三个 action；workspace 面不对模型暴露）；
 *   - **库面**：`createHerdrPlugin` 返回的 handle 里带 `deps`，编排类插件与真机脚本可直接
 *     `dispatchAction(action, args, handle.deps, exec)`，不必经模型工具链。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0：导出 `name` / `inject` / `Config` / `apply`；
 * 其余导出是库面，不影响宿主加载。
 */

export {
  name,
  inject,
  apply,
  createHerdrPlugin,
  preExecuteVerdict,
  resolveHerdrBin,
} from "./main.ts";
export type {
  Config,
  HerdrUseDeps,
  HerdrUseHandle,
  PluginCtxLike,
  PreExecuteExecution,
  PreExecuteOptions,
  PreExecuteVerdict,
} from "./main.ts";

export {
  createDefaultRunner,
  createSpawnSyncRunner,
  DEFAULT_PROBE_TIMEOUT_MS,
  probeHerdrServerSync,
  readHerdrHandshake,
  parseEnvelope,
  classifyExit,
  extractJsonObject,
  findOnPath,
  runHerdrSync,
  commandLabel,
} from "./cli.ts";
export type {
  CliRunResult,
  CliExitKind,
  HerdrCommand,
  HerdrProbeResult,
  HerdrRunner,
  HerdrErrorEnvelope,
  ParsedEnvelope,
  SyncRunResult,
  SyncRunner,
} from "./cli.ts";

export {
  createNetConnector,
  createPaneReader,
  defaultHerdrSocketPath,
  interpretReadResponse,
  nextRequestId,
  realClock,
  toSocketSource,
  waitForStable,
} from "./socket.ts";
export type {
  Clock,
  PaneReadOptions,
  PaneReadOutcome,
  PaneReadRequest,
  PaneReadResult,
  PaneReader,
  ReadPaneParams,
  SocketConnector,
  SocketReadSource,
  SocketResponse,
  StabilityOutcome,
  WaitStableOptions,
} from "./socket.ts";

export {
  PaneRegistry,
  closeArgs,
  createExitCleanup,
  renameArgs,
  runPaneCommand,
  tabCloseArgs,
  workspaceCloseArgs,
} from "./registry.ts";
export type {
  CleanupEntry,
  ExitCleanup,
  ExitCleanupOptions,
  PaneRecord,
  RegistrySnapshot,
} from "./registry.ts";

export {
  OWNED_ACTIONS,
  READONLY_ACTIONS,
  SANDBOX_WRITE_ACTIONS,
  approvalDeniedMessage,
  checkOwnership,
  crossWorkspaceDenialReason,
  isOwnedAction,
  isReadonlyAction,
  isSandboxWrite,
  makeGuardChecker,
  makeSandboxModeReader,
  needsApproval,
  ownershipDeniedHint,
  readService,
  sandboxDenialReason,
} from "./policy.ts";
export type {
  GuardCheck,
  GuardChecker,
  GuardServiceLike,
  OwnershipVerdict,
  SandboxModeReader,
} from "./policy.ts";

export {
  defaultRunner,
  dispatchAction,
  inspectedText,
  needsOwnership,
  paneTargetFor,
  summarizePane,
  summarizeTab,
} from "./actions.ts";
export type { DispatchDeps } from "./actions.ts";

export {
  activePaneOf,
  ensureWorkspace,
  readSessionContext,
  shortSessionId,
  workspaceLabel,
} from "./workspace.ts";
export type {
  ActivePaneResult,
  EnsureWorkspaceOptions,
  EnsureWorkspaceResult,
  SessionContext,
  SessionResolver,
} from "./workspace.ts";

export {
  TOOL_NAME,
  actionOf,
  actionPane,
  actionText,
  capText,
  createHerdrUseTool,
  renderHerdrUse,
} from "./tools.ts";
export type { HerdrUseToolDef } from "./tools.ts";

export {
  ALL_ACTIONS,
  DEFAULT_LABEL,
  DEFAULT_READ_LINES,
  DEFAULT_READ_SOURCE,
  DEFAULT_RENDER_LIMIT,
  DEFAULT_SETTLE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  READ_SOURCES,
  TAB_ACTIONS,
  failure,
  resolveConfig,
  success,
} from "./types.ts";
export type {
  ActionResult,
  ActionFailure,
  ActionSuccess,
  ApprovalMode,
  HerdrErrorCode,
  HerdrHandshake,
  HerdrUseAction,
  HerdrUseConfig,
  PaneOwnership,
  ReadFormat,
  ReadSource,
  RenderLimit,
  ResolvedConfig,
  TabRecord,
  WorkspaceBinding,
} from "./types.ts";
