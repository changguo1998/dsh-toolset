/**
 * Node 后端（参与自动探测：`languages` 未配置时探到即启用）。
 *
 * `node -` 从 **stdin** 读脚本并执行（缺省按 CommonJS 解析），因此不往磁盘写
 * 临时脚本文件，与 Python / Bash 后端同一套 stdin 口径。
 *
 * 不追加额外参数：`--input-type` 只影响 ESM 解析，工作区有 `"type": "module"`
 * 时由 Node 自己按就近的 `package.json` 判定；本包不替调用方选模块系统。
 */

import type { LangBackend } from "../types.ts";

/** Node 后端。 */
export const nodeBackend: LangBackend = {
  id: "node",
  label: "Node",
  configKey: "nodePath",
  envVar: "SCRIPT_NODE_INTERPRETER",
  candidates: ["node"],
  absolutePaths: [
    "/usr/bin/node",
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
  ],
  args: ["-"],
  versionArgs: ["--version"],
};
