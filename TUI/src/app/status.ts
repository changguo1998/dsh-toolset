// src/app/status.ts — 系统状态区数据源（合并节流读取）
//
// StatusTicker 以固定间隔 tick；每个 tick 内对 cwd/git/time 等做"一次合并查询"，
// 聚合为单个 Partial<SystemStatus> 交给 App 更新状态。queries 与 schedule 均可注入：
//  - queries：真实实现用 process.cwd()/git 子进程；测试用计数假实现断言"一次 tick
//    内不重复 fork"。
//  - schedule：真实用 setInterval；测试用手动驱动，tickCount 可数。
//
// 模型/上下文长度/缓存命中率无数据源，保持占位，不进查询（见 SystemStatus 注释）。

import type { SystemStatus } from "./state.ts";

/** 状态项查询器；git 为异步子进程调用，time/cwd 同步 */
export interface StatusQueries {
  time(): string;
  cwd(): string;
  git(): Promise<string> | string;
}

export type StatusApply = (status: Partial<SystemStatus>) => void;

export interface StatusTickerOptions {
  queries: StatusQueries;
  /** 合并节流间隔(ms)；tick 触发时一次性批量查询 */
  intervalMs: number;
  /** 每 tick 把聚合结果交给 App */
  apply: StatusApply;
  /** 调度器（可注入；默认 setInterval）。返回取消函数 */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export class StatusTicker {
  private options: StatusTickerOptions;
  private cancel: (() => void) | null = null;
  /** 已触发的 tick 次数（可测：手动驱动时递增） */
  tickCount = 0;

  constructor(options: StatusTickerOptions) {
    this.options = options;
  }

  /** 立即执行一次合并查询（也可用作首帧快速填充） */
  async tick(): Promise<void> {
    const q = this.options.queries;
    const git = await q.git();
    this.tickCount++;
    this.options.apply({
      time: q.time(),
      cwd: q.cwd(),
      git: String(git),
    });
  }

  start(): void {
    if (this.cancel) return;
    const schedule =
      this.options.schedule ??
      ((fn, ms) => {
        const id = setInterval(fn, ms);
        return () => clearInterval(id);
      });
    // 先立即 tick 一次，避免首个 interval 周期内状态区空着
    void this.tick();
    this.cancel = schedule(() => void this.tick(), this.options.intervalMs);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }
}

// ---------------------------------------------------------------------------
// 真实实现：time = 本地时间；cwd = 进程当前目录；git = status --porcelain --branch
// ---------------------------------------------------------------------------

/** 家目录简写为 ~；非家目录下原样返回 */
export function shortenHome(path: string): string {
  const home = process.env.HOME;
  if (home && (path === home || path.startsWith(home + "/"))) {
    return "~" + path.slice(home.length);
  }
  return path;
}

/** 默认查询器：time/cwd 同步，git 走子进程（异常时返回占位 "—"） */
export function createProcessStatusQueries(): StatusQueries {
  return {
    // 时间精确到分钟
    time: () =>
      new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    // 家目录简写为 ~
    cwd: () => shortenHome(process.cwd()),
    git: () => gitStatus(),
  };
}

/**
 * 读取 git 状态摘要：分支 + 是否 dirty。
 * 输出示例：`main` / `main *`（* = 有未提交改动）/ `—`（非 git 仓库或读取失败）。
 * 用 execFile 而非 spawnSync 避免阻塞事件循环；超时 1500ms 防挂起。
 */
export function gitStatus(): Promise<string> {
  return new Promise((resolve) => {
    import("node:child_process")
      .then(({ execFile }) => {
        execFile(
          "git",
          ["status", "--porcelain", "--branch"],
          { timeout: 1500, encoding: "utf8" },
          (err, stdout) => {
            if (err) {
              resolve("—");
              return;
            }
            const lines = stdout.split("\n").filter((l) => l !== "");
            const branchLine = lines[0] ?? "";
            // `## main...origin/main [ahead 1]` → main
            const branch = branchLine
              .replace(/^## /, "")
              .split("...")[0]!
              .trim();
            const dirty = lines.slice(1).length > 0;
            resolve(branch === "" ? "—" : dirty ? `${branch} *` : branch);
          },
        );
      })
      .catch(() => resolve("—"));
  });
}
