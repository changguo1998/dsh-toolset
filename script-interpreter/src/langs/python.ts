/**
 * Python 后端（首期唯一启用的语言）。
 *
 * 脚本正文经 **stdin** 交给解释器，因此不往磁盘写临时脚本文件
 * （`read-only` 围栏下也能跑，且不留可执行的临时产物）。
 *
 * `-u` 关闭 stdout/stderr 缓冲：脚本被超时杀死时仍能看到已经产生的输出
 * （管道下 Python 默认 8KB 块缓冲，会把这些输出一起丢掉）。
 * `-` 表示「程序从 stdin 读」。
 */

import type { LangBackend } from "../types.ts";

/** Python 后端。 */
export const pythonBackend: LangBackend = {
  id: "python",
  label: "Python",
  configKey: "pythonPath",
  envVar: "SCRIPT_PY_INTERPRETER",
  candidates: ["python3", "python"],
  absolutePaths: [
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/bin/python",
    "/usr/local/bin/python",
  ],
  args: ["-u", "-"],
  versionArgs: ["--version"],
};
