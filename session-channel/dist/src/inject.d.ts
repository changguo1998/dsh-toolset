/** 注入消息来源标识（生产者各自声明；TUI 按此识别并按用户块显示）。 */
export declare const SOURCE_KIND = "session-channel";
/** 注入正文前缀（与 `[AUTO]` / `[RULE]` 同口径：供人区分自动注入与真实输入）。 */
export declare const INJECTION_PREFIX = "[CHANNEL] ";
/** 宿主 agent 的最小形态（结构面访问，不引宿主类型依赖）。 */
export interface AgentLike {
    /** agent 所属 session（`flush` 需要）。 */
    session?: unknown;
    /** 追加一条 user-role 消息到下一回合（同步 void）。 */
    followup?(message: unknown): void;
}
/** 宿主 ctx 的注入相关最小形态。 */
export interface InjectionHost {
    agents?: {
        get(id: string): AgentLike | undefined | null;
    } | undefined;
    /** 注入后 flush 落盘（宿主 rc.2 面；缺失则跳过）。 */
    sessions?: {
        flush?(session: unknown): unknown;
    } | undefined;
}
/**
 * 受保护地读宿主服务：`ctx.get(name)` 优先，直接属性读兜底并吞掉 cordis 抛错。
 * 真实 cordis ctx 上未 inject 的服务属性直读会抛
 * `cannot get property "x" without inject`——读取失败一律视为「服务不可用」。
 */
export declare function readService<T>(ctx: unknown, name: string): T | undefined;
/** 构造注入消息（user 角色 + `[CHANNEL] ` 前缀 + 来源元数据）。 */
export declare function buildInjectionMessage(text: string, from: string, prefix?: string): Record<string, unknown>;
/**
 * 注入到目标会话：解析 agent → 推迟宏任务 → `followup`。
 * @returns false = 会话不在本进程/无 followup（调用方不写回执，消息留在流里可查）。
 */
export declare function injectUserMessage(host: InjectionHost, sessionId: string, message: Record<string, unknown>, onWarn?: (message: string) => void): boolean;
