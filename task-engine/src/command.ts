// task-engine/src/command.ts — 命令执行：真实链路 /bin/sh -c（mechanical 验收与 command 后端共用）

import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

/** 真实链路 mechanical 验收：/bin/sh -c 执行，退出码 0 = 通过（executor `command` 后端同用） */
export function makeRunCommand(timeoutMs: number) {
  return async (
    cmd: string,
    cwd?: string,
  ): Promise<{ code: number; output?: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", cmd], {
        timeout: timeoutMs,
        ...(cwd === undefined ? {} : { cwd }),
      });
      return { code: 0, output: String(stdout) + String(stderr) };
    } catch (err) {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      const code = typeof e.code === "number" ? e.code : 1;
      return { code, output: String(e.stdout ?? "") + String(e.stderr ?? "") };
    }
  };
}
