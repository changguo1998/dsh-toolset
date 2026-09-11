// src/acceptance.ts — RET 验收路由器（机械/人工/语义三级）
//
// 对齐 AGENT-ARCHITECTURE-ANALOGY.md §17.4：按 acceptance.level 分派：
// mechanical → 命令退出码定性；human → approval 链（fail-closed）；semantic →
// 独立 audit run（宿主侧子代跑/裁判模型，经可注入 audit hook，§16.2 outputSchema
// 结构化裁决）。全部通过才弹栈，任一失败带反馈打回。缺 audit hook 时语义级
// fail-closed（不假通过）。

import type { Acceptance, FrameId } from "./types.ts";

/** 语义级裁决（独立 audit run 的结构化产出；宿主按 outputSchema 校验） */
export interface AuditVerdict {
  pass: boolean;
  /** pass=false 时给模型的反馈 */
  feedback?: string;
  /** 结构化裁决（声明 outputSchema 时必须有；宿主侧校验形状） */
  structured?: unknown;
}

/** 语义级 audit run 入参 */
export interface AuditRequest {
  frame: FrameId;
  check: string;
  /** 被审的实现产出（叶子 implement 结果） */
  result?: string;
  /** 声明的结构化裁决 schema（JSON Schema，宿主校验） */
  outputSchema?: unknown;
}

export type AcceptanceVerdict =
  | { pass: true; structured?: unknown }
  | { pass: false; feedback: string; structured?: unknown };

export interface AcceptanceHooks {
  /** mechanical 级：执行验收命令，返回退出码（0 = 通过） */
  runCommand(cmd: string): Promise<{ code: number; output?: string }>;
  /** human 级：人工审批，返回是否批准（无人应答 fail-closed = false） */
  approve(req: { frame: FrameId; reason: string }): Promise<boolean>;
  /** semantic 级：独立 audit run（宿主侧）。未配置时语义级 fail-closed。 */
  audit?(req: AuditRequest): Promise<AuditVerdict>;
}

const SEMANTIC_NOT_IMPL =
  "semantic 级验收未配置独立 audit run（可注入 audit hook），当前 fail-closed 打回。";

/** 依序裁决一条验收；语义级经 audit hook（缺 hook fail-closed）。 */
export async function judgeAcceptance(
  frameId: FrameId,
  acc: Acceptance,
  hooks: AcceptanceHooks,
  result?: string,
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
      // 独立 audit run：未配置 audit hook 时 fail-closed（不假通过）
      if (typeof hooks.audit !== "function") {
        return { pass: false, feedback: SEMANTIC_NOT_IMPL };
      }
      const v = await hooks.audit({
        frame: frameId,
        check: acc.check,
        result,
        outputSchema: acc.outputSchema,
      });
      if (!v.pass) {
        return {
          pass: false,
          feedback: v.feedback ?? `语义验收「${acc.check}」audit run 未通过。`,
          structured: v.structured,
        };
      }
      // 声明了 outputSchema 却无结构化裁决 → 形状不可信，fail-closed
      if (acc.outputSchema !== undefined && v.structured === undefined) {
        return {
          pass: false,
          feedback: `语义验收「${acc.check}」声明了 outputSchema 但 audit run 未返回结构化裁决（structured）。`,
        };
      }
      return { pass: true, structured: v.structured };
    }
  }
}
