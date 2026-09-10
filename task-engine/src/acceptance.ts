// src/acceptance.ts — RET 验收路由器（机械/人工两级；语义级 fail-closed）
//
// 对齐 AGENT-ARCHITECTURE-ANALOGY.md §17.4：按 acceptance.level 分派：
// mechanical → 命令退出码定性；human → approval 链（fail-closed）；semantic →
// 第二迭代实现（fail-closed 打回，不弹栈）。全部通过才弹栈，任一失败带反馈打回。

import type { Acceptance, FrameId } from "./types.ts";

export type AcceptanceVerdict =
  { pass: true } | { pass: false; feedback: string };

export interface AcceptanceHooks {
  /** mechanical 级：执行验收命令，返回退出码（0 = 通过） */
  runCommand(cmd: string): Promise<{ code: number; output?: string }>;
  /** human 级：人工审批，返回是否批准（无人应答 fail-closed = false） */
  approve(req: { frame: FrameId; reason: string }): Promise<boolean>;
}

const SEMANTIC_NOT_IMPL =
  "semantic 级验收在第二迭代实现（独立 audit run + outputSchema），当前 fail-closed 打回。";

/** 依序裁决一条验收；语义级 fail-closed。 */
export async function judgeAcceptance(
  frameId: FrameId,
  acc: Acceptance,
  hooks: AcceptanceHooks,
): Promise<AcceptanceVerdict> {
  switch (acc.level) {
    case "mechanical": {
      if (!acc.command) {
        return {
          pass: false,
          feedback: `验收「${acc.check}」为 mechanical 级但缺 command，无法执行。`,
        };
      }
      const { code, output } = await hooks.runCommand(acc.command);
      if (code === 0) return { pass: true };
      return {
        pass: false,
        feedback: `验收「${acc.check}」命令退出码 ${code}：${(output ?? "")
          .trim()
          .slice(0, 500)}`,
      };
    }
    case "human": {
      const ok = await hooks.approve({
        frame: frameId,
        reason: acc.check,
      });
      if (ok) return { pass: true };
      return {
        pass: false,
        feedback: `人工验收「${acc.check}」未获批准（fail-closed）：拒绝或无人应答。`,
      };
    }
    case "semantic": {
      return { pass: false, feedback: SEMANTIC_NOT_IMPL };
    }
  }
}
