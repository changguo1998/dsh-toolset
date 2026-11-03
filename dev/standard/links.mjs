// dev/standard/links.mjs — 相对链接与锚点解析

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { headings } from "./markdown.mjs";

/** 链接目标分类: `http(s)` / `mailto` 为外部，`#x` 为本文锚点，其余按文件解析。 */
export function classifyLink(target) {
  if (/^(?:https?|mailto):/i.test(target)) return "external";
  if (target.startsWith("#")) return "anchor";
  return "file";
}

/** 解析相对链接为绝对路径与锚点。 */
export function resolveLink(root, fromFile, target) {
  const hash = target.indexOf("#");
  const pathPart = hash >= 0 ? target.slice(0, hash) : target;
  const anchor =
    hash >= 0 ? decodeURIComponent(target.slice(hash + 1)) : undefined;
  const absolute = pathPart.startsWith("/")
    ? join(root, pathPart)
    : resolve(dirname(fromFile), pathPart);
  return {
    absolute,
    anchor,
    insideRepo: !relative(root, absolute).startsWith(".."),
  };
}

/** 目标文件（或目录）是否存在。 */
export function targetExists(absolute) {
  if (!existsSync(absolute)) return false;
  return true;
}

/** 锚点是否存在: `#l12` 这类行锚点不查，其余按标题 slug 比对。 */
export function anchorExists(absolute, anchor) {
  if (anchor === undefined || anchor === "") return true;
  if (/^l\d+$/.test(anchor)) return true;
  if (!statSync(absolute).isFile()) return false;
  const text = readFileSync(absolute, "utf8");
  const slugs = new Set(headings(text).map(slugify));
  return slugs.has(anchor) || slugs.has(anchor.replace(/^user-content-/, ""));
}

/** GitHub 风格 slug: 小写、去标点、空白转 `-`，保留中日韩与字母数字。 */
export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}
