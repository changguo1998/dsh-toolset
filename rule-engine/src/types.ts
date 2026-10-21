/**
 * 规则引擎的类型定义。
 *
 * 语义对齐 rule-engine/README.md：
 * - 规则 = 匹配面（`source`：单节点或节点数组）+ 命中条件（match）+ 动作（action，本期只有 inject）
 *   + 节流 + 直写节点（`directWrite`：命中发生在这些节点时跳过投影去重判断）
 * - 节点表（匹配面，规则与消费者共用）：assistant-text / user-message / tool-call /
 *   tool-result / turn-start / turn-end / step-start / step-end / session-start / compaction。
 *   边界类节点（turn-end / turn-start / step-start / step-end / session-start / compaction）
 *   的 match 可省 = 无条件命中（文本入参为空串）；文本类节点（assistant-text / user-message /
 *   tool-call / tool-result）空条件 = 永不命中。
 * - 规则来源两层：插件配置（config，只读基线）+ 运行时层（工具族增删改，落状态目录）
 */

/** 节点（匹配面）：文本 / 消息 / 工具 / 回合与步的边界 / 压缩。
 *  `tools/pre-execute` 例外：**只供消费者 guard 用**（规则侧不接受，见 rules.ts 的 RULE_SOURCES /
 *  CONSUMER_SOURCES）——它不是会话事件、没有文本载荷，只在宿主执行工具前唤醒消费者。 */
export type RuleSource =
  | "assistant-text"
  | "user-message"
  | "tool-call"
  | "tool-result"
  | "turn-start"
  | "turn-end"
  | "step-start"
  | "step-end"
  | "session-start"
  | "compaction"
  | "tools/pre-execute";

/**
 * 注入送达路径（与宿主 `Agent` 方法同名）：
 * `inject` = 挂到最近 pre-step、不唤醒（`agent.inject`；宿主 rc.2+）；
 * `steer` = 同 next-step 队列 + 唤醒（`agent.steer`：空闲时立刻开新回合）；
 * `followup` = 独立新回合（`agent.followup`，缺省）。
 */
export type RuleDelivery = "inject" | "steer" | "followup";

/** 内置谓词名（纯函数性质判定，无参数）。 */
export type PredicateName =
  /** 恒真：显式表达「无条件命中」（文本类规则想每次都命中时用）。 */
  | "always"
  /** 文本含非 ASCII 字符（含中日韩、全角标点、emoji 等）。 */
  | "has-non-ascii"
  /** 文本含中日韩字符。 */
  | "has-cjk"
  /** 文本含 Markdown 代码围栏（```）。 */
  | "has-code-block"
  /** **本进程内新建、无历史**的会话（`ctx.resumed === false`）；与文本无关。
   *  判定基准是引擎**首次**见到该会话时的宿主状态，会话内稳定（见 README「会话谓词」）。 */
  | "session-fresh"
  /** **从记录恢复 / 重载**的会话（`ctx.resumed === true`，含 fork / 种子继承）；与文本无关。 */
  | "session-resumed";

/** 谓词匹配上下文：文本之外、由调用方（引擎）提供的**会话级**事实。
 *  纯函数调用 / `rule_test` 干跑不传时按 `{ resumed: false }`（= 全新会话）处理。 */
export interface MatchContext {
  /** 本会话是否从记录恢复 / 重载（含 fork 继承）而来：引擎首次见到该会话时判定一次，
   *  此后会话内稳定（宿主 `seq` 是事件日志长度 getter，会随事件增长，不能现读）。 */
  resumed: boolean;
}

/** 命中条件；各档之间是「任一档命中即命中」的或关系（predicates 内部为与关系）。 */
export interface MatchSpec {
  /** 关键词：任一出现即命中（大小写不敏感）。 */
  keywords?: readonly string[];
  /** 正则源串：任一匹配即命中。 */
  regex?: readonly string[];
  /** 正则 flags，缺省 "i"（所有 regex 共用）。 */
  flags?: string;
  /** 内置谓词名：全部满足才命中。 */
  predicates?: readonly PredicateName[];
}

/** 注入动作参数。 */
export interface InjectAction {
  type: "inject";
  /** 注入正文（代替用户发出的那条消息）。 */
  text: string;
  /** 一行摘要（注入消息的 `source.summary` 元数据；`dedupeInRecord` 按此 key 计数）；缺省由正文折叠空白后截断（见 boundSummary）。 */
  summary?: string;
}

/** 一条规则。 */
export interface Rule {
  /** 规则标识（两层合并、节流记账、工具面定位都用它）。 */
  id: string;
  /** 是否启用，缺省 true。 */
  enabled?: boolean;
  /** 匹配面：单个节点，或节点数组（一个规则挂多时机）；缺省 "assistant-text"。
   *  持久化回流时可能是数组形态的 `sources`（见下），两者都给时以 `source` 为准。 */
  source?: RuleSource | readonly RuleSource[];
  /** 匹配面的数组写法（与 `source` 同义；归一化后的规则以此字段存储）。 */
  sources?: readonly RuleSource[];
  /** 注入送达路径，缺省 "followup"（"inject" / "steer" 走宿主 next-step 队列）。 */
  delivery?: RuleDelivery;
  /** 命中条件；缺省（或空对象）时**边界类节点**（turn-start / turn-end / step-start / step-end / session-start / compaction）视为无条件命中，文本类节点视为永不命中。 */
  match?: MatchSpec;
  /** 命中后的动作。 */
  action: InjectAction;
  /** 同一会话内两次命中之间的最小回合间隔，缺省 0。 */
  cooldownTurns?: number;
  /** 同一会话内两次命中之间的最小毫秒间隔，缺省 0（不限制）。 */
  cooldownMs?: number;
  /** 按记录去重，缺省 0（= 无限制）：会话记录（可见投影 + 未消费 inbox）里**最多允许 N 条**本注入。
   *  0 = 不限制；1 = 已有 1 条就跳过（重载会话不重复、被压缩挤出后才补）；
   *  N ≥ 2 = 允许最多 N 条。兼容旧布尔值：true → 1、false → 0。 */
  dedupeInRecord?: number;
  /** 直写节点：命中发生在这些节点时**跳过 `dedupeInRecord` 记录判断**、直接写入
   *  （缺省 `[]` = 所有节点都按记录判断）。不在匹配面内的项会被丢弃并告警。 */
  directWrite?: readonly RuleSource[];
  /** 说明（工具面只读展示）。 */
  description?: string | null;
}

/** 归一化后的规则（缺省值补齐，仍为纯数据，可持久化）。 */
export interface NormalizedRule {
  id: string;
  enabled: boolean;
  /** 匹配面（至少一个节点；字符串入参在归一化时收成数组）。 */
  sources: readonly RuleSource[];
  /** 直写节点（`sources` 的子集；空数组 = 所有节点都按记录去重判断）。 */
  directWrite: readonly RuleSource[];
  delivery: RuleDelivery;
  match: MatchSpec;
  action: InjectAction;
  cooldownTurns: number;
  cooldownMs: number;
  dedupeInRecord: number;
  description: string | null;
}

/** 规则来源层。 */
export type RuleOrigin = "config" | "runtime";

/** 生效规则 = 归一化规则 + 来源层。 */
export interface EffectiveRule {
  rule: NormalizedRule;
  origin: RuleOrigin;
}

/** 运行时层（状态目录持久化的内容）：按 id 覆盖基线 + 记录被删除的基线 id。 */
export interface RuntimeLayer {
  /** 运行时新增或覆盖的规则（纯数据原文，加载时再归一化）。 */
  rules: Rule[];
  /** 运行时删除的基线规则 id。 */
  removed: string[];
}

/** 插件配置（profile cordis.patch.yml 的 config 段；无运行时 schema，宿主原样透传）。 */
export interface Config {
  /** 状态目录；缺省 ~/.dsh/rule-engine（可被 RULE_ENGINE_STATE_DIR 覆盖）。 */
  stateDir?: string;
  /** 配置基线规则。 */
  rules?: readonly Rule[];
  /** 同一会话同一回合最多注入条数，缺省 3。 */
  maxInjectionsPerTurn?: number;
}

/** 会话日志事件的最小形态（结构面访问宿主，不引入宿主类型依赖）。 */
export interface SessionEventLike {
  type: string;
  data?: unknown;
  seq?: number;
  time?: number;
}

/** 宿主 session 对象的最小形态。 */
export interface SessionLike {
  id: string;
}

/** 注入请求（引擎 → 注入器）。 */
export interface InjectionRequest {
  /** 来源标识：规则 id，或消费者 `consumer:<id>`。 */
  sourceId: string;
  sessionId: string;
  /** 送达路径（引擎按规则 / 消费者注册填入）。 */
  delivery: RuleDelivery;
  /** 注入正文。 */
  text: string;
  /** 一行摘要（合并注入时取首段摘要）。 */
  summary: string;
  /** 合并注入的各段摘要（单段时可省略，与 `summary` 相同）。 */
  summaries?: readonly string[];
}

/** 注入器：把一条注入请求送达宿主（真实实现推迟宏任务后 followup；测试用假实现）。 */
export interface Injector {
  inject(request: InjectionRequest): void;
}

/** 插件告警事件（告警总线；`text` = 完整展示行，含 `[rule-engine] ` 前缀）。
 *  消费侧（TUI）按 tone 渲染进活动区；经 provide("ruleEngine") 的 `onNotice` 订阅。 */
export interface NoticeEvent {
  text: string;
  tone: "log" | "warn" | "error";
}

/** 只读清单条目（provide("ruleEngine") 查询面用）。 */
export interface RuleSummary {
  id: string;
  enabled: boolean;
  sources: readonly RuleSource[];
  /** 直写节点（这些节点跳过 `dedupeInRecord` 记录判断）。 */
  directWrite: readonly RuleSource[];
  delivery: RuleDelivery;
  origin: RuleOrigin;
  description: string | null;
  /** 注入正文。 */
  text: string;
  cooldownTurns: number;
  cooldownMs: number;
}

/** 只读判定命中条目（消费者 API evaluate 用；含可直接注入的内容）。 */
export interface RuleHit {
  id: string;
  origin: RuleOrigin;
  source: RuleSource;
  delivery: RuleDelivery;
  description: string | null;
  /** 命中后应注入的正文。 */
  text: string;
  /** 一行摘要（规则未显式给定时由正文派生）。 */
  summary: string;
}

/** 只读判定入参。 */
export interface EvaluateInput {
  text: string;
  /** 匹配面，缺省 assistant-text。 */
  source?: RuleSource;
}

/** 只读判定结果（无副作用：不注入、不记账）。 */
export interface EvaluateResult {
  source: RuleSource;
  /** 命中的启用规则（按生效顺序，含可注入内容）。 */
  matched: RuleHit[];
  /** 该匹配面上未启用的规则 id。 */
  disabled: string[];
}

/** 消费者回调上下文（触发点 = 注册声明的节点）。
 *  继承 `MatchContext`：`ctx` 可直接作为匹配器第三参复用内置谓词口径（含 `session-fresh` / `session-resumed`）。 */
export interface ConsumerContext extends MatchContext {
  sessionId: string;
  /** 来源回合号（未知时沿用最近已知值）。 */
  turn: number;
  /** 该节点的文本载荷（边界类节点为空串）。 */
  text: string;
  /** 实际触发的节点 id。 */
  trigger: RuleSource;
  /** 原始宿主事件（结构面访问，供需要额外字段的消费者使用）。 */
  event?: unknown;
}

/** 消费者反馈（由 rule-engine 统一注入的内容）。 */
export interface ConsumerFeedback {
  /** 要注入的正文。 */
  text: string;
  /** 一行摘要（注入消息的 `source.summary` 元数据，规则侧按此 key 计 `dedupeInRecord`）；缺省由正文折叠截断。 */
  summary?: string;
  /** 置 true = 清空本消费者在本会话的对齐 flag（「这次唤醒不算吞并」）。 */
  reset?: boolean;
}

/** `tools/pre-execute` 的调用上下文（宿主 exec 的结构面子集，不 import 宿主类型）。 */
export interface ToolGuardContext {
  /** 工具名（如 `bash`）。 */
  name: string;
  /** 模型原始参数（对象 / JSON 串原样透传，判定侧自行取字段）。 */
  arguments: unknown;
  /** 宿主调用 id（能取到就传）。 */
  callId?: string;
  /** 会话 id（从 `exec.agent.session.id` 结构面取；取不到时省略）。 */
  sessionId?: string;
  /** 本会话是否从记录恢复 / 重载（引擎按会话级判据补齐；缺省 false）。 */
  resumed?: boolean;
}

/** guard 裁决：`allow` = 明确放行（**不**否决后续消费者的 `deny`）；`deny` = 拒绝并给出理由。
 *  返回 `undefined`（或抛错）= 弃权。 */
export type ToolGuardDecision =
  { kind: "allow" } | { kind: "deny"; reason: string };

/** 消费者注册项：两种形态互斥——会话事件节点的同步 `decide`，或 `tools/pre-execute` 的 `guard`。
 *  `sources` 含 `tools/pre-execute` 时**必须**给 `guard`、**不得**给 `decide`，也不得带注入 / 冷却 /
 *  直写参数（其取值与 `guard` 的登记方式无关，见 `engine.ts#registerConsumer`）。 */
export interface ConsumerRegistration {
  /** 消费者标识（唯一；日志与冷却记账用）。 */
  id: string;
  /** 唤醒时机（节点表）；缺省 `["turn-end"]`（向后兼容）。 */
  sources?: readonly RuleSource[];
  /** 反馈注入路径，缺省 followup。 */
  delivery?: RuleDelivery;
  /** 按记录去重（与规则侧同口径）：投影里最多允许 N 条本反馈，缺省 0 = 无限制。 */
  dedupeInRecord?: number;
  /** 直写节点：在这些节点跳过 `dedupeInRecord` 记录判断、直接写入（须是 `sources` 的子集）。 */
  directWrite?: readonly RuleSource[];
  /** 同一会话两次反馈之间的最小回合间隔，缺省 0。 */
  cooldownTurns?: number;
  /** 同一会话两次反馈之间的最小毫秒间隔，缺省 0（不限制）。 */
  cooldownMs?: number;
  /** 同步决策：返回要注入的内容；null = 跳过本轮。`sources` 不含 `tools/pre-execute` 时**必须**给。 */
  decide?(context: ConsumerContext): ConsumerFeedback | null;
  /** `tools/pre-execute` 裁决（同步或异步均可）：返回 `deny` 拒绝该工具调用，`undefined` = 弃权。 */
  guard?(
    context: ToolGuardContext,
  ): ToolGuardDecision | undefined | Promise<ToolGuardDecision | undefined>;
}

/** 只读状态。 */
export interface EngineStatus {
  /** 生效规则条数。 */
  rules: number;
  /** 其中来自运行时层的条数（含覆盖基线者）。 */
  runtimeRules: number;
  /** 被运行时删除的基线规则条数。 */
  removedBaselineRules: number;
  /** 状态目录。 */
  stateDir: string;
  /** 同一会话同一回合注入上限。 */
  maxInjectionsPerTurn: number;
}

/** rule_test 干跑结果。 */
export interface MatchTestResult {
  /** 判定用的匹配面。 */
  source: RuleSource;
  /** 命中规则 id（按生效顺序）。 */
  matched: string[];
  /** 被跳过（未启用）的规则 id。 */
  disabled: string[];
}
