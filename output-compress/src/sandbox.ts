/**
 * 沙箱运行层：单一派生程序（SUMMARY_PROGRAM）的三条执行路径。
 *
 *  - CodeRuntimeSandbox：宿主沙箱服务（0.1.7 起为 `ctx.ptcRuntime`，≤0.1.5 为 `ctx.codeRuntime`），
 *    程序以 async 函数体 + 全局绑定 input 运行，返回值经 JSON 无损传递；
 *  - RuntimeWithFallback：宿主沙箱「不可用」时就地回落 vm（程序级失败不重试），摘要不中断；
 *  - VmSandbox：宿主沙箱缺失/不可用时的 node:vm 进程内回落，执行同一程序源。
 */
import { runInNewContext } from "node:vm";

import {
  SUMMARY_PROGRAM,
  type SummaryJson,
  validateSummary,
} from "./summary-program.ts";

/** 派生程序执行器统一接口。 */
export interface SandboxRunner {
  /** 对完整输出文本执行确定性派生，返回摘要 JSON；失败时抛错。 */
  run(text: string): Promise<SummaryJson>;
}

/** 派生请求：0.1.7 `resolve()` 的输入（cwd/timeoutMs/sandboxPolicy 由宿主 provider 补齐/钳位）。 */
export interface RuntimeRunRequest {
  program: string;
  bindings: Array<{
    global: string;
    functions: Record<string, (args: unknown) => Promise<unknown>>;
  }>;
  /** 执行预算（ms）；`null` 表示不限，省略用 provider 默认。 */
  timeoutMs?: number | null;
}

/** 宿主沙箱服务的最小结构化视图（不做 npm 依赖，服务名随版本变化，见 resolveSandboxRuntime）。
 *  0.1.7 起 `ptcRuntime`：先 `resolve(request) → spec`（补 cwd/timeoutMs/sandboxPolicy）再 `run(spec)`，
 *  缺 spec 会被 Node provider 直接拒绝；≤0.1.5 的 `codeRuntime` 只有 `run(request)`，故 `resolve` 可选。 */
export interface CodeRuntimeLike {
  /** 可选（0.1.7 起存在）：把请求解析为完整执行输入 */
  resolve?(req: RuntimeRunRequest): unknown;
  run(req: unknown): Promise<{
    value?: unknown;
    error?: { kind: string; message: string };
  }>;
}

/** 宿主沙箱「不可用」（服务交互失败）——仅此类错误触发 vm 回落；程序级失败不属此类。 */
export class RuntimeUnavailableError extends Error {}

/**
 * JSON round-trip 归一 + 结构校验：保证结果为可无损序列化的纯 JSON 数据，
 * 并把跨 realm 对象（vm 上下文）原型归一为本 realm，最终收敛为 SummaryJson。
 * 非法/不可序列化输入抛描述性错误（由调用方 hooks 捕获并降级为 skipped）。
 */
function normalizeSummaryJson(value: unknown): SummaryJson {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `摘要结果不可 JSON 序列化: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (text === undefined) {
    throw new Error("摘要结果为 undefined（程序未 return？）");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`摘要结果不是合法 JSON: ${String(error)}`, {
      cause: error,
    });
  }
  return validateSummary(parsed);
}

/** 宿主沙箱执行器（默认路径；服务为 0.1.7 的 `ptcRuntime` 或 ≤0.1.5 的 `codeRuntime`）。 */
export class CodeRuntimeSandbox implements SandboxRunner {
  /** @param runtime 宿主 ctx.ptcRuntime / ctx.codeRuntime 服务实例。 */
  constructor(private readonly runtime: CodeRuntimeLike) {}

  /**
   * 经宿主沙箱执行派生程序。
   * resolve/run 的**服务交互失败**抛 `RuntimeUnavailableError`（调用方由此回落 vm）；
   * **程序自身失败**（result.error，含新增的 output-limit/protocol/sandbox-unavailable 类）
   * 抛普通错误——同一程序源在 vm 下同样会失败，重试无意义。
   */
  async run(text: string): Promise<SummaryJson> {
    const request: RuntimeRunRequest = {
      program: SUMMARY_PROGRAM,
      bindings: [
        // 程序按宿主编解码约束传一个占位参数（见 SUMMARY_PROGRAM 注释），绑定实现忽略之
        { global: "input", functions: { text: async () => text } },
      ],
      // 与 VmSandbox 的同步段超时口径一致；宿主 provider 会按自身配置再钳位
      timeoutMs: 30_000,
    };
    let result: { value?: unknown; error?: { kind: string; message: string } };
    try {
      // 0.1.7 起必须先 resolve：spec 才带 cwd/sandboxPolicy（缺了 Node provider 直接 throw）
      const spec =
        typeof this.runtime.resolve === "function"
          ? this.runtime.resolve(request)
          : request;
      result = await this.runtime.run(spec);
    } catch (error) {
      throw new RuntimeUnavailableError(
        `宿主沙箱不可用: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (result.error !== undefined) {
      throw new Error(
        `宿主沙箱派生失败: ${result.error.kind}: ${result.error.message}`,
      );
    }
    // round-trip + 校验：保证结果可无损序列化（契约要求）且原型归一为本 realm
    return normalizeSummaryJson(result.value);
  }
}

/**
 * 宿主沙箱 + vm 的复合执行器：只在宿主沙箱**不可用**时回落（程序级失败原样抛出，
 * 不重复执行同一程序源），保证摘要功能不因宿主沙箱问题中断。
 */
export class RuntimeWithFallback implements SandboxRunner {
  /**
   * @param primary 宿主沙箱执行器
   * @param fallback vm 回落执行器
   * @param onFallback 回落时的日志回调（记录原因，便于诊断）
   */
  constructor(
    private readonly primary: SandboxRunner,
    private readonly fallback: SandboxRunner,
    private readonly onFallback: (message: string) => void,
  ) {}

  async run(text: string): Promise<SummaryJson> {
    try {
      return await this.primary.run(text);
    } catch (error) {
      if (!(error instanceof RuntimeUnavailableError)) throw error;
      this.onFallback(error instanceof Error ? error.message : String(error));
      return this.fallback.run(text);
    }
  }
}

/**
 * node:vm 进程内回落执行器（code-runtime 缺失时使用）。
 * 与 code-runtime 共享同一程序源，保证「同一输入 → 同一摘要」。
 * 上下文仅注入 input 与 TextEncoder（程序内用到的全部外部符号）。
 */
export class VmSandbox implements SandboxRunner {
  /**
   * 在隔离 vm 上下文中执行派生程序。
   * @param text 完整输出文本
   * @param timeoutMs 脚本同步段超时（默认 30s；await 数据返回为同步 resolve，
   *   主要受编译+执行耗时支配）
   */
  async run(text: string, timeoutMs = 30_000): Promise<SummaryJson> {
    // 包装为 async IIFE：程序体可 await input.text() 并 return 摘要
    const wrapped = `(async (input) => {\n${SUMMARY_PROGRAM}\n})(input)`;
    const promise = runInNewContext(
      wrapped,
      { input: { text: async () => text }, TextEncoder },
      { timeout: timeoutMs, filename: "output-compress-summary.js" },
    ) as Promise<unknown>;
    const value = await promise;
    // round-trip + 校验：vm 上下文的对象原型跨 realm，归一为本 realm 纯 JSON 对象
    return normalizeSummaryJson(value);
  }
}
