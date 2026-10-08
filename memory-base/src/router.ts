/**
 * 三层库的路径推导与层身份（设计 §2.1 数据路由、§12 #10 存储位置迁移）。
 *
 * | 层 | 库 | 位置 |
 * | --- | --- | --- |
 * | S 会话 | `session.db` | 宿主会话目录（**不自建** `<dshHome>/memory-base/sessions/`） |
 * | P 项目 | `project.db` | 项目根 `.dsh/` |
 * | U 用户 | `user.db` | `~/.dsh/memory-base/` |
 *
 * 只有根目录可经配置覆盖。会话目录**解析不到就返回 undefined**（调用方告警），不静默换路径
 * ——宿主 0.2.0-rc.2 未暴露「会话目录」读取面，实施时按 `<sessionsRoot>/<projectKey(cwd)>/<id>/`
 * 约定拼接（见 DESIGN §2.1 的核实结论）。
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 记忆作用域层。 */
export type Tier = "session" | "project" | "user";

export interface TierPathInput {
  /** 宿主会话目录（绝对路径）；解析不到就不要传。 */
  sessionDir?: string;
  /** 项目根（通常是会话 `header.cwd`）；不传则无 P 库。 */
  projectRoot?: string;
  /** 存储根：宿主 `dshHomePath(...)` 的父目录；缺省 `~/.dsh`。 */
  dshHome?: string;
}

export interface TierPaths {
  /** 会话库路径；无会话目录时为 `undefined`。 */
  session?: string;
  /** 项目库路径；无项目根时为 `undefined`。 */
  project?: string;
  /** 用户库路径（总是可推导）。 */
  user: string;
}

/** 库文件名（随层固定）。 */
export const TIER_DB_FILES: Record<Tier, string> = {
  session: "session.db",
  project: "project.db",
  user: "user.db",
};

/** 按层推导三个库的路径。 */
export function resolveTierPaths(input: TierPathInput = {}): TierPaths {
  const dshHome = resolve(input.dshHome ?? join(homedir(), ".dsh"));
  const paths: TierPaths = {
    user: join(dshHome, "memory-base", TIER_DB_FILES.user),
  };
  if (input.sessionDir !== undefined && input.sessionDir.length > 0) {
    paths.session = join(resolve(input.sessionDir), TIER_DB_FILES.session);
  }
  if (input.projectRoot !== undefined && input.projectRoot.length > 0) {
    paths.project = join(
      resolve(input.projectRoot),
      ".dsh",
      TIER_DB_FILES.project,
    );
  }
  return paths;
}

/**
 * 宿主会话目录的约定拼接（设计 §2.1）：`<sessionsRoot>/<projectKey(cwd)>/<sessionId>/`。
 * `projectKey` = cwd 去掉前导分隔符后把分隔符换成 `-`（与宿主分桶一致）。
 * **未经宿主承诺**，解析不到时调用方应告警而非静默使用。
 */
export function sessionDirFor(
  sessionsRoot: string,
  cwd: string,
  sessionId: string,
): string {
  const key = resolve(cwd)
    .replace(/^[/\\]+/, "")
    .replace(/[/\\]+/g, "-");
  return join(resolve(sessionsRoot), key, sessionId);
}
