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
 * git 工作区状态摘要（**未暂存视角**：新增/修改/删除只统计工作区一侧，
 * 仅已 `git add` 暂存、工作区一致的改动不计入）。
 */
export interface GitStatusSummary {
  /** 当前分支名（detached / 未出生分支按 git 原文） */
  branch: string;
  /** 本地领先上游的提交数（无上游=0） */
  ahead: number;
  /** 本地落后上游的提交数（无上游=0） */
  behind: number;
  /** 未跟踪文件数（未暂存的新增） */
  added: number;
  /** 未暂存修改数（含类型变更 T / 重命名 R / 复制 C） */
  modified: number;
  /** 未暂存删除数 */
  deleted: number;
}

/**
 * 解析 `git status --porcelain --branch` 输出（纯函数，可单测）。
 * 无 `## ` 分支行（非仓库/异常输出）返回 null。
 * 工作区列（Y）语义：`??`=未跟踪、`D`=删除、`M`/`T`/`R`/`C`=修改、`A`=新增。
 */
export function parseGitStatus(stdout: string): GitStatusSummary | null {
  const lines = stdout.split("\n").filter((l) => l !== "");
  const branchLine = lines.find((l) => l.startsWith("## "));
  if (branchLine === undefined) return null;
  const body = branchLine.slice(3);
  // `main...origin/main [ahead 2, behind 1]` → head=`main...origin/main`、ab=`ahead 2, behind 1`
  const abMatch = /\[([^\]]*)\]$/.exec(body);
  const ab = abMatch ? abMatch[1]! : "";
  const head = abMatch ? body.slice(0, abMatch.index) : body;
  const branch = head.split("...")[0]!.trim();
  const ahead = Number(/ahead (\d+)/.exec(ab)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(ab)?.[1] ?? 0);
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const line of lines) {
    if (line.startsWith("## ")) continue;
    if (line.startsWith("??")) {
      added++;
      continue;
    }
    if (line.length < 2) continue;
    // 只看工作区列（Y）；Y 为空格 = 仅暂存改动，不属「未暂存」不计
    const y = line[1]!;
    if (y === "D") deleted++;
    else if (y === "M" || y === "T" || y === "R" || y === "C") modified++;
    else if (y === "A") added++;
  }
  return { branch, ahead, behind, added, modified, deleted };
}

/**
 * 摘要 → 状态栏文本：`分支 ↑N ↓N +N ~N -N`（各类符号不同，计数为 0 省略）。
 * 符号：`↑`领先提交 / `↓`落后提交 / `+`未暂存新增 / `~`未暂存修改 / `-`未暂存删除。
 * 分支名为空 → `—` 占位。
 */
export function formatGitStatus(s: GitStatusSummary): string {
  if (s.branch === "") return "—";
  const parts = [s.branch];
  if (s.ahead > 0) parts.push(`↑${s.ahead}`);
  if (s.behind > 0) parts.push(`↓${s.behind}`);
  if (s.added > 0) parts.push(`+${s.added}`);
  if (s.modified > 0) parts.push(`~${s.modified}`);
  if (s.deleted > 0) parts.push(`-${s.deleted}`);
  return parts.join(" ");
}

/**
 * 读取 git 状态摘要文本（分支 + 领先/落后 + 未暂存各类计数）。
 * 输出示例：`main`（干净）/ `main ↑1 +2 ~3 -1` / `—`（非 git 仓库或读取失败）。
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
            const parsed = parseGitStatus(stdout);
            resolve(parsed ? formatGitStatus(parsed) : "—");
          },
        );
      })
      .catch(() => resolve("—"));
  });
}
