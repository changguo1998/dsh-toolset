// src/types.ts — 模板体系的类型面与错误码。
//
// 与实现解耦：模板格式（TemplateSpec）、步骤（StepSpec）、运行结果（RunOutcome）、错误码。
// 执行机制不在本包：步骤执行经注入的依赖（会话注入 / 子代理运行）落到宿主面。

/** 模板 / 步骤级的模型引用（仅作用于该次调用；缺省 = 复用会话当前路由）。 */
export interface ModelRef {
  provider?: string;
  model?: string;
}

/** 裁判步声明（best-of-N 用）。 */
export interface JudgeSpec {
  /** 裁判提示词（可含 `$ARGUMENTS` 与 `{{stepId}}`）。 */
  prompt: string;
  model?: ModelRef;
}

/** 单个步骤。 */
export interface StepSpec {
  /** 步骤 id（模板内唯一；缺省按序号 `step1`…）。 */
  id: string;
  /** `prompt` = 注入当前会话；`agent` = 一次性子代理运行（可覆盖模型）；
   *  front-matter 省略 `type` 时缺省 `agent`。 */
  type: "prompt" | "agent";
  /** 展开前文本（支持 `$ARGUMENTS` / `$1..$9` / `{{stepId}}`）。 */
  prompt: string;
  /** agent 步骤的模型覆盖；缺省取模板级 `model`。 */
  model?: ModelRef;
  /** > 1 时并行跑 N 个候选（再交给 `judge`；无 judge 时取首个成功结果）。 */
  bestOf?: number;
  /** 候选评比（bestOf > 1 时可选）。 */
  judge?: JudgeSpec;
}

/** 一个模板（解析后的运行形态）。 */
export interface TemplateSpec {
  /** 模板名（小写 `[a-z0-9][a-z0-9-]{0,31}`，首字符须字母/数字，不含斜杠；
   *  经 `/playbook <name>` 调用，模板不占独立命令名）。 */
  name: string;
  /** 一行说明（宿主命令目录与补全展示）。 */
  description: string;
  /** 参数提示（`input.hint`）。 */
  inputHint?: string;
  /** 模板级默认模型（agent 步骤继承；仅本次调用）。 */
  model?: ModelRef;
  /** 步骤序列（front-matter 未声明 `steps` 时 = 单个 prompt 步骤）。 */
  steps: StepSpec[];
  /** 模板文件路径（诊断 / `/playbook show` 用）。 */
  source: string;
}

/** 单步运行结果。 */
export interface StepResult {
  id: string;
  type: StepSpec["type"];
  /** 该步产出的文本（prompt 步 = 注入文本；agent 步 = 子代理回答）。 */
  text: string;
  /** bestOf > 1 时的候选数（含失败的候选）。 */
  candidates?: number;
  /** 是否由裁判步选出（bestOf 且有 judge）。 */
  judged?: boolean;
}

/** 一次模板运行结果。 */
export interface RunOutcome {
  ok: boolean;
  /** 最终文本（最后一步产出；失败时为错误说明）。 */
  text: string;
  /** 已完成步骤（失败 / `run_timeout` 时为部分完成）。 */
  steps: StepResult[];
  /** 失败原因（ok = false）。 */
  error?: string;
  /** 稳定错误码（见 `TemplateErrorCode`）。 */
  code?: TemplateErrorCode;
}

/** 稳定错误码（调用方按码分支，不解析文案）。 */
export type TemplateErrorCode =
  | "template_invalid"
  | "template_not_found"
  | "name_conflict"
  | "step_failed"
  | "agent_unavailable"
  | "session_unavailable"
  /** 超出总预算（`totalTimeoutMs` 缺省 = `maxSteps × stepTimeoutMs`）。 */
  | "run_timeout";

/** 插件配置（`cordis.patch.yml` 的 `command-template` 节点）。 */
export interface CommandTemplateConfig {
  /** 模板目录（缺省仓库随包目录 `templates/`，相对包根解析）。 */
  dirs?: string[];
  /** 用户模板目录（缺省 `$DSH_HOME/command-templates`，即 `~/.dsh/command-templates`）。 */
  userDir?: string;
  /** 单次运行的步骤上限（缺省 12）。 */
  maxSteps?: number;
  /** bestOf 上限（缺省 8）。 */
  maxBestOf?: number;
  /** 单个 agent 步骤的超时 ms（缺省 600000）。 */
  stepTimeoutMs?: number;
  /**
   * 一次运行的总预算 ms（只约束 agent 步之和，语义 = agent 步的**启动闸门**；缺省 =
   * `maxSteps × stepTimeoutMs`，随包配置下 = 7200000；非正 / 非有限 = 不设；超限 → `run_timeout`）。
   */
  totalTimeoutMs?: number;
  /** 保留命令名（缺省 = 入口子命令 `list` / `show` / `reload`；入口命令名本身恒保留）。
   *  模板与保留名同名时仍会加载并出现在 `list` 里，但无法经入口调用——只记日志告警。 */
  reservedNames?: string[];
  /** 离线排障：apply 立即返回——不加载模板、不注册命令、不提供 `commandTemplate` 服务面。 */
  disabled?: boolean;
}

/** 模板运行依赖（测试注入替身；缺省由 main.ts 接到宿主面）。 */
export interface StepDeps {
  /** 把展开后的文本注入当前会话（返回是否注入成功）。 */
  injectPrompt(text: string): boolean;
  /** 一次性子代理运行（返回回答文本）；`opts.timeoutMs` 总是给出（= `min(stepTimeoutMs, 剩余预算)`）。 */
  runAgent(
    prompt: string,
    opts: { model?: ModelRef; timeoutMs?: number },
  ): Promise<string>;
  /** 日志（缺省丢弃）。 */
  log?(message: string): void;
}
