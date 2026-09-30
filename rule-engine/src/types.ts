/**
 * 规则引擎的类型定义。
 *
 * 语义对齐 rule-engine/README.md：
 * - 规则 = 匹配面（source）+ 命中条件（match）+ 动作（action，本期只有 inject）+ 节流
 * - 匹配面三类：模型正文文本（assistant-text，回合结束时对整回合正文判定）、
 *   工具调用与结果（tool-call / tool-result，事件到达即判定）、回合边界（turn-end，
 *   match 可省 = 无条件命中）
 * - 规则来源两层：插件配置（config，只读基线）+ 运行时层（工具族增删改，落状态目录）
 */

/** 匹配面：文本 / 工具调用 / 工具结果 / 回合边界。 */
export type RuleSource =
  "assistant-text" | "tool-call" | "tool-result" | "turn-end";

/** 注入送达路径：新回合（followup）或最近 pre-step（next-step）。 */
export type RuleDelivery = "followup" | "next-step";

/** 内置谓词名（纯函数性质判定，无参数）。 */
export type PredicateName =
  /** 恒真：显式表达「无条件命中」（文本类规则想每次都命中时用）。 */
  | "always"
  /** 文本含非 ASCII 字符（含中日韩、全角标点、emoji 等）。 */
  | "has-non-ascii"
  /** 文本含中日韩字符。 */
  | "has-cjk"
  /** 文本含 Markdown 代码围栏（```）。 */
  | "has-code-block";

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
  /** 一行摘要（`source.form:'notice'` 的 summary）；缺省取正文首行截断。 */
  summary?: string;
}

/** 一条规则。 */
export interface Rule {
  /** 规则标识（两层合并、节流记账、工具面定位都用它）。 */
  id: string;
  /** 是否启用，缺省 true。 */
  enabled?: boolean;
  /** 匹配面，缺省 "assistant-text"。 */
  source?: RuleSource;
  /** 注入送达路径，缺省 "followup"（新回合；"next-step" = 挂到最近 pre-step）。 */
  delivery?: RuleDelivery;
  /** 命中条件；缺省（或空对象）仅对 turn-end 表示无条件命中，其余匹配面视为永不命中。 */
  match?: MatchSpec;
  /** 命中后的动作。 */
  action: InjectAction;
  /** 同一会话内两次命中之间的最小回合间隔，缺省 0。 */
  cooldownTurns?: number;
  /** 同一会话内两次命中之间的最小毫秒间隔，缺省 0（不限制）。 */
  cooldownMs?: number;
  /** 说明（工具面只读展示）。 */
  description?: string | null;
}

/** 归一化后的规则（缺省值补齐，仍为纯数据，可持久化）。 */
export interface NormalizedRule {
  id: string;
  enabled: boolean;
  source: RuleSource;
  delivery: RuleDelivery;
  match: MatchSpec;
  action: InjectAction;
  cooldownTurns: number;
  cooldownMs: number;
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
  /** 一行摘要。 */
  summary: string;
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
  source: RuleSource;
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

/** 消费者回调上下文（本期触发点 = 模型回复后的整回合正文）。 */
export interface ConsumerContext {
  sessionId: string;
  /** 来源回合号。 */
  turn: number;
  /** 该回合全部 `assistant/message` 正文按 step 顺序拼接。 */
  text: string;
  /** 触发点标识（本期固定 `turn-end`）。 */
  trigger: "turn-end";
}

/** 消费者反馈（由 rule-engine 统一注入的内容）。 */
export interface ConsumerFeedback {
  /** 要注入的正文。 */
  text: string;
  /** 一行摘要（notice 呈现用），缺省取正文截断。 */
  summary?: string;
}

/** 消费者注册项（简单注册面：同步 decide，返回 null = 本轮不反馈）。 */
export interface ConsumerRegistration {
  /** 消费者标识（唯一；日志与冷却记账用）。 */
  id: string;
  /** 反馈注入路径，缺省 followup。 */
  delivery?: RuleDelivery;
  /** 同一会话两次反馈之间的最小回合间隔，缺省 0。 */
  cooldownTurns?: number;
  /** 同一会话两次反馈之间的最小毫秒间隔，缺省 0（不限制）。 */
  cooldownMs?: number;
  /** 同步决策：返回要注入的内容；null = 跳过本轮。 */
  decide(context: ConsumerContext): ConsumerFeedback | null;
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
