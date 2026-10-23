/**
 * src/registry.ts — 终端登记、会话 × lane 的 workspace 绑定与生命周期
 *
 * 口径（2026-10-23 终端面重构）：
 *   - 登记的是**终端**（tab + 自带 root pane）：所有驱动动作只认登记过的 `terminal_id`；
 *     工具面没有外来对象的概念，因此没有 allowForeignPanes / force / 审批档。
 *   - 登记键 = `lane:paneId`：两个 herdr session 的 pane id 可能各自从 `w1:p1` 起编号，
 *     跨 lane 同名时按 id 查找会歧义，调用方返回 `ambiguous-terminal`。
 *   - workspace 绑定严格按 `(dsh session, lane)` 建键，会话之间不共享。
 *   - 同终端操作串行化；workspace 类动作（create / list）另有一把共享队列，
 *     避免并发建出两个 workspace。
 *   - dsh 退出时按 `closeOnExit` 逐条 `tab close` 登记终端；其后若某绑定 workspace 已空，
 *     由程序内部一并 `workspace close`（不出工具面）。
 */

import type { CliRunResult, HerdrRunner, SyncRunner } from "./cli.ts";
import { createSpawnSyncRunner, parseEnvelope } from "./cli.ts";
import type {
  Lane,
  ResolvedConfig,
  TerminalRecord,
  WorkspaceBinding,
} from "./types.ts";
import { withLane } from "./workspace.ts";

/** 终端查找结果（跨 lane 同 id 时 ambiguous）。 */
export interface TerminalLookup {
  record?: TerminalRecord;
  ambiguous?: boolean;
}

/** 登记键（lane + pane id）。 */
function recordKey(lane: Lane, paneId: string): string {
  return `${lane}:${paneId}`;
}

/** 绑定键（会话 + lane）。 */
function bindingKey(sessionId: string, lane: Lane): string {
  return `${sessionId}:${lane}`;
}

/** 登记表（进程内内存态；dsh 进程重启即清空，崩溃残留靠 label 识别）。 */
export class TerminalRegistry {
  private readonly records = new Map<string, TerminalRecord>();
  private readonly bindings = new Map<string, WorkspaceBinding>();
  /** 同终端 / 同队列的串行化尾部 Promise。 */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  /** 当前登记的终端（创建顺序）。 */
  get terminals(): TerminalRecord[] {
    return [...this.records.values()];
  }

  /** 是否登记过该终端（任一 lane）。 */
  has(terminalId: string): boolean {
    const lookup = this.find(terminalId);
    return lookup.record !== undefined || lookup.ambiguous === true;
  }

  /**
   * 按 terminal_id 查找登记记录。
   * 两个 lane 各有一条同 id 记录时返回 `ambiguous: true`（调用方给结构化错误）。
   */
  find(terminalId: string): TerminalLookup {
    const matches = [...this.records.values()].filter(
      (record) => record.paneId === terminalId,
    );
    if (matches.length === 0) return {};
    if (matches.length > 1) return { ambiguous: true };
    const [record] = matches;
    return record === undefined ? {} : { record };
  }

  /** 登记（重复登记按最新一次覆盖，创建时间沿用首次）。 */
  register(input: {
    paneId: string;
    tabId: string;
    lane: Lane;
    sessionId: string;
    workspaceId: string;
    label?: string;
    cwd?: string;
  }): TerminalRecord {
    const key = recordKey(input.lane, input.paneId);
    const previous = this.records.get(key);
    const record: TerminalRecord = {
      paneId: input.paneId,
      tabId: input.tabId,
      lane: input.lane,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      label: input.label ?? this.label,
      createdAt: previous?.createdAt ?? Date.now(),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    };
    this.records.set(key, record);
    return record;
  }

  /** 注销（`herdr_close` 成功后调用；重复注销无副作用）。 */
  unregister(record: Pick<TerminalRecord, "lane" | "paneId">): void {
    const key = recordKey(record.lane, record.paneId);
    this.records.delete(key);
    this.queues.delete(key);
  }

  /** 更新登记记录的 label（`herdr_label` 成功后调用）。 */
  relabel(record: TerminalRecord, label: string): TerminalRecord {
    const updated: TerminalRecord = { ...record, label };
    this.records.set(recordKey(record.lane, record.paneId), updated);
    return updated;
  }

  /** 取 (会话, lane) 的 workspace 绑定（未用时 undefined）。 */
  getBinding(sessionId: string, lane: Lane): WorkspaceBinding | undefined {
    return this.bindings.get(bindingKey(sessionId, lane));
  }

  /** 写 / 清 (会话, lane) 的 workspace 绑定（清空传 undefined）。 */
  setBinding(
    sessionId: string,
    lane: Lane,
    binding: WorkspaceBinding | undefined,
  ): void {
    const key = bindingKey(sessionId, lane);
    if (binding === undefined) this.bindings.delete(key);
    else this.bindings.set(key, binding);
  }

  /** 某会话的全部绑定（list 用；lane 顺序固定）。 */
  bindingsOf(sessionId: string): WorkspaceBinding[] {
    return [...this.bindings.values()].filter(
      (binding) => binding.sessionId === sessionId,
    );
  }

  /** 全部绑定（退出清理用）。 */
  allBindings(): WorkspaceBinding[] {
    return [...this.bindings.values()];
  }

  /** 清空（退出清理后调用；含终端、绑定与队列）。 */
  clear(): void {
    this.records.clear();
    this.bindings.clear();
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

/** 退出清理结果（每条终端一条，供日志与真机验证）。 */
export interface CleanupEntry {
  terminalId: string;
  /** 是否尝试关闭（`closeOnExit: false` 时不尝试）。 */
  attempted: boolean;
}

/** 退出清理面（`main.ts` 在 dispose 与 `process.exit` 回调里调用）。 */
export interface ExitCleanup {
  /** 同步尽力关闭全部登记终端（返回尝试记录；`closeOnExit: false` 时为空）。 */
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
  run: (lane: Lane, args: string[]) => ReturnType<SyncRunner>,
  workspaceId: string,
  lane: Lane,
): Record<string, unknown>[] | undefined {
  const result = run(lane, ["pane", "list", "--workspace", workspaceId]);
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
 * 构造同步退出清理器：逐条 `spawnSync(herdr, ["tab","close",id])`（每条约 3s 上限，
 * background 终端带 `--session dshbg`）。关闭全部登记终端后，按绑定逐个核对：
 * workspace 里已无 pane 才 `workspace close`；用户后来在其中开的 pane 会让该判定不成立。
 */
export function createExitCleanup(
  binPath: string | undefined,
  registry: TerminalRegistry,
  config: ResolvedConfig,
  options: ExitCleanupOptions = {},
): ExitCleanup {
  return {
    closeAllSync(): CleanupEntry[] {
      const records = registry.terminals;
      const bindings = registry.allBindings();
      const entries: CleanupEntry[] = records.map((record) => ({
        terminalId: record.paneId,
        attempted: config.closeOnExit && binPath !== undefined,
      }));
      if (!config.closeOnExit || binPath === undefined) {
        registry.clear();
        return entries;
      }
      const timeoutMs = options.timeoutMs ?? 3000;
      const base = options.runSync ?? createSpawnSyncRunner(binPath);
      const run = (lane: Lane, args: string[]) =>
        base(withLane(lane, args), timeoutMs);
      for (const record of records) {
        run(record.lane, tabCloseArgs(record.tabId));
      }
      for (const binding of bindings) {
        const remaining = listWorkspacePanesSync(
          run,
          binding.workspaceId,
          binding.lane,
        );
        if (remaining !== undefined && remaining.length === 0) {
          run(binding.lane, workspaceCloseArgs(binding.workspaceId));
        }
      }
      registry.clear();
      return entries;
    },
  };
}

/** 关闭 tab 的 argv（`herdr_close`、退出清理与真机断言共用）。 */
export function tabCloseArgs(tabId: string): string[] {
  return ["tab", "close", tabId];
}

/** 改 tab 标题的 argv（`herdr_label` 用）。 */
export function tabRenameArgs(tabId: string, label: string): string[] {
  return ["tab", "rename", tabId, label];
}

/** 改 pane 归属标记的 argv（`herdr_label` 用；与 tab 标题同步）。 */
export function paneRenameArgs(paneId: string, label: string): string[] {
  return ["pane", "rename", paneId, label];
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
