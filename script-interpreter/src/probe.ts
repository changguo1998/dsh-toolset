/**
 * 解释器探测（决策 5）：显式配置 → 环境变量 → PATH 候选 → 常见绝对路径。
 *
 * 两条口径：
 * - **显式配置 / 环境变量不回落**：配了却不可执行时直接判缺失（避免静默跑错解释器），
 *   由调用方按「解释器缺失」返回安装指引；探测痕迹写进 apply 日志便于排障。
 * - **探测失败不影响挂载**：本模块只返回结果，不抛错；版本号拿不到只丢日志字段。
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";

import type {
  InterpreterInfo,
  InterpreterSource,
  LangBackend,
  ProbeOutcome,
} from "./types.ts";

/** 版本探测超时（毫秒）：只用于日志，卡住也不拖慢装配。 */
export const VERSION_TIMEOUT_MS = 3_000;

/** 文件存在且可执行。 */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 里按目录顺序找首个可执行命中；未命中返回 `null`。 */
export function searchPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    // 空段在 POSIX 语义里表示当前目录；本包不认这一套，跳过以免误跑工作区里的同名文件。
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 把「命令名或路径」解析成可执行路径。
 * 含分隔符或绝对路径 → 按路径判定；裸命令名 → 走 PATH。
 */
export function resolveExecutable(
  value: string,
  pathEnv: string,
): string | null {
  if (isAbsolute(value) || value.includes(sep) || value.includes("/")) {
    return isExecutableFile(value) ? value : null;
  }
  return searchPath(value, pathEnv);
}

/** 读解释器版本首行；拿不到返回 `undefined`（探测失败不影响装配）。 */
export function readVersion(
  path: string,
  versionArgs: readonly string[],
): string | undefined {
  const result = spawnSync(path, [...versionArgs], {
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error !== undefined) return undefined;
  // 有的解释器把版本打到 stderr（如 python2），两路一起看。
  const text = `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line !== "") return line;
  }
  return undefined;
}

/** 探测一种语言的解释器；返回命中信息与逐级尝试痕迹。 */
export function probeInterpreter(
  backend: LangBackend,
  options: { config?: string; env?: NodeJS.ProcessEnv } = {},
): ProbeOutcome {
  const env = options.env ?? process.env;
  const pathEnv = env.PATH ?? "";
  const trail: string[] = [];

  const hit = (path: string, source: InterpreterSource): ProbeOutcome => {
    const version =
      backend.versionArgs.length === 0
        ? undefined
        : readVersion(path, backend.versionArgs);
    const suffix = version === undefined ? "" : `, ${version}`;
    trail.push(`${source}:${path}（命中${suffix}）`);
    return {
      info: {
        path,
        source,
        ...(version === undefined ? {} : { version }),
      },
      trail,
    };
  };

  // ① 显式配置：不可执行即判缺失，不回落。
  const configured = options.config?.trim();
  if (configured !== undefined && configured !== "") {
    const resolved = resolveExecutable(configured, pathEnv);
    if (resolved === null) {
      trail.push(`config:${configured}（不可执行，不回落）`);
      return { info: null, trail };
    }
    return hit(resolved, "config");
  }

  // ② 环境变量：同样不回落。
  const fromEnv = env[backend.envVar]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    const resolved = resolveExecutable(fromEnv, pathEnv);
    if (resolved === null) {
      trail.push(`env:${backend.envVar}=${fromEnv}（不可执行，不回落）`);
      return { info: null, trail };
    }
    return hit(resolved, "env");
  }

  // ③ PATH 候选（`python3` → `python` 之类按序命中）。
  for (const name of backend.candidates) {
    const resolved = searchPath(name, pathEnv);
    if (resolved !== null) return hit(resolved, "path");
    trail.push(`path:${name}（未命中）`);
  }

  // ④ 常见绝对路径。
  for (const candidate of backend.absolutePaths) {
    if (isExecutableFile(candidate)) return hit(candidate, "absolute");
    trail.push(`absolute:${candidate}（未命中）`);
  }
  return { info: null, trail };
}
