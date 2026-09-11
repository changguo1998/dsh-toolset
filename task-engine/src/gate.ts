// src/gate.ts — 分解双重校验门禁：粒度四规则 + coverage 映射（机械部分）
//
// 对齐 AGENT-ARCHITECTURE-ANALOGY.md §10 与 §17.2 第一道门：
// 越级 / 过粗 / 过细 / 数量 四规则，加 coverage 完备性 + 前置传递（机械拒绝，带反馈打回）。
// 语义蕴含（合取是否真蕴含父 Q）属第二道门，在 engine.decompose 内经 entail hook 裁决。

import type { Acceptance, ChildSpec, Frame, FrameId } from "./types.ts";

export interface GateConfig {
  /** 一次 decompose 的子任务数量上限（默认 7，§10 ③） */
  maxChildren: number;
  /** 打回重试上限（默认 3，§15.2 bounded retry） */
  maxRetries: number;
  /** fan-out 并发上限：active 帧数 >= 此数时不再弹栈（BACKLOG #13，默认 4） */
  maxConcurrent: number;
}

export const DEFAULT_GATE: GateConfig = {
  maxChildren: 7,
  maxRetries: 3,
  maxConcurrent: 4,
};

export type GateRule =
  "overshoot" | "too-coarse" | "too-fine" | "too-many" | "coverage" | "deps";

export interface GateResult {
  ok: boolean;
  /** 命中的规则（ok=false 时有值） */
  rule?: GateRule;
  /** 打回反馈（原样还给模型，带反馈重试） */
  feedback: string;
}

/** 越级启发：子任务 spec 含实现细节/代码形态 → 要求再抽象一层 */
export function hasImplDetail(spec: string): boolean {
  const codeIndicators = [
    /```/,
    /`[A-Za-z_][\w.-]*\(/,
    /import\s+[\w{}*]/,
    /function\s+\w+\s*\(/,
    /\w+\.\w{1,4}\b/,
    /=>/,
  ];
  return codeIndicators.some((re) => re.test(spec));
}

/** 过粗启发：叶子 spec 枚举 ≥2 个独立动作（动词 / 顿号列表） */
export function countsActions(spec: string): number {
  const verbs = [
    "实现",
    "编写",
    "创建",
    "修改",
    "添加",
    "删除",
    "运行",
    "测试",
    "检查",
    "修复",
    "配置",
    "编写文档",
    "部署",
  ];
  let n = 0;
  for (const v of verbs) {
    if (spec.includes(v)) n += 1;
  }
  // 顿号/逗号分隔的多动作提示（如「a、b、c」）
  const listParts = spec.split(/[、，,]/).filter((s) => s.trim().length > 1);
  n = Math.max(n, listParts.length);
  return n;
}

/** 过细启发：叶子 spec 含步骤标记（首先/然后/最后/编号/步骤） */
export function hasStepMarkers(spec: string): boolean {
  const markers = [
    /首先/,
    /然后/,
    /最后/,
    /步骤/,
    /第一步/,
    /第\d+步/,
    /\d+[.、]/,
  ];
  return markers.some((re) => re.test(spec));
}

/**
 * 粒度四规则 + coverage 完备性 + 前置传递。只检验 decompose 提议，不改状态。
 * 拒绝时返回 rule + feedback（带反馈打回）。
 */
export function checkDecomposition(
  parent: Frame,
  children: ChildSpec[],
  cfg: GateConfig = DEFAULT_GATE,
): GateResult {
  // 数量：0 或超上限
  if (children.length === 0) {
    return {
      ok: false,
      rule: "too-many",
      feedback: "decompose 不能拆出 0 个子任务：请给出至少 1 个子任务。",
    };
  }
  if (children.length > cfg.maxChildren) {
    return {
      ok: false,
      rule: "too-many",
      feedback: `子任务数量 ${children.length} 超过上限 ${cfg.maxChildren}：请合并或再抽象一层。`,
    };
  }

  for (const c of children) {
    // 越级：子任务含实现细节
    if (hasImplDetail(c.spec)) {
      return {
        ok: false,
        rule: "overshoot",
        feedback: `子任务「${c.title}」含实现细节/代码，越级了：请再抽象一层，只描述要做的事，不要写怎么做。`,
      };
    }
    if (c.needDecompose) {
      // 非叶子无需再查过粗/过细（它还会被继续拆）
      continue;
    }
    // 叶子：过粗（还能拆出多动作但标记可执行）
    if (countsActions(c.spec) >= 2) {
      return {
        ok: false,
        rule: "too-coarse",
        feedback: `子任务「${c.title}」标记为叶子但含 ${countsActions(c.spec)} 个动作，过粗：请再拆一层，叶子应单动作完成。`,
      };
    }
    // 叶子：过细（单 step 内仍含多步骤）
    if (hasStepMarkers(c.spec)) {
      return {
        ok: false,
        rule: "too-fine",
        feedback: `子任务「${c.title}」标记为叶子但仍含多步骤（首先/然后/编号等），过细：请拆到单 step。`,
      };
    }
  }

  // coverage 完备性：父每条验收都必须有非空子任务覆盖（§17.2 覆盖完备）
  const coverageError = checkCoverage(parent.acceptance, children);
  if (coverageError) return coverageError;

  // 前置传递：deps 只允许引用前序兄弟（§17.2 顺序依赖显式化）
  const depsError = checkDeps(children);
  if (depsError) return depsError;

  return { ok: true, feedback: "decompose 通过门禁" };
}

/** coverage 映射校验：父验收条目 → 覆盖它的子任务 id 集，缺映射/空映射/未知 id 机械拒绝 */
export function checkCoverage(
  parentAcceptance: Acceptance[],
  children: ChildSpec[],
): GateResult | null {
  const childIds = new Set(children.map((c) => c.id));
  for (const a of parentAcceptance) {
    const ids = collectCoverage(a.id, children);
    if (ids.length === 0) {
      return {
        ok: false,
        rule: "coverage",
        feedback: `父验收「${a.check}」没有被任何子任务覆盖：请在每个覆盖它的子任务上声明 coverage 映射（父验收 id → 子任务 id）。`,
      };
    }
    for (const id of ids) {
      if (!childIds.has(id)) {
        return {
          ok: false,
          rule: "coverage",
          feedback: `coverage 映射引用了未知子任务 id「${id}」：请只引用本次 decompose 的子任务。`,
        };
      }
    }
  }
  return null;
}

/** 前置传递校验：deps 只允许引用前序兄弟（自引用/后引用/未知一律拒绝） */
export function checkDeps(children: ChildSpec[]): GateResult | null {
  const seen = new Set<FrameId>();
  for (const c of children) {
    for (const dep of c.deps ?? []) {
      if (dep === c.id) {
        return {
          ok: false,
          rule: "deps",
          feedback: `子任务「${c.id}」deps 引用自身：前置依赖不允许自引用。`,
        };
      }
      if (!seen.has(dep)) {
        return {
          ok: false,
          rule: "deps",
          feedback: `子任务「${c.id}」deps「${dep}」必须引用前序兄弟（当前尚未出现）。`,
        };
      }
    }
    seen.add(c.id);
  }
  return null;
}

/** 收集覆盖某验收条目的子任务 id（任一子任务声明即算覆盖） */
function collectCoverage(
  acceptanceId: string,
  children: ChildSpec[],
): FrameId[] {
  const out: FrameId[] = [];
  for (const c of children) {
    const cov = c.coverage[acceptanceId];
    if (cov && cov.length > 0) out.push(...cov);
  }
  return [...new Set(out)];
}
