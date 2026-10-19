/**
 * POSIX sh 后端（参与自动探测：`languages` 未配置时探到即启用）。
 *
 * `sh -s` 从 **stdin** 读脚本，与 bash 后端同形；独立成后端的理由是
 * 覆盖没有 bash 的极简环境（alpine 类镜像 / busybox 容器）。
 *
 * `versionArgs` 留空：`sh` 没有统一的版本开关（dash 对 `--version` 报错、
 * busybox 输出自己的用法），强行探测只会把错误文案当成版本写进日志。
 */

import type { LangBackend } from "../types.ts";

/** POSIX sh 后端。 */
export const shBackend: LangBackend = {
  id: "sh",
  label: "sh",
  configKey: "shPath",
  envVar: "SCRIPT_SH_INTERPRETER",
  candidates: ["sh"],
  absolutePaths: ["/bin/sh", "/usr/bin/sh"],
  args: ["-s"],
  versionArgs: [],
};
