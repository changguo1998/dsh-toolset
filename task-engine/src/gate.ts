// task-engine/src/gate.ts — 分解双重校验门禁：粒度四规则 + coverage 映射（机械部分）
//
// 对齐 docs/host/AGENT-ARCHITECTURE-ANALOGY.md §10 与 §17.2 第一道门：
// 越级 / 过粗 / 过细 / 数量 四规则，加 coverage 完备性 + 前置传递（机械拒绝，带反馈打回）。
// 语义蕴含（合取是否真蕴含父 Q）属第二道门，在 engine.decompose 内经 entail hook 裁决。

import type {
  Acceptance,
  ChildSpec,
  Enumeration,
  ExecutorKind,
  Frame,
  FrameId,
} from "./types.ts";

export interface GateConfig {
  /**
   * 子任务数阈值（默认 8）：**数量本身不设上限**，超过阈值时必须声明枚举来源
   * （`Enumeration` + 每个子任务的 `enumItem`），按「条目数 = 子任务数、双向一一对应」校验。
   */
  enumerationThreshold: number;
  /** 打回重试上限（默认 8，§15.2 bounded retry；插件 config `maxRetries` 可覆盖） */
  maxRetries: number;
  /** fan-out 并发上限：active 帧数 >= 此数时不再弹栈（BACKLOG #13，默认 4） */
  maxConcurrent: number;
}

export const DEFAULT_GATE: GateConfig = {
  enumerationThreshold: 8,
  maxRetries: 8,
  maxConcurrent: 4,
};

export type GateRule =
  | "overshoot"
  | "too-coarse"
  | "too-fine"
  | "too-many"
  | "enumeration"
  | "coverage"
  | "deps"
  | "executor"
  | "isolate-id";

/** 合法 executor 后端（BACKLOG「task-engine 执行扩展」①） */
export const EXECUTOR_KINDS: readonly ExecutorKind[] = [
  "model",
  "subagent",
  "workflow",
  "command",
];

/**
 * executor 声明校验（机械门禁的一环）：kind 白名单 + 各 kind 必填字段。
 * 返回 null = 合法；否则返回可读原因（原样进打回反馈）。
 */
export function validateExecutor(spec: unknown): string | null {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return "executor 必须是对象";
  }
  const o = spec as Record<string, unknown>;
  const kind = o["kind"];
  if (
    typeof kind !== "string" ||
    !EXECUTOR_KINDS.includes(kind as ExecutorKind)
  ) {
    return `kind 必须是 ${EXECUTOR_KINDS.join(" / ")} 之一`;
  }
  const nonEmpty = (v: unknown): boolean =>
    typeof v === "string" && v.trim().length > 0;
  if (kind === "command" && !nonEmpty(o["command"])) {
    return "command 后端必须给 command（经 /bin/sh -c 执行）";
  }
  if (kind === "workflow" && !nonEmpty(o["script"])) {
    return "workflow 后端必须给 script（引擎不替模型生成脚本）";
  }
  if (o["model"] !== undefined) {
    const m = o["model"] as Record<string, unknown> | null;
    if (
      typeof m !== "object" ||
      m === null ||
      !nonEmpty(m["provider"]) ||
      !nonEmpty(m["model"])
    ) {
      return "model 覆盖需同时给 provider 与 model（非空字符串）";
    }
  }
  if (o["budget"] !== undefined) {
    const b = o["budget"] as Record<string, unknown> | null;
    if (typeof b !== "object" || b === null || Array.isArray(b)) {
      return "budget 必须是对象";
    }
    const max = b["maxTokens"];
    if (
      max !== undefined &&
      !(typeof max === "number" && Number.isFinite(max) && max > 0)
    ) {
      return "budget.maxTokens 必须是正数";
    }
  }
  if (o["cwd"] !== undefined && !nonEmpty(o["cwd"])) {
    return "cwd 必须是非空字符串";
  }
  // 隔离声明（executor 隔离落地）：只认 worktree + 只对 command 后端生效 + 必须给 cwd。
  // 声明期就挡（否则帧已挂树、模型改不了声明，只能拿到执行期的死结）——宿主 subagent /
  // workflow 面没有 cwd 参数，隔离无处落地，故宁可报错也不「假装隔离」。
  if (o["isolate"] !== undefined) {
    if (o["isolate"] !== "worktree") {
      return 'isolate 目前只支持 "worktree"';
    }
    if (kind !== "command") {
      return `isolate:"worktree" 只对 command 后端生效（宿主 ${kind} 面没有 cwd 参数）：请改用 command 后端，或去掉 isolate`;
    }
    if (!nonEmpty(o["cwd"])) {
      return 'isolate:"worktree" 必须同时声明 cwd（隔离仓库内的起点目录：引擎在它下面跑 git rev-parse --show-toplevel，不猜 process.cwd()）';
    }
  }
  if (o["prompt"] !== undefined && !nonEmpty(o["prompt"])) {
    return "prompt 必须是非空字符串";
  }
  if (
    o["meta"] !== undefined &&
    (typeof o["meta"] !== "object" ||
      o["meta"] === null ||
      Array.isArray(o["meta"]))
  ) {
    return "meta 必须是对象";
  }
  if (typeof o["meta"] === "object" && o["meta"] !== null) {
    // workflow 的 META_INVALID 前移到门禁：显式给出的 name / description 非法在这里就拒绝
    // （缺失不算错——引擎在发起时补默认值，见 executor.ts 的默认 meta 生成）
    const meta = o["meta"] as Record<string, unknown>;
    if (meta["name"] !== undefined && !nonEmpty(meta["name"])) {
      return "meta.name 必须是非空字符串";
    }
    if (meta["description"] !== undefined && !nonEmpty(meta["description"])) {
      return "meta.description 必须是非空字符串";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 隔离 id 规则（executor 隔离落地）
//
// 为什么需要：隔离工作区的**目录名 / 分支名**由 leafId 派生，并原样出现在 git 命令文本里；
// 而 security-guard 的复查面正是**命令文本**（命令黑名单层 + 命令内路径的敏感文件层）——
// 于是 leafId 含「提权 / 磁盘 / 关机类危险词」或形似敏感文件名时，建与回收隔离区的 git 命令
// 都会被拦（连回收命令一起被拦）。这类 id 在**声明期**拒绝，比让模型在执行期撞回执好收敛
// （改 id 即可）；`source` 串只是回执首行的来源标注，不参与判定，不能当缓解措施。
//
// 词表是 security-guard 默认规则集的**最小投影**（本包不 import 对方代码、不进 inject，
// 跨包零硬依赖）：只投影「会命中**命令文本里的 id 片段**」的那些形状。危险词按仓库惯例
// **分片拼接**（仓库内不出现真实危险词字面量）。
// ---------------------------------------------------------------------------

/** 危险词（分片拼接）：提权 / 文件系统格式化 / 清签名 / 关机断电类。 */
const BANNED_ID_WORDS: readonly string[] = [
  "su" + "do",
  "mk" + "fs",
  "wipe" + "fs",
  "shut" + "down",
  "re" + "boot",
  "ha" + "lt",
  "power" + "off",
];

/** 敏感文件名形状（凭据 / 私钥 / env 类；`id_` 家族用交替写法，整词不连续落盘）。 */
const SENSITIVE_ID_SHAPES: readonly RegExp[] = [
  /^\.(?:netrc|git-credentials|npmrc|pypirc)$/,
  /^\.(?:env)(?:\..*)?$/,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/,
  /^id_(?:rsa|ed25519|ecdsa|dsa)$/,
  /^(?:credentials\.json|service-account.*\.json)$/,
];

/** 危险词命中（词边界口径与 security-guard 的 `\b` 一致）；返回命中的词，未命中返回 null。 */
function bannedWordHit(text: string): string | null {
  for (const word of BANNED_ID_WORDS) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return word;
  }
  return null;
}

/**
 * 隔离 id 复查（声明期门禁与执行期兜底共用）：返回 null = 放行；非空 = 可读原因
 * （原样进打回反馈，文案含「改 id」指引）。只对声明了 `isolate` 的叶子生效。
 */
export function validateIsolateId(frameId: string): string | null {
  const word = bannedWordHit(frameId);
  if (word !== null) {
    return (
      `叶任务 id ${JSON.stringify(frameId)} 含危险词「${word}」：隔离工作区的目录名 / 分支名会写进 git 命令文本，` +
      "会命中 security-guard 黑名单（建与回收都会被拦）——请改用不含危险词的 id（语义化英文或编号）。"
    );
  }
  for (const shape of SENSITIVE_ID_SHAPES) {
    if (shape.test(frameId)) {
      return (
        `叶任务 id ${JSON.stringify(frameId)} 形似敏感文件名（凭据 / 私钥 / env 类）：` +
        "隔离路径会命中 security-guard 敏感文件层——请改用不形似凭据文件的 id。"
      );
    }
  }
  return null;
}

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
  enumeration?: Enumeration,
): GateResult {
  // 数量：0 条拒绝；超过阈值时不再卡数量，改为校验「确是清单枚举」
  if (children.length === 0) {
    return {
      ok: false,
      rule: "too-many",
      feedback: "decompose 不能拆出 0 个子任务：请给出至少 1 个子任务。",
    };
  }
  if (children.length > cfg.enumerationThreshold) {
    const bad = checkEnumeration(
      children,
      enumeration,
      cfg.enumerationThreshold,
    );
    if (bad !== null) return { ok: false, rule: "enumeration", feedback: bad };
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
    // executor 声明（①）：只允许叶子声明，且各 kind 的必填字段齐备（机械拒绝带反馈）
    if (c.executor !== undefined) {
      if (c.needDecompose) {
        return {
          ok: false,
          rule: "executor",
          feedback: `子任务「${c.title}」非叶子却声明了 executor：执行后端只能声明在叶子上（它还会被继续拆）。`,
        };
      }
      const bad = validateExecutor(c.executor);
      if (bad !== null) {
        return {
          ok: false,
          rule: "executor",
          feedback: `子任务「${c.title}」的 executor 非法：${bad}。`,
        };
      }
      // 隔离 id 规则（见上）：隔离目录名 / 分支名派生自 id，危险词与敏感形状在声明期就挡住
      if (c.executor.isolate !== undefined) {
        const badId = validateIsolateId(c.id);
        if (badId !== null) {
          return { ok: false, rule: "isolate-id", feedback: badId };
        }
      }
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

/**
 * 超阈值时的枚举校验（2026-11-04）：来源说明非空、条目数 = 子任务数、双向一一对应
 * （无漏项 / 无重复 / 无多余），不满足即返回带反馈的拒绝理由。
 */
function checkEnumeration(
  children: ChildSpec[],
  enumeration: Enumeration | undefined,
  threshold: number,
): string | null {
  const head = `子任务数量 ${children.length} 超过枚举阈值 ${threshold}：`;
  if (enumeration === undefined) {
    return (
      `${head}数量本身不设上限，但超阈值必须是清单逐条枚举而来——请带 ` +
      "enumeration（source + 逐条 items），并给每个子任务填 enum_item；" +
      "若只是把一个任务切碎，请合并或再抽象一层。"
    );
  }
  const source = enumeration.source.trim();
  if (source === "") {
    return `${head}enumeration.source 不能为空：请写明这份清单从哪来（如「BACKLOG 未完成项」）。`;
  }
  const items = enumeration.items.map((x) => x.trim());
  if (items.length !== children.length) {
    return `${head}enumeration.items ${items.length} 条与子任务 ${children.length} 个不一致：清单条目与子任务必须一一对应。`;
  }
  const blank = items.findIndex((x) => x === "");
  if (blank >= 0) {
    return `${head}enumeration.items 第 ${blank + 1} 条为空：请逐条填写清单条目。`;
  }
  const itemSet = new Set(items);
  if (itemSet.size !== items.length) {
    return `${head}enumeration.items 有重复条目：每条清单条目只能对应一个子任务。`;
  }
  const used = new Set<string>();
  for (const c of children) {
    const raw = (c.enumItem ?? "").trim();
    if (raw === "") {
      return `${head}子任务「${c.title}」缺 enum_item：请填它对应的清单条目。`;
    }
    if (!itemSet.has(raw)) {
      return `${head}子任务「${c.title}」的 enum_item「${raw}」不在 enumeration.items 里：请逐条对照清单。`;
    }
    if (used.has(raw)) {
      return `${head}清单条目「${raw}」被多个子任务对应：一条目只对应一个子任务。`;
    }
    used.add(raw);
  }
  const unmatched = items.filter((x) => !used.has(x));
  if (unmatched.length > 0) {
    return `${head}清单条目「${unmatched[0] ?? ""}」没有对应的子任务：请补上子任务或从 items 去掉。`;
  }
  return null;
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
