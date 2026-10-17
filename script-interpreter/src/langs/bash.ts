/**
 * Bash 后端：**随首期实现但不启用**（决策 2）——官方 `tool-bash` 已完整覆盖 shell 命令面
 * （沙箱围栏 / 提权审批 / 后台作业 / spill 输出），重复暴露只会分散模型选择。
 *
 * 保留它的原因：二期若要一个开关打开（例如极简 profile 没挂官方 bash），
 * 只需把 `bash` 加进配置 `languages`，工具名与协议都不变。
 *
 * `bash -s` 从 stdin 读脚本，与 Python 后端同一套 stdin 口径。
 */

import type { LangBackend } from "../types.ts";

/** Bash 后端（缺省不在启用表内）。 */
export const bashBackend: LangBackend = {
  id: "bash",
  label: "Bash",
  configKey: "bashPath",
  envVar: "SCRIPT_BASH_INTERPRETER",
  candidates: ["bash"],
  absolutePaths: ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"],
  args: ["-s"],
  versionArgs: ["--version"],
};
