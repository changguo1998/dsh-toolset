// src/worktree.ts — executor 隔离（自建简易 worktree）：建 / 复用 / 回收
//
// 语义见下方原注释；所有 git 调用一律 execFile 直调（不经 shell），且复用命令复查器
// （命中即不执行，回执原文原样返回）。本模块只管现场，不关心引擎状态机。

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { execFileAsync } from "./command.ts";
import { validateIsolateId } from "./gate.ts";
import type { CommandChecker } from "./guard.ts";
import type { ExecutorSpec, FrameId } from "./types.ts";

// ---------------------------------------------------------------------------
// executor 隔离（自建简易 worktree，见 README「executor 隔离」）
//
// 语义：叶子声明 `isolate: "worktree"` → 执行前建 git worktree（`<repo>/.worktree/<leafId 安全化>`，
// 分支 `dsh/<leafId 安全化>`），把该路径作为 `cwd` 交给后端；帧进入终态（done / failed）时回收。
// 边界（简单版）：不自动 merge、不做审查 / checkpoint、不处理远程；**仅 command 后端生效**
// （宿主 `SubagentStartRequest` / workflow 面到 0.2.0 都没有 cwd 参数 → 声明期即拒绝，
// 不做「假装隔离」；0.2.1 起 `SubagentStartRequest` 支持 `cwd`（见
// `docs/host/HOST-UPGRADE-0.2.1-rc.2.md` / upstream `working-directory` 升级指南），
// subagent 后端的 worktree 隔离技术上可落地——**本期仍未启用**（决策 D2，隔离能力另开条目
// 实现，此处只更新口径；start request 里的 `cwd` 字段自 0.2.1 起会被宿主接受）。
// 所有 git 调用一律 `execFile` 直调（不经 shell），且**复用** `makeCommandGuard` 做执行前复查
// （source = `task-engine{worktree} <leafId> cwd=<repo>`）：命中即不执行，回执原文原样返回。
// ---------------------------------------------------------------------------

/** 隔离工作区在仓库根下的目录名（本仓已 .gitignore 忽略） */
const WORKTREE_DIR = ".worktree";
/** 隔离分支前缀 */
const WORKTREE_BRANCH_PREFIX = "dsh/";

/** 隔离出的工作区句柄（同一 leafId 二次执行复用，D5） */
interface WorktreeHandle {
  repo: string;
  path: string;
  branch: string;
}

/** git 调用结果（blocked = guard 命中，命令未执行，stdout 为回执原文） */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  blocked?: boolean;
}

/** 隔离器的对外形态（建 / 复用 + 回收） */
export interface WorktreeIsolator {
  /** 建或复用该帧的 worktree；ok 时 `cwd` = 该路径 */
  ensure(frameId: FrameId, declaredCwd?: string): Promise<IsolateOutcome>;
  /** 回收 worktree + 分支；返回非空 = 回收失败注记（现场保留，路径在内） */
  reclaim(frameId: FrameId): Promise<string | undefined>;
  /** 批量回收（插件卸载等收尾路径的 best-effort；逐帧与 reclaim 同语义） */
  reclaimAll(): Promise<string[]>;
}

/** ensure 结果 */
export type IsolateOutcome =
  { ok: true; cwd: string } | { ok: false; feedback: string };

/** 路径规范化（realpath 失败回退 resolve；用于「该路径是否就是 worktree 根」比对） */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** 取文本首行（错误反馈只带关键一行，避免整段 stderr 灌进回执） */
function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * leafId → 隔离段（目录名 / 分支名）：只留 `[A-Za-z0-9_-]`，其余替换为 `_`
 * （防 `../../evil` 之类路径穿越，也避开非法 git 引用名）；若清洗结果与原值不同，
 * 追加 8 位短哈希，避免「清洗后撞名」让两个 leaf 共用同一工作区。
 * 合法 id（如 `c1` / `frame-2`）零变化。
 */
export function worktreeSegment(frameId: string): string {
  const cleaned = frameId.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = cleaned === "" ? "_" : cleaned;
  if (base === frameId) return base;
  return `${base}-${createHash("sha1").update(frameId).digest("hex").slice(0, 8)}`;
}

/**
 * 隔离声明复查（执行期；同一套规则在声明期由 `gate.validateExecutor` 先挡一道，
 * 这里兜住 Config / 旁路带进来的 executor）：只认 `"worktree"`，且只对 `command` 后端生效。
 * 返回 null = 放行。
 */
export function checkIsolateDecl(
  spec: ExecutorSpec,
  frameId: FrameId,
): string | null {
  const isolate: unknown = spec.isolate;
  if (isolate === undefined) return null;
  if (isolate !== "worktree") {
    return `executor.isolate 目前只支持 "worktree"（收到 ${JSON.stringify(isolate)}）`;
  }
  if (spec.kind !== "command") {
    return `isolate:"worktree" 只对 command 后端生效：宿主 ${spec.kind} 面没有 cwd 参数，隔离无处落地（请改用 command 后端，或去掉 isolate 声明）`;
  }
  // id 规则（同 gate.validateIsolateId）：root 契约声明执行后端时绕过 decompose 门禁，这里兜住
  return validateIsolateId(frameId);
}

/**
 * 自建简易 worktree 隔离器（内存态：进程内按 leafId 记账；重启后靠 worktree 现状复用）。
 * 三个不变量：① 建之前先复查 git 命令（D3）；② 同一 leafId 只 `add` 一次（D5）；
 * ③ 回收失败保留现场并把路径写进注记（D4，不静默）。
 */
export function makeWorktreeIsolator(opts: {
  checkCommand: CommandChecker;
  warn(message: string): void;
}): WorktreeIsolator {
  const held = new Map<FrameId, WorktreeHandle>();

  const sourceOf = (frameId: FrameId, repo: string): string =>
    `task-engine{worktree} ${frameId} cwd=${repo}`;

  /** git 调用（D3）：先经 guard 复查，命中即不执行；未命中才 execFile 直调 */
  const git = async (
    args: string[],
    cwd: string,
    source: string,
  ): Promise<GitResult> => {
    const check = opts.checkCommand(["git", ...args].join(" "), source);
    if (check.receipt !== null) {
      return { code: -1, stdout: check.receipt, stderr: "", blocked: true };
    }
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd,
        timeout: 60_000,
      });
      return { code: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (err) {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: typeof e.code === "number" ? e.code : 1,
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? ""),
      };
    }
  };

  /** guard 命中的统一回执包装（回执原文**原样**进 feedback，D3） */
  const blockedFeedback = (what: string, receipt: string): string =>
    `${what}被 security-guard 执行前复查拦截（未执行）：\n${receipt}`;

  /** 该路径是否已是可用 worktree（`--show-toplevel` 指回自己，而非外层主树） */
  const isWorktree = async (
    path: string,
    frameId: FrameId,
    repo: string,
  ): Promise<boolean> => {
    if (!existsSync(path)) return false;
    const r = await git(
      ["rev-parse", "--show-toplevel"],
      path,
      sourceOf(frameId, repo),
    );
    if (r.code !== 0) return false;
    return realPath(r.stdout.trim()) === realPath(path);
  };

  const ensure = async (
    frameId: FrameId,
    declaredCwd?: string,
  ): Promise<IsolateOutcome> => {
    // D5 幂等：同一 leafId 已在册 → 按**注册表**复核仍是可用 worktree（不用 fs 存在判断：
    // 被外部删剩的空目录会被 git 接管成畸形工作区），复核不过就丢掉句柄重建
    const existing = held.get(frameId);
    if (
      existing !== undefined &&
      (await isWorktree(existing.path, frameId, existing.repo))
    ) {
      return { ok: true, cwd: existing.path };
    }
    held.delete(frameId);
    // 仓库根：只在声明的 cwd 下问 git（不猜 process.cwd()，避免建到别的仓）
    if (declaredCwd === undefined || declaredCwd.trim() === "") {
      return {
        ok: false,
        feedback:
          'isolate:"worktree" 需要同时声明 cwd（隔离仓库内的起点目录）：引擎在它下面跑 `git rev-parse --show-toplevel`，不猜 process.cwd()（声明问题，不计重试）。',
      };
    }
    const start = declaredCwd;
    const top = await git(
      ["rev-parse", "--show-toplevel"],
      start,
      sourceOf(frameId, start),
    );
    if (top.blocked === true) {
      return {
        ok: false,
        feedback: blockedFeedback("隔离仓库定位（git rev-parse）", top.stdout),
      };
    }
    const repo = top.stdout.trim();
    if (top.code !== 0 || repo === "") {
      const detail = firstLine(top.stderr === "" ? top.stdout : top.stderr);
      return {
        ok: false,
        feedback:
          `isolate:"worktree" 需要一个 git 仓库：` +
          `\`git rev-parse --show-toplevel\`（cwd=${start}）失败` +
          (detail === "" ? "。" : `：${detail}。`) +
          "（环境 / 声明问题，不计重试）",
      };
    }
    const segment = worktreeSegment(frameId);
    const rootDir = join(repo, WORKTREE_DIR);
    const path = resolve(rootDir, segment);
    // 路径收敛断言（防穿越）：最终路径必须在 <repo>/.worktree/ 之内，否则不执行任何 git 写操作
    if (!(path === rootDir || path.startsWith(`${rootDir}${sep}`))) {
      return {
        ok: false,
        feedback:
          `隔离工作区路径越界：leafId=${JSON.stringify(frameId)} → ${path} 不在 ${rootDir} 之内，` +
          "已拒绝执行（leafId 安全化规则见 worktreeSegment；声明问题，不计重试）。",
      };
    }
    const branch = `${WORKTREE_BRANCH_PREFIX}${segment}`;
    // 目录已是同帧的 worktree（例如进程重启后重入）→ 直接复用
    if (await isWorktree(path, frameId, repo)) {
      held.set(frameId, { repo, path, branch });
      return { ok: true, cwd: path };
    }
    const add = await git(
      ["worktree", "add", "-b", branch, path],
      repo,
      sourceOf(frameId, repo),
    );
    if (add.blocked === true) {
      return {
        ok: false,
        feedback: blockedFeedback(
          "建隔离工作区（git worktree add）",
          add.stdout,
        ),
      };
    }
    if (add.code !== 0) {
      // 崩后残留 / 分支已存在（分支在、目录不在）：先 `worktree prune` 清掉指向已消失目录的元数据，
      // 否则下一步 -B 会因「already used by worktree」继续失败（实测）；再用 -B 重建并绑定该分支
      const pruned = await git(
        ["worktree", "prune"],
        repo,
        sourceOf(frameId, repo),
      );
      if (pruned.blocked === true) {
        return {
          ok: false,
          feedback: blockedFeedback(
            "清理 worktree 元数据（git worktree prune）",
            pruned.stdout,
          ),
        };
      }
      const rebind = await git(
        ["worktree", "add", "-B", branch, path],
        repo,
        sourceOf(frameId, repo),
      );
      if (rebind.blocked === true) {
        return {
          ok: false,
          feedback: blockedFeedback(
            "建隔离工作区（git worktree add -B）",
            rebind.stdout,
          ),
        };
      }
      if (rebind.code !== 0) {
        return {
          ok: false,
          feedback:
            `建隔离工作区失败（路径 ${path} / 分支 ${branch} 冲突或不可建）：` +
            `${firstLine(rebind.stderr === "" ? rebind.stdout : rebind.stderr)}` +
            `（首次失败：${firstLine(add.stderr === "" ? add.stdout : add.stderr)}；prune 后仍失败）`,
        };
      }
    }
    held.set(frameId, { repo, path, branch });
    return { ok: true, cwd: path };
  };

  /**
   * 回收一帧的隔离工作区（D4，**永不 `--force`**）：
   * ① 先查**注册表**（`git worktree list --porcelain`）：不在册 = 已回收干净（幂等，不靠 fs 存在判断）；
   * ② 目录不在但注册残留 → `worktree prune` 清元数据；
   * ③ 目录在 → 先 `git status --porcelain`：**非空（有未提交改动 / 未跟踪产出）一律保留现场**，
   *    给出路径 + 取回提示，并**跳过** `branch -D`（回收不丢产出）；
   * ④ 只有干净工作区才 `worktree remove`，成功后才 `branch -D`（worktree 还在时删其分支必失败）；
   * 任何一步失败都保留现场，并把路径与原因写进注记（不静默）。
   */
  const reclaim = async (frameId: FrameId): Promise<string | undefined> => {
    const h = held.get(frameId);
    if (h === undefined) return undefined; // 未隔离 / 已回收
    const src = sourceOf(frameId, h.repo);
    const failures: string[] = [];
    const target = realPath(h.path);
    // ① 注册表核对（幂等：外部已回收 / 已 prune 过 → 视为干净）
    const listed = await git(["worktree", "list", "--porcelain"], h.repo, src);
    if (listed.blocked === true) {
      failures.push(
        blockedFeedback(
          "查 worktree 注册表（git worktree list）",
          listed.stdout,
        ),
      );
    } else if (listed.code !== 0) {
      failures.push(
        `git worktree list --porcelain 失败：${firstLine(listed.stderr === "" ? listed.stdout : listed.stderr)}`,
      );
    } else {
      const inRegistry = listed.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .some((line) => realPath(line.slice("worktree ".length)) === target);
      if (!inRegistry) {
        // 已不在注册表：回收已完成（可能由外部 / 上一次 prune 完成）
      } else if (!existsSync(h.path)) {
        // 注册残留（崩后残留）但目录已不在：prune 清元数据即可，不动任何工作区内容
        const pruned = await git(["worktree", "prune"], h.repo, src);
        if (pruned.code !== 0) {
          failures.push(
            pruned.blocked === true
              ? blockedFeedback(
                  "清理 worktree 元数据（git worktree prune）",
                  pruned.stdout,
                )
              : `git worktree prune 失败：${firstLine(pruned.stderr === "" ? pruned.stdout : pruned.stderr)}`,
          );
        }
      } else {
        // ③ 脏树取舍：非空即保留现场（不删文件、不删分支），并给取回提示
        const status = await git(["status", "--porcelain"], h.path, src);
        if (status.blocked === true) {
          failures.push(
            blockedFeedback("查隔离工作区状态（git status）", status.stdout),
          );
        } else if (status.code !== 0) {
          failures.push(
            `git status --porcelain 失败：${firstLine(status.stderr === "" ? status.stdout : status.stderr)}`,
          );
        } else if (status.stdout.trim() !== "") {
          const dirty = status.stdout.trim().split("\n").length;
          failures.push(
            `工作区有未提交改动（${dirty} 处）：按「不丢产出」策略**不删除**（回收永不 --force），` +
              `现场保留在 ${h.path}；如需保留产出，请先自行提交 / 复制到主树，再手动回收` +
              `（git worktree remove ${h.path} 与 git branch -D ${h.branch}）`,
          );
        } else {
          // ④ 干净工作区才 remove；失败（锁定等）同样保留现场
          const remove = await git(["worktree", "remove", h.path], h.repo, src);
          if (remove.code !== 0) {
            failures.push(
              remove.blocked === true
                ? blockedFeedback(
                    "回收隔离工作区（git worktree remove）",
                    remove.stdout,
                  )
                : `git worktree remove 被拒（被锁定等，现场保留）：${firstLine(remove.stderr === "" ? remove.stdout : remove.stderr)}`,
            );
          }
        }
      }
    }
    // ⑤ 分支：上面全成功才删；分支已不在 = 已回收干净（幂等，不靠本地化报错文本判断）
    if (failures.length === 0) {
      const branches = await git(["branch", "--list", h.branch], h.repo, src);
      if (branches.blocked === true) {
        failures.push(
          blockedFeedback("查隔离分支（git branch --list）", branches.stdout),
        );
      } else if (branches.code !== 0) {
        failures.push(
          `git branch --list 失败：${firstLine(branches.stderr === "" ? branches.stdout : branches.stderr)}`,
        );
      } else if (branches.stdout.trim() !== "") {
        const del = await git(["branch", "-D", h.branch], h.repo, src);
        if (del.code !== 0) {
          failures.push(
            del.blocked === true
              ? blockedFeedback("删除隔离分支（git branch -D）", del.stdout)
              : `git branch -D 失败：${firstLine(del.stderr === "" ? del.stdout : del.stderr)}`,
          );
        }
      }
    }
    if (failures.length === 0) {
      held.delete(frameId);
      return undefined;
    }
    // 回收失败：保留现场（句柄不删，路径写进注记 → 事件流 / stop 返回 / 告警三处可见）
    return `隔离 worktree 回收失败（现场保留在 ${h.path}，分支 ${h.branch}）：${failures.join("；")}`;
  };

  /** 批量回收（插件卸载等收尾路径的 best-effort）：逐帧同语义，失败只收集注记不抛 */
  const reclaimAll = async (): Promise<string[]> => {
    const notices: string[] = [];
    for (const frameId of [...held.keys()]) {
      try {
        const notice = await reclaim(frameId);
        if (notice !== undefined) notices.push(notice);
      } catch (err) {
        notices.push(`隔离 worktree 回收异常（帧 ${frameId}）：${String(err)}`);
      }
    }
    return notices;
  };

  return { ensure, reclaim, reclaimAll };
}
