// src/registry.ts — 模板目录扫描与双源合并（仓库随包目录 + 用户目录，同名用户优先）。
//
// 纯文件 IO + 解析；失败逐个文件容错（坏模板不拖垮整次加载，记入 errors 供 `/playbook list` 展示）。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseTemplate, TemplateParseError } from "./frontmatter.ts";
import type { TemplateSpec } from "./types.ts";

/** 加载结果：模板（按名升序）+ 坏模板（路径 + 原因）。 */
export interface LoadResult {
  templates: TemplateSpec[];
  errors: { source: string; error: string }[];
}

/** 缺省用户模板目录（`$DSH_HOME/command-templates`，回退 `~/.dsh/command-templates`）。 */
export function defaultUserDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["DSH_HOME"] ?? join(homedir(), ".dsh");
  return join(home, "command-templates");
}

/** 包内随附模板目录（相对本文件：`dist/src` → 包根 `templates/`）。 */
export function bundledTemplatesDir(): string {
  return resolve(new URL(".", import.meta.url).pathname, "../../templates");
}

/** 解析目录列表（相对路径相对包根；缺省 = 随包目录）。 */
export function resolveDirs(
  dirs: string[] | undefined,
  bundled = bundledTemplatesDir(),
): string[] {
  if (dirs === undefined || dirs.length === 0) return [bundled];
  return dirs.map((dir) =>
    isAbsolute(dir) ? dir : resolve(bundled, "..", dir),
  );
}

/** 扫描一个目录下的 `*.md`（不存在 → 空；不递归）。 */
export function listTemplateFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * 加载多源模板：目录顺序 = 优先级从低到高（后者覆盖前者同名模板）。
 * @param dirs - 目录列表（低 → 高优先级）。
 */
export function loadTemplates(dirs: string[]): LoadResult {
  const byName = new Map<string, TemplateSpec>();
  const errors: { source: string; error: string }[] = [];
  for (const dir of dirs) {
    for (const file of listTemplateFiles(dir)) {
      try {
        const text = readFileSync(file, "utf8");
        const spec = parseTemplate(text, file);
        byName.set(spec.name, spec); // 后者覆盖（用户目录在后 = 优先）
      } catch (err) {
        errors.push({
          source: file,
          error:
            err instanceof TemplateParseError
              ? err.message
              : `解析失败：${String((err as Error)?.message ?? err)}`,
        });
      }
    }
  }
  const templates = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { templates, errors };
}

/** 双源加载：随包目录（低）+ 用户目录（高，可覆盖 / 新增）。 */
export function loadDefaultTemplates(
  config: { dirs?: string[]; userDir?: string },
  bundled = bundledTemplatesDir(),
  env: NodeJS.ProcessEnv = process.env,
): LoadResult {
  const dirs = [...resolveDirs(config.dirs, bundled)];
  const userDir = config.userDir ?? defaultUserDir(env);
  if (userDir !== "" && !dirs.includes(userDir)) dirs.push(userDir);
  return loadTemplates(dirs);
}
