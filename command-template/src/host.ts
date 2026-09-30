// src/host.ts — 宿主面访问助手（受保护读取 + 宿主侧模块解析）。

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 受保护读宿主服务：`ctx.get(name)` 优先，直接属性读兜底并吞掉 cordis 抛错。
 * 真实 cordis ctx 上未 inject 的服务属性直读会抛 `cannot get property "x" without inject`——
 * 读取失败一律视为「服务不可用」。
 */
export function readService<T>(ctx: unknown, key: string): T | undefined {
  if (ctx === null || typeof ctx !== "object") return undefined;
  const host = ctx as Record<string, unknown>;
  const getter = host["get"];
  if (typeof getter === "function") {
    try {
      const value = (getter as (k: string) => unknown).call(host, key);
      if (value !== undefined && value !== null) return value as T;
    } catch {
      /* 严格模式读取异常 → 回退属性读 */
    }
  }
  try {
    const value = host[key];
    return value === undefined || value === null ? undefined : (value as T);
  } catch {
    return undefined;
  }
}

/**
 * 从宿主安装位置解析模块（本包不声明宿主包依赖，运行时按 `$DSH_HOME/profiles/node_modules` 解析）。
 * @param specifier - 宿主包名。
 * @returns 解析后的动态 import 入口（解析失败 → undefined）。
 */
export async function importHostModule(
  specifier: string,
): Promise<Record<string, unknown> | undefined> {
  const base = process.env["DSH_HOME"] ?? join(homedir(), ".dsh");
  const anchors = [
    join(base, "profiles", "node_modules", "anchor.js"),
    join(base, "profiles", "node_modules", "@deepseek-ai", "anchor.js"),
  ];
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor);
      const resolved = req.resolve(specifier);
      const mod = (await import(pathToFileURL(resolved).href)) as Record<
        string,
        unknown
      >;
      return mod;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** 描述错误消息（不抛）。 */
export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
