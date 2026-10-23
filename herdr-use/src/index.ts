/**
 * herdr-use 的库面入口（DSH bundle 的 `main` 指向本文件）。
 *
 * 三个出口：
 *   - **工具面**：`apply` 注册十个模型侧工具（herdr_list / read / info / wait / create /
 *     close / label / text / key / run），工具即动作、无 action 参数；
 *   - **服务面**：`ctx.provide("herdrUse", …)`，方法与十个动作同名（camelCase），
 *     与工具面共用同一份 registry 与写锁；
 *   - **库面**：`createHerdrPlugin` 返回的 handle 带 `deps` / `service`，编排类插件与真机
 *     脚本可直接调 `dispatchAction()` 或服务方法，不必经模型工具链。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0：导出 `name` / `inject` / `provide` / `Config` / `apply`；
 * 其余导出是库面，不影响宿主加载。
 */

export {
  name,
  inject,
  provide,
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
  createTimersClock,
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
  TerminalRegistry,
  createExitCleanup,
  paneRenameArgs,
  runPaneCommand,
  tabCloseArgs,
  tabRenameArgs,
  workspaceCloseArgs,
} from "./registry.ts";
export type {
  CleanupEntry,
  ExitCleanup,
  ExitCleanupOptions,
  TerminalLookup,
} from "./registry.ts";

export {
  SANDBOX_WRITE_ACTIONS,
  isSandboxWrite,
  makeGuardChecker,
  makeSandboxModeReader,
  readService,
  sandboxDenialReason,
} from "./policy.ts";
export type {
  GuardCheck,
  GuardChecker,
  GuardServiceLike,
  SandboxModeReader,
} from "./policy.ts";

export { defaultRunner, dispatchAction, inspectedText } from "./actions.ts";
export type { DispatchDeps } from "./actions.ts";

export {
  createBackgroundSession,
  DEFAULT_BACKGROUND_POLL_INTERVAL_MS,
  DEFAULT_BACKGROUND_START_TIMEOUT_MS,
} from "./background.ts";
export type {
  BackgroundSession,
  BackgroundSessionOptions,
  BackgroundSessionProbe,
  BackgroundSessionResult,
} from "./background.ts";

export { createHerdrUseService } from "./service.ts";
export type {
  CreateOptions,
  HerdrUseService,
  ReadOptions,
  WaitOptions,
} from "./service.ts";

export {
  ensureWorkspace,
  laneArgs,
  laneRunner,
  readSessionContext,
  shortSessionId,
  withLane,
  workspaceLabel,
} from "./workspace.ts";
export type {
  EnsureWorkspaceOptions,
  EnsureWorkspaceResult,
  SessionContext,
  SessionResolver,
} from "./workspace.ts";

export {
  capText,
  createHerdrTools,
  renderHerdrUse,
  TOOL_ACTIONS,
} from "./tools.ts";
export type { HerdrUseToolDef } from "./tools.ts";

export { actionForTool } from "./types.ts";
export {
  ALL_ACTIONS,
  BACKGROUND_SESSION,
  DEFAULT_LABEL,
  DEFAULT_READ_LINES,
  DEFAULT_READ_SOURCE,
  DEFAULT_RENDER_LIMIT,
  DEFAULT_SETTLE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  LANES,
  READ_SOURCES,
  TOOL_NAMES,
  failure,
  resolveConfig,
  success,
} from "./types.ts";
export type {
  ActionResult,
  ActionFailure,
  ActionSuccess,
  HerdrErrorCode,
  HerdrHandshake,
  HerdrUseAction,
  HerdrUseConfig,
  Lane,
  ReadFormat,
  ReadSource,
  RenderLimit,
  ResolvedConfig,
  TerminalRecord,
  WorkspaceBinding,
} from "./types.ts";
