/**
 * 审计双落点（决策 5 选定 b + 2026-10-17 双落点裁定）：
 *
 * | 落点 | 载体 | 谁管 | 不可用时 |
 * | --- | --- | --- | --- |
 * | 会话 | `<会话目录>/auto-approve-audit.jsonl`（经 `sessionPaths.sessionDirFor`） | 本包（同步 append） | **退回人工面板 + 一次警告** |
 * | 项目 | memory-base `project` 层 kind `approval_audit`（作用域句柄 `put`） | memory-base | 跳过（计数 + 一次 warn，不影响裁定） |
 *
 * 每行字段两处同形，**不记参数原文与命令全文**（避免把凭据 / 敏感路径写进日志）。
 * 会话那份单文件上限 16 MiB（可配置）；达上限保留最近一半并写一条 `truncated` marker 行。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AuditHealth, AuditLine, FingerprintView } from "./types.ts";

/** 会话审计文件名（与决策 5 的落点一致）。 */
export const AUDIT_FILE_NAME = "auto-approve-audit.jsonl";
/** memory-base 分类名。 */
export const AUDIT_KIND = "approval_audit";
/** 进程内保留的最近审计行数（`/autoapprove log` 与 `recent()`）。 */
export const RECENT_LIMIT = 200;

/** `session-paths` 服务面的结构化子集。 */
export interface SessionPathsLike {
  sessionDirFor(sessionId: string): string;
}

/** memory-base 写入句柄的结构化子集（重设后的 `MemoryScope`）。 */
export interface MemoryScopeLike {
  put(input: {
    content: string;
    tier: string;
    project?: string;
    title?: string;
    source?: { kind: string; label?: string; ref?: string };
    [key: string]: unknown;
  }): Promise<unknown> | unknown;
}

/** memory-base 服务面的结构化子集（可选依赖）。 */
export interface MemoryLike {
  registerKind?(spec: {
    kind: string;
    writableTiers?: readonly string[];
  }): Promise<MemoryScopeLike> | MemoryScopeLike;
}

/** 审计写入口（判定层只依赖这个面）。 */
export interface AuditWriter {
  /** 会话那份当前是否可写（`false` = 判定必须退回人工面板）。 */
  sessionUsable(): boolean;
  /** 记一行（两处同形；会话那份失败即降级）。 */
  write(line: AuditLine): void;
  /** 健康度快照。 */
  health(): AuditHealth;
  /** 进程内最近 n 行（新→旧）。 */
  recent(n: number): readonly AuditLine[];
  /** 释放（无异步资源时为空实现）。 */
  dispose(): void;
}

interface SessionTarget {
  dir: string;
  path: string;
}

/** 创建审计写入器。 */
export function createAudit(options: {
  sessionPaths: SessionPathsLike | undefined;
  memory: MemoryLike | undefined;
  /** 是否写项目那份（`audit.project`）。 */
  projectEnabled: boolean;
  /** 会话那份单文件上限（字节）。 */
  maxBytes: number;
  warn: (message: string) => void;
  /** 取会话 cwd / 项目名（项目那份的 `project` 字段）。 */
  projectOf: (sessionId: string) => string | undefined;
}): AuditWriter {
  const recent: AuditLine[] = [];
  const health: AuditHealth = {
    sessionWritable: true,
    projectWritable: options.projectEnabled,
    projectSkipped: 0,
    sessionLines: 0,
    truncated: false,
  };
  if (options.sessionPaths === undefined) {
    degrade(
      "session-paths 服务不可用（未挂载或会话目录不可得），会话审计落点不可得",
    );
  }
  if (options.projectEnabled && options.memory === undefined) {
    health.projectWritable = false;
    options.warn(
      "memory-base 未挂载或不可用：项目那份审计行将被跳过（不影响裁定）",
    );
  }
  let scope: MemoryScopeLike | undefined;
  let scopeState: "idle" | "pending" | "failed" = "idle";
  let warnedMemory = false;

  function degrade(reason: string): void {
    if (!health.sessionWritable) return;
    health.sessionWritable = false;
    health.degradedReason = reason;
    options.warn(`${reason}：自动放行已停用，未命中判据的请求回到人工面板`);
  }

  /** 懒取 memory-base 句柄（apply 期注册一次，失败只记一次警告并跳过项目那份）。 */
  async function projectScope(): Promise<MemoryScopeLike | undefined> {
    if (!options.projectEnabled) return undefined;
    if (scope !== undefined) return scope;
    if (scopeState === "failed" || scopeState === "pending") return undefined;
    const memory = options.memory;
    if (memory === undefined || typeof memory.registerKind !== "function") {
      health.projectWritable = false;
      return undefined;
    }
    scopeState = "pending";
    try {
      const handle = await memory.registerKind({
        kind: AUDIT_KIND,
        writableTiers: ["project"],
      });
      if (handle === undefined || typeof handle.put !== "function") {
        throw new Error("registerKind 未返回可写句柄");
      }
      scope = handle;
      scopeState = "idle";
      health.projectWritable = true;
      return handle;
    } catch (error) {
      scopeState = "failed";
      health.projectWritable = false;
      if (!warnedMemory) {
        warnedMemory = true;
        options.warn(
          `memory-base 审计句柄注册失败，项目那份审计行将被跳过：${String(error)}`,
        );
      }
      return undefined;
    }
  }

  function targetOf(sessionId: string): SessionTarget {
    if (options.sessionPaths === undefined) {
      throw new Error("session-paths 服务不可用");
    }
    const dir = options.sessionPaths.sessionDirFor(sessionId);
    if (typeof dir !== "string" || dir.length === 0) {
      throw new Error("sessionDirFor 未返回目录");
    }
    return { dir, path: join(dir, AUDIT_FILE_NAME) };
  }

  /** 达上限截断：保留最近一半并写 marker。 */
  function truncate(path: string, maxBytes: number): void {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    const keep = lines.slice(Math.floor(lines.length / 2));
    const marker = JSON.stringify({
      t: new Date().toISOString(),
      truncated: true,
      keptLines: keep.length,
    });
    writeFileSync(path, `${[marker, ...keep].join("\n")}\n`, "utf8");
    health.truncated = true;
  }

  function writeSession(line: AuditLine): void {
    let target: SessionTarget;
    try {
      target = targetOf(line.sessionId);
    } catch (error) {
      degrade(`会话审计落点不可得（${String(error)}）`);
      return;
    }
    try {
      if (!existsSync(target.dir))
        mkdirSync(target.dir, { recursive: true, mode: 0o700 });
      if (
        existsSync(target.path) &&
        statSync(target.path).size >= options.maxBytes
      ) {
        try {
          truncate(target.path, options.maxBytes);
        } catch (error) {
          degrade(`会话审计文件达上限且截断失败（${String(error)}）`);
          return;
        }
      }
      appendFileSync(target.path, `${JSON.stringify(line)}\n`, "utf8");
      health.sessionFilePath = target.path;
      health.sessionLines += 1;
      health.sessionWritable = true;
      if (health.degradedReason !== undefined)
        health.degradedReason = undefined;
    } catch (error) {
      degrade(`会话审计文件写入失败（${String(error)}）`);
    }
  }

  async function writeProject(line: AuditLine): Promise<void> {
    const handle = await projectScope();
    if (handle === undefined) {
      health.projectSkipped += 1;
      return;
    }
    try {
      const project = options.projectOf(line.sessionId);
      await handle.put({
        content: JSON.stringify(line),
        tier: "project",
        ...(project === undefined ? {} : { project }),
        title: `auto-approve ${line.sessionId.slice(0, 8)} ${line.t}`,
        source: {
          kind: "manual",
          label: "auto-approve",
          ...(line.callId === undefined ? {} : { ref: line.callId }),
        },
      });
    } catch (error) {
      // 隐私闸 / 参数级错误：只记计数，不重试、不改写内容绕过
      health.projectSkipped += 1;
      if (!warnedMemory) {
        warnedMemory = true;
        options.warn(`项目那份审计行写入被跳过（不重试）：${String(error)}`);
      }
    }
  }

  return {
    sessionUsable(): boolean {
      return health.sessionWritable;
    },
    write(line: AuditLine): void {
      if (health.sessionWritable) writeSession(line);
      // 会话那份没写成功时**不**认这条记录（判定层会退回人工面板，`log` 不虚报）
      if (health.sessionWritable) {
        recent.unshift(line);
        if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
      }
      if (options.projectEnabled) void writeProject(line);
    },
    health(): AuditHealth {
      return { ...health };
    },
    recent(n: number): readonly AuditLine[] {
      return recent.slice(0, Math.max(0, n));
    },
    dispose(): void {
      recent.length = 0;
    },
  };
}

/** 服务面里 `recent()` 与审计行同形（类型别名，避免调用方再声明一次）。 */
export type AuditRecent = readonly AuditLine[];
/** 指纹视图（服务面 re-export 用）。 */
export type { FingerprintView };
