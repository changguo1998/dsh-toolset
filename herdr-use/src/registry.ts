/**
 * src/registry.ts — 归属登记、会话 workspace 绑定与生命周期
 *
 * 口径（追踪文档决策项 7 / 8 / 9）：
 *   - 写类动作缺省只作用于**本插件创建并登记**的 pane；读类可读任意 pane；
 *     **缺省永不使用「当前聚焦 pane」**（官方技能：不依赖别的客户端的焦点）。
 *   - 进程内只维护**一个**会话 workspace 绑定（`WorkspaceBinding`）：首个使用本工具的会话
 *     决定 workspace 与 label，子会话沿用；模型看不到这个 id。
 *   - `tab_create` 建出的 tab 进 `TabRecord` 登记表；`tab_close` 只认这里登记过、
 *     且属于本会话 workspace 的 tab（跨 workspace 一律拒）。
 *   - 创建 pane / tab 成功后自动打 label（缺省 `dsh-pane`），让崩溃残留可被 `pane_list` 与人工识别。
 *   - dsh 退出时按 `closeOnExit` 关闭本次创建的 pane；关闭后若本会话 workspace 已空，
 *     由程序内部一并 `workspace close`（仅此一例、不出工具面），避免留空壳。
 *   - 同 pane 的操作串行化；workspace 类动作另有一个共享队列（避免并发建两个 workspace）。
 */

import type { CliRunResult, HerdrRunner, SyncRunner } from "./cli.ts";
import { createSpawnSyncRunner, parseEnvelope } from "./cli.ts";
import type { ResolvedConfig, TabRecord, WorkspaceBinding } from "./types.ts";

/** 单条登记记录。 */
export interface PaneRecord {
  /** pane id（创建返回的 `.result.pane.pane_id`）。 */
  paneId: string;
  /** 创建时打的归属标记。 */
  label: string;
  /** 创建时间（epoch ms）。 */
  createdAt: number;
  /** 创建时请求的 cwd（未指定则 undefined）。 */
  cwd?: string;
  /** 所属 workspace（建 / 切时已知则记下；用于收尾判定与排障）。 */
  workspaceId?: string;
}

/** 登记表查询面（只读）。 */
export interface RegistrySnapshot {
  /** 当前登记的 pane（创建顺序）。 */
  panes: PaneRecord[];
  /** 是否已登记（`pane_list` 回执打标记用）。 */
  has(paneId: string): boolean;
}

/** 登记表（进程内内存态；dsh 进程重启即清空，崩溃残留靠 label 识别）。 */
export class PaneRegistry implements RegistrySnapshot {
  private readonly records = new Map<string, PaneRecord>();
  private readonly tabRecords = new Map<string, TabRecord>();
  private binding: WorkspaceBinding | undefined;
  /** 同 pane / 同队列的串行化尾部 Promise。 */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  /** 当前登记的 pane（创建顺序）。 */
  get panes(): PaneRecord[] {
    return [...this.records.values()];
  }

  /** 是否登记过该 pane。 */
  has(paneId: string): boolean {
    return this.records.has(paneId);
  }

  /** 取单条记录。 */
  get(paneId: string): PaneRecord | undefined {
    return this.records.get(paneId);
  }

  /** 登记（重复登记按最新一次覆盖，不改创建时间以外的语义）。 */
  register(input: {
    paneId: string;
    label?: string;
    cwd?: string;
    workspaceId?: string;
  }): PaneRecord {
    const record: PaneRecord = {
      paneId: input.paneId,
      label: input.label ?? this.label,
      createdAt: Date.now(),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.workspaceId === undefined
        ? {}
        : { workspaceId: input.workspaceId }),
    };
    this.records.set(record.paneId, record);
    return record;
  }

  /** 注销（`pane_close` 成功后调用；重复注销无副作用）。 */
  unregister(paneId: string): void {
    this.records.delete(paneId);
    this.queues.delete(paneId);
  }

  /** 当前会话的 workspace 绑定（未用时 undefined）。 */
  get workspaceBinding(): WorkspaceBinding | undefined {
    return this.binding;
  }

  /** 写会话 workspace 绑定（由 `workspace.ts` 的 ensure 调用）；传 undefined 表示清空
   *  （缓存的 workspace 已被关闭时由 ensure 主动失效，下次按 label 重新匹配 / 新建）。 */
  setWorkspaceBinding(binding: WorkspaceBinding | undefined): void {
    this.binding = binding;
  }

  /** 当前登记的 tab（创建顺序）。 */
  get tabs(): TabRecord[] {
    return [...this.tabRecords.values()];
  }

  /** 取单条 tab 记录。 */
  tab(tabId: string): TabRecord | undefined {
    return this.tabRecords.get(tabId);
  }

  /** 登记 tab（重复登记按最新一次覆盖）。 */
  registerTab(input: {
    tabId: string;
    workspaceId: string;
    label?: string;
    rootPaneId?: string;
  }): TabRecord {
    const record: TabRecord = {
      tabId: input.tabId,
      workspaceId: input.workspaceId,
      label: input.label ?? this.label,
      createdAt: Date.now(),
      ...(input.rootPaneId === undefined
        ? {}
        : { rootPaneId: input.rootPaneId }),
    };
    this.tabRecords.set(record.tabId, record);
    return record;
  }

  /** 注销 tab。 */
  unregisterTab(tabId: string): void {
    this.tabRecords.delete(tabId);
  }

  /** 按 root pane 反查并注销 tab（`pane_close` 掉 tab 的 root pane 后调用）。 */
  unregisterTabByRootPane(paneId: string): TabRecord | undefined {
    for (const [tabId, record] of this.tabRecords) {
      if (record.rootPaneId === paneId) {
        this.tabRecords.delete(tabId);
        return record;
      }
    }
    return undefined;
  }

  /** 清空（退出清理后调用；含 tab 与 workspace 绑定）。 */
  clear(): void {
    this.records.clear();
    this.tabRecords.clear();
    this.binding = undefined;
    this.queues.clear();
  }

  /**
   * 同键串行化：把 `task` 排在该键上一笔操作之后执行。
   * 不同键互不阻塞；失败不影响后续排队（尾部始终落到「已结算」态）。
   */
  serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    // 尾部只用于排队，吞掉失败避免未处理拒绝
    this.queues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

/** 退出清理结果（每条记录一条，供日志与真机验证）。 */
export interface CleanupEntry {
  paneId: string;
  /** 是否尝试关闭（`closeOnExit: false` 时不尝试）。 */
  attempted: boolean;
}

/** 退出清理面（`main.ts` 在 dispose 与 `process.exit` 回调里调用）。 */
export interface ExitCleanup {
  /** 同步尽力关闭全部登记 pane（返回尝试记录；`closeOnExit: false` 时为空）。 */
  closeAllSync(): CleanupEntry[];
}

/** 退出清理的可注入面（单测断言「调了哪些 argv」，不真起子进程）。 */
export interface ExitCleanupOptions {
  /** 同步执行面（缺省 `spawnSync`）。 */
  runSync?: SyncRunner;
  /** 单条同步命令上限（缺省 3000ms）。 */
  timeoutMs?: number;
}

/** 列某 workspace 的 pane（同步；解析不出返回 undefined，调用方按「无法核对」处理）。 */
function listWorkspacePanesSync(
  run: SyncRunner,
  workspaceId: string,
  timeoutMs: number,
): Record<string, unknown>[] | undefined {
  const result = run(["pane", "list", "--workspace", workspaceId], timeoutMs);
  if (result.error !== undefined || result.status !== 0) return undefined;
  const envelope = parseEnvelope(
    result.stdout,
    result.stderr,
    result.status ?? undefined,
  );
  if (envelope.kind !== "ok") return undefined;
  const panes = envelope.result.panes;
  if (!Array.isArray(panes)) return undefined;
  return panes.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object",
  );
}

/**
 * 构造同步退出清理器：逐条 `spawnSync(herdr, ["pane","close",id])`（每条约 3s 上限）。
 * 只关登记过的 pane；随后按决策项 9(a) 收尾 workspace：本会话 workspace 里已无 pane
 * （说明里面的 pane 全部是本插件的、且都已关闭）时，内部 `workspace close` 掉它。
 * 用户后来在其中开的 pane 会让这条判定不成立，故不会误伤。
 */
export function createExitCleanup(
  binPath: string | undefined,
  registry: PaneRegistry,
  config: ResolvedConfig,
  options: ExitCleanupOptions = {},
): ExitCleanup {
  return {
    closeAllSync(): CleanupEntry[] {
      const records = registry.panes;
      const entries: CleanupEntry[] = records.map((record) => ({
        paneId: record.paneId,
        attempted: config.closeOnExit && binPath !== undefined,
      }));
      if (!config.closeOnExit || binPath === undefined) {
        registry.clear();
        return entries;
      }
      const timeoutMs = options.timeoutMs ?? 3000;
      const run = options.runSync ?? createSpawnSyncRunner(binPath);
      for (const record of records) {
        run(closeArgs(record.paneId), timeoutMs);
      }
      const binding = registry.workspaceBinding;
      if (binding !== undefined) {
        const remaining = listWorkspacePanesSync(
          run,
          binding.workspaceId,
          timeoutMs,
        );
        if (remaining !== undefined && remaining.length === 0) {
          run(workspaceCloseArgs(binding.workspaceId), timeoutMs);
        }
      }
      registry.clear();
      return entries;
    },
  };
}

/** 关闭命令的 argv（异步 `pane_close` 动作与同步退出清理共用，避免两处写法漂移）。 */
export function closeArgs(paneId: string): string[] {
  return ["pane", "close", paneId];
}

/** 重命名命令的 argv（`pane_label` 动作与 `pane_create` 后的自动打标共用）。 */
export function renameArgs(paneId: string, label: string): string[] {
  return label === ""
    ? ["pane", "rename", "--clear", paneId]
    : ["pane", "rename", paneId, label];
}

/** 关闭 tab 的 argv（`tab_close` 动作与真机断言共用）。 */
export function tabCloseArgs(tabId: string): string[] {
  return ["tab", "close", tabId];
}

/** 关闭 workspace 的 argv（仅退出清理内部使用，不出工具面）。 */
export function workspaceCloseArgs(workspaceId: string): string[] {
  return ["workspace", "close", workspaceId];
}

/** 单一 runner 的薄包装（退出清理之外的地方都走它，便于单测注入）。 */
export async function runPaneCommand(
  runner: HerdrRunner,
  args: string[],
  timeoutMs: number,
): Promise<CliRunResult> {
  return runner.run(args, timeoutMs);
}
