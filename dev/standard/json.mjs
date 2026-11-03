// dev/standard/json.mjs — `package.json` 与 `tsconfig.json` 的字段与路径检查

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 读取 JSON 文本；解析失败按一条问题回报。 */
export function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { error: String(error) };
  }
}

/** 由 `dist/src/x.js` / `dist/src/x.d.ts` 反推源文件 `src/x.ts`，避免依赖先构建。 */
function sourceOf(declared) {
  const match = /^(?:\.\/)?dist\/(.+?)(?:\.d)?\.(?:js|ts)$/.exec(declared);
  return match === null ? undefined : `${match[1]}.ts`;
}

/**
 * `package.json` 检查:
 * - `main` 与 `types` 必须配套（同时出现或同时缺席），且两者反推的源文件存在；
 * - `files` 里的每一条路径存在；
 * - `dsh.bundle.patch` 存在。
 */
export function checkPackage(dir, path) {
  const issues = [];
  const parsed = readJson(path);
  if (parsed.error !== undefined)
    return [{ line: 1, message: `JSON 解析失败: ${parsed.error}` }];
  const pkg = parsed.value;
  const add = (field, message) =>
    issues.push({ line: lineOf(path, `"${field}"`), message });

  const hasMain = typeof pkg.main === "string";
  const hasTypes = typeof pkg.types === "string";
  if (hasMain !== hasTypes)
    add(hasMain ? "types" : "main", "`main` 与 `types` 必须配套出现");
  for (const field of ["main", "types"]) {
    const declared = pkg[field];
    if (typeof declared !== "string") continue;
    if (/^(?:\.\/)?dist\//.test(declared)) {
      const source = sourceOf(declared);
      if (source === undefined) add(field, `无法从 \`${declared}\` 反推源文件`);
      else if (!existsSync(join(dir, source)))
        add(field, `\`${declared}\` 对应的源文件 \`${source}\` 不存在`);
    } else if (!existsSync(join(dir, declared))) {
      add(field, `\`${field}\` 指向的 \`${declared}\` 不存在`);
    }
  }

  for (const entry of Array.isArray(pkg.files) ? pkg.files : []) {
    if (typeof entry !== "string") continue;
    if (!existsSync(join(dir, entry)))
      add("files", `\`files\` 里的 \`${entry}\` 不存在`);
  }

  const patch = pkg.dsh?.bundle?.patch;
  if (typeof patch === "string" && !existsSync(join(dir, patch))) {
    add("dsh", `\`dsh.bundle.patch\` 指向的 \`${patch}\` 不存在`);
  }
  return issues;
}

/** 基线编译选项: 34 份 `tsconfig.json` 都已开启，缺项即报。 */
const BASELINE_OPTIONS = [
  "strict",
  "noUncheckedIndexedAccess",
  "rewriteRelativeImportExtensions",
  "verbatimModuleSyntax",
];

/**
 * `tsconfig.json` 检查:
 * - `extends` 指向的文件存在；
 * - `include` / `exclude` / `files` 里的路径存在（含通配符的项不查）；
 * - 基线编译选项齐全。
 */
export function checkTsconfig(dir, path) {
  const issues = [];
  const parsed = readJson(path);
  if (parsed.error !== undefined)
    return [{ line: 1, message: `JSON 解析失败: ${parsed.error}` }];
  const config = parsed.value;
  const add = (key, message) =>
    issues.push({ line: lineOf(path, `"${key}"`), message });

  if (
    typeof config.extends === "string" &&
    !existsSync(join(dir, config.extends))
  ) {
    add("extends", `\`extends\` 指向的 \`${config.extends}\` 不存在`);
  }
  for (const key of ["include", "exclude", "files"]) {
    for (const entry of Array.isArray(config[key]) ? config[key] : []) {
      if (typeof entry !== "string" || entry.includes("*")) continue;
      if (!existsSync(join(dir, entry)))
        add(key, `\`${key}\` 里的 \`${entry}\` 不存在`);
    }
  }
  for (const option of BASELINE_OPTIONS) {
    if (config.compilerOptions?.[option] !== true) {
      add("compilerOptions", `基线选项 \`${option}\` 未开启`);
    }
  }
  return issues;
}

/** 找某个键所在的行号；找不到退回第 1 行。 */
function lineOf(path, needle) {
  if (!existsSync(path)) return 1;
  const lines = readFileSync(path, "utf8").split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  return index < 0 ? 1 : index + 1;
}

/** 目录判断，供 `files` 与路径存在性共用。 */
export function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}
