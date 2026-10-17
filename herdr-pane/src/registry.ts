/**
 * src/registry.ts — 归属登记与生命周期
 *
 * 口径（设计文档决策项 6 / 7）：
 *   - 写类动作缺省只作用于**本插件创建并登记**的 pane；读类可读任意 pane；
 *     **缺省永不使用「当前聚焦 pane」**（官方技能：不依赖别的客户端的焦点）。
 *   - 创建成功后自动打一次 label（缺省 `dsh-pane`），让崩溃残留可被 `list` 与人工一眼识别。
 *   - dsh 退出时按 `closeOnExit` 关闭本次创建的 pane；关闭走 `spawnSync` 尽力送达
 *     （对齐 `herdr-integration` 的退出兜底），且**只针对登记过的 pane**。
 *   - 同 pane 的操作串行化（并发调用不交叉：建 / 发 / 关按提交顺序执行）。
 */

import type { HerdrRunner, CliRunResult } from "./cli.ts";
import { runHerdrSync } from "./cli.ts";
import type { ResolvedConfig } from "./types.ts";

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
}

/** 登记表查询面（只读）。 */
export interface RegistrySnapshot {
  /** 当前登记的 pane（创建顺序）。 */
  panes: PaneRecord[];
  /** 是否已登记（`list` 回执打标记用）。 */
  has(paneId: string): boolean;
}

/** 登记表（进程内内存态；dsh 进程重启即清空，崩溃残留靠 label 识别）。 */
export class PaneRegistry implements RegistrySnapshot {
  private readonly records = new Map<string, PaneRecord>();
  /** 同 pane 串行化的尾部 Promise（按 pane id 分桶）。 */
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
  }): PaneRecord {
    const record: PaneRecord = {
      paneId: input.paneId,
      label: input.label ?? this.label,
      createdAt: Date.now(),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    };
    this.records.set(record.paneId, record);
    return record;
  }

  /** 注销（`close` 成功后调用；重复注销无副作用）。 */
  unregister(paneId: string): void {
    this.records.delete(paneId);
    this.queues.delete(paneId);
  }

  /** 清空（退出清理后调用）。 */
  clear(): void {
    this.records.clear();
    this.queues.clear();
  }

  /**
   * 同 pane 串行化：把 `task` 排在该 pane 上一笔操作之后执行。
   * 不同 pane 互不阻塞；失败不影响后续排队（尾部始终落到「已结算」态）。
   */
  serialize<T>(paneId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(paneId) ?? Promise.resolve();
    const run = previous.then(task, task);
    // 尾部只用于排队，吞掉失败避免未处理拒绝
    this.queues.set(
      paneId,
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

/**
 * 构造同步退出清理器：逐条 `spawnSync(herdr, ["pane","close",id])`（每条约 3s 上限）。
 * 只关登记过的 pane；先快照再清空登记表（关闭失败也不留在内存里——进程随后就退出了，
 * 残留靠 label 事后识别）。
 */
export function createExitCleanup(
  binPath: string | undefined,
  registry: PaneRegistry,
  config: ResolvedConfig,
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
      for (const record of records) {
        runHerdrSync(binPath, ["pane", "close", record.paneId]);
      }
      registry.clear();
      return entries;
    },
  };
}

/** 关闭命令的 argv（异步 `close` 动作与同步退出清理共用，避免两处写法漂移）。 */
export function closeArgs(paneId: string): string[] {
  return ["pane", "close", paneId];
}

/** 重命名命令的 argv（`label` 动作与 `create` 后的自动打标共用）。 */
export function renameArgs(paneId: string, label: string): string[] {
  return label === ""
    ? ["pane", "rename", "--clear", paneId]
    : ["pane", "rename", paneId, label];
}

/** 单一 runner 的薄包装（退出清理之外的地方都走它，便于单测注入）。 */
export async function runPaneCommand(
  runner: HerdrRunner,
  args: string[],
  timeoutMs: number,
): Promise<CliRunResult> {
  return runner.run(args, timeoutMs);
}
