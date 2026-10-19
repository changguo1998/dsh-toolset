/**
 * Bash 后端：**不参与自动探测**，只有显式写进配置 `languages` 才启用（决策 1）。
 *
 * 理由：官方 `tool-bash` 已完整覆盖命令执行面（沙箱围栏 / 提权审批 / 后台作业 /
 * spill 输出），重复暴露只会分散模型选择；本包的差异化在「按语言探测并切换解释器」，
 * bash 不贡献这一价值。
 *
 * 保留它的原因：极简 profile 没挂官方 bash、或需要本包统一回执口径时，
 * 只需把 `bash` 加进配置 `languages`，工具名与协议都不变。
 *
 * `bash -s` 从 stdin 读脚本，与 Python / Node 后端同一套 stdin 口径。
 */

import type { LangBackend } from "../types.ts";

/** Bash 后端（不参与自动探测，需显式配置）。 */
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
