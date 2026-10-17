/**
 * herdr-pane 的库面入口（DSH bundle 的 `main` 指向本文件）。
 *
 * 双出口（对齐 `ast-tools` 的既有先例）：
 *   - **工具面**：`apply` 注册单个模型侧工具 `herdr_pane`（十个 action）；
 *   - **库面**：`createHerdrPlugin` 返回的 handle 里带 `deps`，编排类插件与真机脚本可直接
 *     `dispatchAction(action, args, handle.deps)`，不必经模型工具链。
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
  HerdrPaneDeps,
  HerdrPaneHandle,
  PluginCtxLike,
  PreExecuteVerdict,
} from "./main.ts";

export {
  createDefaultRunner,
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
  HerdrRunner,
  HerdrErrorEnvelope,
  ParsedEnvelope,
} from "./cli.ts";

export {
  createNetConnector,
  createPaneReader,
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
} from "./registry.ts";
export type {
  CleanupEntry,
  ExitCleanup,
  PaneRecord,
  RegistrySnapshot,
} from "./registry.ts";

export {
  OWNED_ACTIONS,
  READONLY_ACTIONS,
  approvalDeniedMessage,
  checkOwnership,
  isOwnedAction,
  isReadonlyAction,
  makeGuardChecker,
  needsApproval,
  ownershipDeniedHint,
  readService,
} from "./policy.ts";
export type {
  GuardCheck,
  GuardChecker,
  GuardServiceLike,
  OwnershipVerdict,
} from "./policy.ts";

export {
  defaultRunner,
  dispatchAction,
  inspectedText,
  needsOwnership,
  paneTargetFor,
  summarizePane,
} from "./actions.ts";
export type { DispatchDeps } from "./actions.ts";

export {
  TOOL_NAME,
  actionOf,
  actionPane,
  actionText,
  capText,
  createHerdrPaneTool,
  renderHerdrPane,
} from "./tools.ts";
export type { HerdrPaneToolDef } from "./tools.ts";

export {
  DEFAULT_LABEL,
  DEFAULT_READ_LINES,
  DEFAULT_READ_SOURCE,
  DEFAULT_RENDER_LIMIT,
  DEFAULT_SETTLE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  PANE_ACTIONS,
  READ_SOURCES,
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
  HerdrPaneAction,
  HerdrPaneConfig,
  PaneOwnership,
  ReadFormat,
  ReadSource,
  RenderLimit,
  ResolvedConfig,
} from "./types.ts";
