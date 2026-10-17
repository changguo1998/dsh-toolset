/**
 * 宿主会话目录编码的忠实复刻（只算路径，不落盘、不探测目录）。
 *
 * 为什么是复制：宿主把会话目录建成 `<sessionsRoot>/<projectKey(cwd)>/<encodeSegment(id)>/`，
 * 但编码函数**不对外导出** —— `@deepseek-ai/dsh-session-persistence-jsonl` 只导出
 * `JsonlCompressionSchema` 与默认类，`dsh-session` / `dsh-session-persistence` 也没有面向
 * 插件的目录读取面。故按仓内既有的「约定自足小函数复制 + 注释标注出处」口径复制一份。
 *
 * 出处（只读参考；宿主升级后按行号复核编码是否有漂移，属另一次任务）：
 * `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`
 *   - `encodeSegment` :853-865
 *   - `projectKey`    :875-894
 *   - `projectDir`    :902-905
 *   - `sessionDir`    :912-914
 *
 * 复刻口径：逐字符等价，含三处**宿主有意保留的有损**行为 ——
 * 1. `projectKey` 把 `/` `\` `:` 归一为 `-`，且连续分隔符只留一个；
 * 2. 非 `[A-Za-z0-9._-]` 的字符（含 `~` 本身）转成 `~XXXX`（4 位大写十六进制码位）；
 *    按 UTF-16 码位（`charCodeAt`）逐个转义，故孤立代理项也能原样还原；
 * 3. `projectKey` 的正文截断到 251 字符（`--<正文>--` 外壳之外，总长上限 255）。
 * 入参为空串时与宿主同语义抛错（空会话 id / 空 cwd）。
 */

import { join } from "node:path";

/** 安全字符白名单（与宿主正则逐字相同）。 */
const SAFE_CHAR = /^[A-Za-z0-9._-]$/;

/**
 * 把一个任意字符串编码成单个安全路径段（对全部 JS 字符串单射）。
 *
 * 安全码元原样保留，其余（含 `~`）转成 `~XXXX`；`.` 与 `..` 特判，
 * 避免「本来安全的整段」变成路径穿越。空串按宿主同语义抛错。
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    // 宿主的 `ch !== "~"` 判据在正则里是冗余的（`~` 不在字符类内），照抄以保持逐字对应。
    if (ch !== "~" && SAFE_CHAR.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/**
 * 由项目路径（会话 `header.cwd`）算出人类可读的桶名：`--<正文>--`。
 *
 * 分隔符与盘符变成 `-`（连续出现只留一个），不安全码元用与 `encodeSegment` 相同的
 * `~XXXX` 转义，正文去掉前导 `-`（空则 `root`）后截断到 251 字符。空串抛错。
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && SAFE_CHAR.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** 项目桶目录：`cwd` 缺失（`undefined`）走宿主的 `_no-cwd` 桶，其余走 `projectKey`。 */
export function projectDir(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return join(root, "_no-cwd");
  return join(root, projectKey(cwd));
}

/** 单会话目录：`<projectDir>/<encodeSegment(sessionId)>`。 */
export function sessionDir(
  root: string,
  cwd: string | undefined,
  sessionId: string,
): string {
  return join(projectDir(root, cwd), encodeSegment(sessionId));
}
