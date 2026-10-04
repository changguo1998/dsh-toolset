// src/main.ts — cordis 入口：加载双源模板 → 注册宿主命令 → 执行模板（步骤落到宿主面）。
//
// 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, provide, Config, apply }）：
// - `inject: ["commands"]`：命令注册面（缺失则告警，不使加载失败）；
// - `provide: ["commandTemplate"]`：只读查询面（list / get / errors / reload）；
// - `apply(ctx, config)`：扫描模板目录并注册命令（统一入口 `/playbook`，子命令 list / show / reload / <模板>）。
//
// 执行机制全部外包：`prompt` 步骤经 `invocation.agent.followup` 注入当前会话；
// `agent` 步骤经宿主 `subagents` provider 一次性子代理运行（模型覆盖仅作用于该次运行）。

import { randomUUID } from "node:crypto";
import { describe, readService } from "./host.ts";
import { loadDefaultTemplates, type LoadResult } from "./registry.ts";
import { budgetOrInfinity, runTemplate } from "./steps.ts";
import type {
  CommandTemplateConfig,
  ModelRef,
  StepDeps,
  TemplateSpec,
} from "./types.ts";

export type {
  CommandTemplateConfig,
  ModelRef,
  RunOutcome,
  StepResult,
  StepSpec,
  TemplateSpec,
} from "./types.ts";
export { parseTemplate, TemplateParseError } from "./frontmatter.ts";
export { expand, splitArgs } from "./args.ts";
export { loadDefaultTemplates, loadTemplates } from "./registry.ts";
export { readService } from "./host.ts";
export { budgetOrInfinity, effectiveBudget, runTemplate } from "./steps.ts";

export const name = "command-template";
/** 硬依赖：命令注册面（模板即命令）。 */
export const inject = ["commands"];
/** 提供的服务名（宿主命令 / 插件经 `ctx.get("commandTemplate")` 读取）。 */
export const provide = ["commandTemplate"];

/** 统一入口命令名（预案 = 可复用提示词流程）。 */
export const ENTRY_COMMAND = "playbook";

/** 入口保留子命令（模板不得同名，否则无法调用）。 */
export const ENTRY_SUBCOMMANDS = ["list", "show", "reload"] as const;

/** Config 契约别名（DSH bundle §0 的 `Config`）。 */
export type Config = CommandTemplateConfig;

/** 服务面（`provide`）暴露的方法键清单；新增公开方法时必须同步（D5 教训，测试守卫）。 */
export const SERVICE_FACE_METHODS = [
  "list",
  "get",
  "errors",
  "reload",
] as const;

/**
 * 服务面对象（`provide("commandTemplate", …)` 的实际内容）：键清单必须与
 * `SERVICE_FACE_METHODS` 一致——`tests/template.test.ts` 的守卫用例断言两者相等，
 * 并把每个键回指到 `CommandTemplateService` 的同名方法（方法改名 / 键漂移即红）。
 */
export function serviceFace(service: CommandTemplateService): {
  list: () => unknown;
  get: (templateName: string) => unknown;
  errors: () => unknown;
  reload: () => unknown;
} {
  return {
    list: () => service.list(),
    get: (templateName: string) => service.get(templateName),
    errors: () => service.errors(),
    reload: () => service.reload(),
  };
}

/** 宿主命令面最小形态（结构面访问，不引宿主类型依赖）。 */
interface CommandRuntimeLike {
  register(definition: unknown): () => void;
}

/** 命令调用（宿主 `CommandInvocation` 的最小形态）。 */
interface InvocationLike {
  agent?: {
    session?: { id?: string };
    followup?(message: unknown): void;
  };
  rawInput?: string;
  signal?: AbortSignal;
}

/** 命令结果（宿主 `CommandResult`）。 */
interface CommandResultLike {
  kind: "success" | "error";
  text?: string;
}

/** 结构化宿主 ctx（最小形态；其余服务经 `readService` 受保护读取）。 */
interface BundleHost {
  logger?(ns: string): { info(message: string): void };
  commands?: CommandRuntimeLike;
  provide?: (key: string, value: unknown) => unknown;
  [key: string]: unknown;
}

/** 模板体系服务：加载 / 注册 / 运行 / 查询。 */
export class CommandTemplateService {
  readonly #config: CommandTemplateConfig;
  readonly #ctx: BundleHost;
  readonly #log: (message: string) => void;
  #load: LoadResult = { templates: [], errors: [] };
  #disposers: (() => void)[] = [];

  constructor(ctx: BundleHost, config: CommandTemplateConfig = {}) {
    this.#ctx = ctx;
    this.#config = config;
    this.#log = (message) => {
      try {
        ctx.logger?.(name).info(message);
      } catch {
        process.stderr.write(`[${name}] ${message}\n`);
      }
    };
  }

  /** 读盘（不注册）：双源加载（仓库随包目录 → 用户目录，用户优先）。 */
  load(): LoadResult {
    this.#load = loadDefaultTemplates(this.#config);
    for (const broken of this.#load.errors) {
      this.#log(`模板解析失败（跳过）：${broken.error}`);
    }
    return this.#load;
  }

  /** 注册统一入口命令 `/<预案名>`（子命令：list / show / reload / <模板> [参数]）。 */
  register(): void {
    for (const dispose of this.#disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        this.#log(`撤销旧命令失败：${describe(err)}`);
      }
    }
    const reserved = new Set(this.#reserved());
    for (const template of this.#load.templates) {
      if (reserved.has(template.name)) {
        this.#log(`模板名与子命令保留名冲突（无法调用）：${template.name}`);
      }
    }
    const commands = this.#commands();
    if (commands === undefined) {
      this.#log("commands 未挂载：模板入口不注册（服务面仍可用）");
      return;
    }
    try {
      this.#disposers.push(
        commands.register({
          definitionId: `command-template:${ENTRY_COMMAND}`,
          name: ENTRY_COMMAND,
          description:
            `预案（可复用提示词流程）：${ENTRY_COMMAND} <模板> [参数]；` +
            `管理：${ENTRY_COMMAND} list | show <模板> | reload`,
          input: { hint: `list | show <模板> | reload | <模板> [参数]` },
          handler: (invocation: InvocationLike) => this.#dispatch(invocation),
        }),
      );
      this.#log(
        `已注册入口 /${ENTRY_COMMAND}（模板 ${this.#load.templates.length} 个，` +
          `坏模板 ${this.#load.errors.length} 个）`,
      );
    } catch (err) {
      this.#log(`命令注册失败（${ENTRY_COMMAND}）：${describe(err)}`);
    }
  }

  /** 模板列表（按名升序）。 */
  list(): TemplateSpec[] {
    return [...this.#load.templates];
  }

  /** 按名取模板。 */
  get(templateName: string): TemplateSpec | undefined {
    return this.#load.templates.find((item) => item.name === templateName);
  }

  /** 坏模板清单（路径 + 原因）。 */
  errors(): { source: string; error: string }[] {
    return [...this.#load.errors];
  }

  /** 重新扫描目录（不重启进程即可加载新模板）。 */
  reload(): LoadResult {
    const result = this.load();
    this.register();
    return result;
  }

  /** 运行一个模板（命令 handler 用；不抛，错误转 `kind:"error"`）。 */
  async run(
    templateName: string,
    invocation: InvocationLike,
    rawInputOverride?: string,
  ): Promise<CommandResultLike> {
    // 入口命令（`playbook`）不是模板：交给分派器
    if (templateName === ENTRY_COMMAND) return await this.#dispatch(invocation);
    const template = this.get(templateName);
    if (template === undefined) {
      return {
        kind: "error",
        text: `模板不存在：${templateName}（/${ENTRY_COMMAND} list 查看）`,
      };
    }
    const rawInput = rawInputOverride ?? invocation.rawInput ?? "";
    const outcome = await runTemplate(template, this.#deps(invocation), {
      rawInput,
      ...(this.#config.maxSteps === undefined
        ? {}
        : { maxSteps: this.#config.maxSteps }),
      ...(this.#config.maxBestOf === undefined
        ? {}
        : { maxBestOf: this.#config.maxBestOf }),
      ...(this.#config.stepTimeoutMs === undefined
        ? {}
        : { stepTimeoutMs: this.#config.stepTimeoutMs }),
      ...(this.#config.totalTimeoutMs === undefined
        ? {}
        : { totalTimeoutMs: this.#config.totalTimeoutMs }),
    });
    if (!outcome.ok) {
      return {
        kind: "error",
        text: `模板 ${templateName} 执行失败（${outcome.code ?? "error"}）：${outcome.error ?? outcome.text}`,
      };
    }
    const summary =
      outcome.steps.length > 1
        ? `已完成 ${outcome.steps.length} 步（${outcome.steps.map((s) => s.id).join(" → ")}）`
        : "已完成";
    return { kind: "success", text: `${summary}\n\n${outcome.text}` };
  }

  /** 入口分派：list / show / reload 为管理子命令，其余按模板名 + 参数运行。 */
  async #dispatch(invocation: InvocationLike): Promise<CommandResultLike> {
    const raw = (invocation.rawInput ?? "").trim();
    const first = raw.split(/\s+/, 1)[0] ?? "";
    if (first !== "" && !this.#reserved().includes(first)) {
      const rest = raw.slice(first.length).trim();
      return await this.run(first, invocation, rest);
    }
    return this.#manage(raw === "" ? "list" : raw, invocation);
  }

  /** 管理子命令（list / show <模板> / reload）。 */
  #manage(rawInput: string, invocation: InvocationLike): CommandResultLike {
    const [sub = "list", arg] = rawInput.trim().split(/\s+/, 2);
    if (sub === "reload") {
      const result = this.reload();
      return {
        kind: "success",
        text:
          `已重载：模板 ${result.templates.length} 个，坏模板 ${result.errors.length} 个\n` +
          result.templates.map((t) => `- ${t.name}`).join("\n"),
      };
    }
    if (sub === "show") {
      const template = arg === undefined ? undefined : this.get(arg);
      if (template === undefined) {
        return { kind: "error", text: `模板不存在：${arg ?? "(缺 name)"}` };
      }
      const budget = budgetOrInfinity(this.#config);
      return {
        kind: "success",
        text:
          `# ${template.name}\n${template.description}\n` +
          `source: ${template.source}\n` +
          `model: ${template.model?.model ?? "(会话默认)"}\n` +
          // 预算口径显式化：**实际生效值**（含非正 / 非有限 → 不设预算的归一）+ 来源
          `budget: ${budget === Infinity ? "不设预算（非正 / 非有限）" : `${budget} ms`}` +
          `${
            this.#config.totalTimeoutMs === undefined
              ? "（缺省 = maxSteps × stepTimeoutMs）"
              : "（config.totalTimeoutMs）"
          }\n` +
          `steps:\n` +
          template.steps
            .map(
              (step) =>
                `- ${step.id} [${step.type}]${step.model?.model === undefined ? "" : ` model=${step.model.model}`}` +
                `${step.bestOf === undefined ? "" : ` bestOf=${step.bestOf}`}` +
                `${step.judge === undefined ? "" : " +judge"}`,
            )
            .join("\n"),
      };
    }
    const lines = this.list().map(
      (t) =>
        `- ${ENTRY_COMMAND} ${t.name}${t.inputHint === undefined ? "" : ` <${t.inputHint}>`} — ${t.description}`,
    );
    const broken = this.errors().map((e) => `- ${e.source}：${e.error}`);
    return {
      kind: "success",
      text: [
        `模板 ${lines.length} 个：`,
        ...lines,
        ...(broken.length === 0 ? [] : ["", "坏模板：", ...broken]),
      ].join("\n"),
    };
  }

  /** 保留子命令名（配置缺省 = 内置三件套）。 */
  #reserved(): string[] {
    return this.#config.reservedNames ?? [...ENTRY_SUBCOMMANDS];
  }

  #commands(): CommandRuntimeLike | undefined {
    return (
      this.#ctx.commands ??
      readService<CommandRuntimeLike>(this.#ctx, "commands")
    );
  }

  /** 运行依赖：prompt 注入当前会话；agent 走宿主 subagents 一次性运行。 */
  #deps(invocation: InvocationLike): StepDeps {
    return {
      injectPrompt: (text) => this.#inject(invocation, text),
      runAgent: (prompt, opts) => this.#runAgent(invocation, prompt, opts),
      log: (message) => this.#log(message),
    };
  }

  /** 注入当前会话（宿主 agent 面；命令 handler 不在 append 派发窗口内，可直接调用）。 */
  #inject(invocation: InvocationLike, text: string): boolean {
    const followup = invocation.agent?.followup;
    if (typeof followup !== "function") return false;
    try {
      followup.call(invocation.agent, {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        source: {
          kind: "command-template",
          summary: "command-template 模板步骤",
        },
      });
      return true;
    } catch (err) {
      this.#log(`注入失败：${describe(err)}`);
      return false;
    }
  }

  /** agent 步骤：宿主 subagents 服务面一次性运行（写父会话 catalog + 生命周期事件；模型覆盖仅本次）。 */
  async #runAgent(
    invocation: InvocationLike,
    prompt: string,
    opts: { model?: ModelRef; timeoutMs?: number },
  ): Promise<string> {
    const { runOneShotAgent } = await import("./subagent.ts");
    return await runOneShotAgent({
      ctx: this.#ctx,
      parent: invocation.agent,
      prompt,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
    });
  }
}

/** 构造服务 + 加载 + 注册 + 暴露服务面（宿主按 bundle 契约调用）。 */
export function apply(
  ctx: BundleHost & Record<string, unknown> = {},
  config: CommandTemplateConfig = {},
): void {
  const service = new CommandTemplateService(ctx, config);
  if (config.disabled === true) {
    process.stderr.write(`[${name}] 已禁用（config.disabled）\n`);
    return;
  }
  service.load();
  service.register();
  const provideSvc = ctx.provide;
  if (typeof provideSvc === "function") {
    provideSvc("commandTemplate", serviceFace(service));
  }
}
