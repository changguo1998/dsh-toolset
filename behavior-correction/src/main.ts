/**
 * behavior-correction 插件入口（DSH bundle 接入面）。
 *
 * 角色：**rule-engine 的 guard 消费者** —— 启动时经 `ctx.get("ruleEngine")` 读取消费者注册面，在
 * 节点 `tools/pre-execute` 上注册 id `behavior-correction`。宿主每次要执行工具前，rule-engine 把
 * `{ name, arguments, callId?, sessionId?, resumed? }` 交给本插件的 `guard`：本包按自身 `config` 的
 * 规则表（工具名 + 参数字符串）判定，命中返回 `{ kind: "deny", reason }`（回执写明该改用哪个专用
 * 工具），未命中返回 `undefined`（弃权，交给其它消费者与宿主继续）。
 *
 * 缺省规则只有一条：`bash` 命令里出现 `herdr` → 拒绝并指向 `herdr_use`。herdr CLI 有专用工具，
 * 走 bash 会绕过插件面板与状态绑定。规则表可在 profile `config` 里整体替换；`rules: []` 或
 * `enabled: false` 等于不拦。
 *
 * 设计取舍：
 * - **写进 `inject`**（2026-10-22 真机修正）：`ruleEngine` 服务由 rule-engine 插件在 apply 时 provide，
 *   本包 insert 在 profile 里更靠前，读 `ctx.get` 会先拿到 undefined（真机实测：插件已加载但从未注册
 *   消费者）；声明 `inject: ["ruleEngine"]` 让 cordis 等到服务就绪再激活。运行期仍保留存在性判断，
 *   服务在但缺 `registerConsumer` 时告警降级；
 * - **匹配器自带**（关键词 / 正则），不复用 rule-engine 的 `compileMatcher`：这里只需要「任一命中」，
 *   自己写约二十行，省掉包间依赖与 profile 安装步骤；
 * - **只做文本判定**：不解释 shell 语义（管道、别名、变量展开、引号都不解析），宁可漏拦也不误伤；
 * - 不写审计、不落 memory-base（需要审计由人工另行决定）；拒绝时的告警由 rule-engine 统一打。
 */

/** bundle 条目 id（与 cordis.patch.yml / profile 层一致）。 */
export const name = "behavior-correction";

/** 硬依赖 `ruleEngine`：注册 guard 消费者必须先有服务（真机修正，见文件头设计取舍）。 */
export const inject: readonly string[] = ["ruleEngine"];

/** 本包唯一使用的消费者节点（宿主执行工具前唤醒消费者）。 */
export const GUARD_SOURCE = "tools/pre-execute";

/** `tools/pre-execute` 的调用上下文（宿主 exec 的结构面子集，与 rule-engine 的同名类型一致）。 */
export interface ToolGuardContext {
  /** 工具名（如 `bash`）。 */
  name: string;
  /** 模型原始参数（对象 / JSON 串原样透传）。 */
  arguments: unknown;
  /** 宿主调用 id（能取到就传）。 */
  callId?: string;
  /** 会话 id（能取到就传）。 */
  sessionId?: string;
  /** 本会话是否从记录恢复 / 重载。 */
  resumed?: boolean;
}

/** guard 裁决（与 rule-engine 的同名类型一致）：`deny` 拒绝该调用，`undefined` = 弃权。 */
export type ToolGuardDecision =
  { kind: "allow" } | { kind: "deny"; reason: string };

/** 一条拦截规则（`config.rules` 的元素）。 */
export interface RuleSpec {
  /** 规则 id（告警与排查用）。 */
  id: string;
  /** 限定工具名；省略 = 任意工具。 */
  tool?: string | readonly string[];
  /** 判定条件：关键词 / 正则任一命中即算命中；都省略 = 该规则永不命中。 */
  match?: {
    /** 关键词（大小写不敏感，子串匹配）。 */
    keywords?: readonly string[];
    /** 正则源串（任一匹配即命中）。 */
    regex?: readonly string[];
    /** 正则 flags，缺省 `"i"`；`g` / `y` 会被去掉，避免 `test` 的状态污染。 */
    flags?: string;
  };
  /** 命中时回给模型的拒绝理由（应写明该改用哪个工具）。 */
  reason: string;
  /** 给人看的说明（不参与判定）。 */
  description?: string;
}

/** 插件配置（类型声明，宿主不校验；缺省见 resolveConfig）。 */
export interface Config {
  /** 是否拦截（缺省 `true`；`false` 时不注册消费者）。 */
  enabled?: boolean;
  /** 规则表：给了就**整体替换**内置规则；`[]` = 不拦任何东西。 */
  rules?: readonly RuleSpec[];
}

/**
 * 内置缺省规则：
 * 1. bash 里跑 herdr CLI → 指路 `herdr_use`；
 * 2. bash 里跑 python → 指路 `script_run`（script-interpreter 插件）。
 */
export const DEFAULT_RULES: readonly RuleSpec[] = [
  {
    id: "no-herdr-in-bash",
    tool: "bash",
    // 只匹配「命令位上的 CLI 调用」：行首 / `;` `&` `|` 之后 / `$( ` 之后，允许前置
    // `VAR=值` 与环境路径前缀；正文里提到该词（提交信息、echo 参数）不再误拦。
    match: {
      regex: [
        "(?:^|[;&|]\\s*|\\$\\(\\s*)\\s*(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:\\S*/)?herdr(?=\\s|$)",
      ],
      flags: "im",
    },
    reason:
      "bash 里不要跑 herdr 命令: 改用 herdr_use 工具（pane_* / tab_* 操作）",
    description: "herdr CLI 有专用工具，走 bash 会绕过插件面板与状态绑定",
  },
  {
    id: "no-python-in-bash",
    tool: "bash",
    // 同一套命令位判定：行首 / `;` `&` `|` 之后 / `$( ` 之后，允许前置 `VAR=值` 与路径；
    // 认 `python` / `python3` / `python3.12`；`echo python`、`.py` 扩展名、`pip` 都不拦。
    match: {
      regex: [
        "(?:^|[;&|]\\s*|\\$\\(\\s*)\\s*(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:\\S*/)?python(?:3(?:\\.\\d+)?)?(?=\\s|$)",
      ],
      flags: "im",
    },
    reason:
      "bash 里不要跑 python: 改用 script_run 工具（script-interpreter 插件）执行 Python 脚本或语句",
    description:
      "Python 走 script_run 才受插件管控（工作目录、超时、输出上限）；bash 直跑会绕过这层",
  },
];

/** 归一化后的配置。 */
export interface ResolvedConfig {
  enabled: boolean;
  rules: readonly RuleSpec[];
}

/** 归一化配置（纯函数，不告警、不抛错；非法条目与非法正则在 compileRules 里丢弃并告警）。 */
export function resolveConfig(config?: Config): ResolvedConfig {
  return {
    enabled: config?.enabled !== false,
    rules: Array.isArray(config?.rules) ? config.rules : DEFAULT_RULES,
  };
}

/** 编译后的规则（内部形态：正则已编译、关键词已小写）。 */
export interface CompiledRule {
  readonly reason: string;
  readonly tools?: readonly string[];
  readonly keywords: readonly string[];
  readonly regexes: readonly RegExp[];
}

/** 编译规则表：逐条校验，丢弃非法条目与非法正则（各告警一行），其余照常。 */
export function compileRules(
  config: Config | undefined,
  warn: (message: string) => void,
): { enabled: boolean; rules: CompiledRule[] } {
  if (config?.rules !== undefined && !Array.isArray(config.rules)) {
    warn("config.rules 不是数组，已回退内置规则表");
  }
  const resolved = resolveConfig(config);
  const rules: CompiledRule[] = [];
  for (const [index, spec] of resolved.rules.entries()) {
    const rule = compileRule(spec, index, warn);
    if (rule !== undefined) rules.push(rule);
  }
  return { enabled: resolved.enabled, rules };
}

/**
 * 单条规则编译：`reason` / `tool` / `match` 形态不合法或正则编译失败时整条跳过（返回 undefined
 * 并告警），不影响其它规则；合法但没有任何匹配条件时同样保留 —— 它在 matchRule 里永不命中。
 */
function compileRule(
  spec: unknown,
  index: number,
  warn: (message: string) => void,
): CompiledRule | undefined {
  if (spec === null || typeof spec !== "object") {
    warn(`第 ${index + 1} 条规则不是对象，已跳过`);
    return undefined;
  }
  const record = spec as Partial<RuleSpec>;
  const label =
    typeof record.id === "string" && record.id.length > 0
      ? record.id
      : `#${index + 1}`;
  if (typeof record.reason !== "string" || record.reason.length === 0) {
    warn(`规则 ${label} 缺少 reason，已跳过`);
    return undefined;
  }
  const tools = normalizeTools(record.tool);
  if (record.tool !== undefined && tools === undefined) {
    warn(`规则 ${label} 的 tool 不是字符串或字符串数组，已跳过`);
    return undefined;
  }
  const match = record.match;
  if (match !== undefined && (match === null || typeof match !== "object")) {
    warn(`规则 ${label} 的 match 不是对象，已跳过`);
    return undefined;
  }
  const keywords = readStringList(match?.keywords);
  if (keywords === undefined) {
    warn(`规则 ${label} 的 match.keywords 不是字符串数组，已跳过`);
    return undefined;
  }
  const patterns = readStringList(match?.regex);
  if (patterns === undefined) {
    warn(`规则 ${label} 的 match.regex 不是字符串数组，已跳过`);
    return undefined;
  }
  const flags =
    typeof match?.flags === "string" ? match.flags.replace(/[gy]/g, "") : "i";
  const regexes: RegExp[] = [];
  for (const source of patterns) {
    try {
      regexes.push(new RegExp(source, flags));
    } catch (error) {
      warn(
        `规则 ${label} 的正则 ${JSON.stringify(source)} 无效，整条规则跳过：${String(error)}`,
      );
      return undefined;
    }
  }
  return {
    reason: record.reason,
    ...(tools === undefined ? {} : { tools }),
    keywords: keywords.map((keyword) => keyword.toLowerCase()),
    regexes,
  };
}

/** `tool` 归一化：字符串或字符串数组 → 非空字符串列表；缺席 / 非法 → undefined。 */
function normalizeTools(tool: unknown): readonly string[] | undefined {
  if (typeof tool === "string" && tool.length > 0) return [tool];
  if (Array.isArray(tool)) {
    const list = tool.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    if (list.length > 0) return list;
  }
  return undefined;
}

/** 字符串列表归一化：缺席 → 空列表；不是数组 / 非空数组里没有合法字符串 → undefined。 */
function readStringList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const list = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return value.length > 0 && list.length === 0 ? undefined : list;
}

/**
 * 判定文本：`bash` / `pwsh` 取 `arguments.command` 原文（**不带工具名前缀**，便于规则用 `^` 锚命令位），
 * 其余工具用「工具名 + `JSON.stringify(arguments)`」；序列化失败（循环引用等）按空串处理。
 */
export function toolText(context: ToolGuardContext): string {
  const toolName = typeof context?.name === "string" ? context.name : "";
  const args = context?.arguments;
  const record =
    args !== null && typeof args === "object"
      ? (args as Record<string, unknown>)
      : undefined;
  if (toolName === "bash" || toolName === "pwsh") {
    const command = record?.["command"];
    if (typeof command === "string") return command;
  }
  return `${toolName} ${serialize(args)}`;
}

/** 参数序列化（失败返回空串，绝不抛错）。 */
function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * 按声明顺序取**第一条**命中的规则：先看 `tool` 限定，再看关键词（对全小写文本做子串匹配），
 * 最后看正则（对原始文本判定，flags 缺省 `i`）。判定的都是 `toolText` 产出的文本。未命中返回 undefined。
 */
export function matchRule(
  rules: readonly CompiledRule[],
  context: ToolGuardContext,
): CompiledRule | undefined {
  const text = toolText(context);
  const lower = text.toLowerCase();
  const toolName = typeof context?.name === "string" ? context.name : "";
  for (const rule of rules) {
    if (rule.tools !== undefined && !rule.tools.includes(toolName)) continue;
    if (rule.keywords.some((keyword) => lower.includes(keyword))) return rule;
    if (rule.regexes.some((pattern) => pattern.test(text))) return rule;
  }
  return undefined;
}

/** rule-engine 消费者注册面（结构化类型，不 import 对方代码）。 */
interface ConsumerRegistrar {
  registerConsumer(input: {
    id: string;
    sources: readonly string[];
    guard: (context: ToolGuardContext) => ToolGuardDecision | undefined;
  }): () => void;
}

/** 插件上下文的结构化面（`ctx.ruleEngine` / `ctx.get('ruleEngine')` / `ctx.on`）。 */
interface PluginContext {
  ruleEngine?: ConsumerRegistrar;
  get?: (service: string) => unknown;
  on?: (event: string, listener: () => void) => unknown;
}

/**
 * 挂载：把自身注册为 rule-engine 的 `tools/pre-execute` guard 消费者。
 * 返回注销函数（幂等）；`ctx.on("dispose")` 可用时同时挂到插件卸载上。服务缺席 / 注册被拒 →
 * 告警一行并静默降级（本包不因此让宿主启动失败）。
 */
export function apply(ctx: unknown, config?: Config): () => void {
  const warn = (message: string): void => {
    process.stderr.write(`[behavior-correction] warn: ${message}\n`);
  };
  const noop = (): void => {};
  const { enabled, rules } = compileRules(config, warn);
  if (!enabled) return noop;

  const c = (ctx ?? {}) as PluginContext;
  const engine = readEngine(c);
  if (engine === undefined) {
    warn(
      "ctx.ruleEngine 不可用，工具拦截不会触发（请检查 rule-engine 是否挂载）",
    );
    return noop;
  }

  let unregister: (() => void) | undefined;
  try {
    unregister = engine.registerConsumer({
      id: name,
      sources: [GUARD_SOURCE],
      guard: (context) => {
        const hit = matchRule(rules, context);
        return hit === undefined
          ? undefined
          : { kind: "deny", reason: hit.reason };
      },
    });
  } catch (error) {
    warn(`注册 guard 消费者失败：${String(error)}`);
    return noop;
  }

  const dispose = once(typeof unregister === "function" ? unregister : noop);
  if (typeof c.on === "function") {
    try {
      c.on("dispose", dispose);
    } catch (error) {
      warn(
        `ctx.on("dispose") 订阅失败，改由宿主生命周期卸载：${String(error)}`,
      );
    }
  }
  return dispose;
}

/** 读消费者注册面：先看直接属性（严格模式下未注入服务直读会抛，按缺席处理），再走 `ctx.get`。 */
function readEngine(c: PluginContext): ConsumerRegistrar | undefined {
  let direct: ConsumerRegistrar | undefined;
  try {
    direct = c.ruleEngine;
  } catch {
    direct = undefined;
  }
  if (direct !== undefined && typeof direct.registerConsumer === "function") {
    return direct;
  }
  if (typeof c.get !== "function") return undefined;
  try {
    const viaGet = c.get("ruleEngine") as ConsumerRegistrar | undefined;
    if (viaGet !== undefined && typeof viaGet.registerConsumer === "function") {
      return viaGet;
    }
  } catch {
    // 服务读取本身抛错（宿主严格模式 / 服务未就绪）：按缺席处理
  }
  return undefined;
}

/** 包一层「只执行一次」（注销函数被 dispose 事件与返回值同时触碰时不重复调用）。 */
function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
