/**
 * 沙箱运行层：单一派生程序（SUMMARY_PROGRAM）的两种执行器。
 *
 *  - CodeRuntimeSandbox：宿主 ctx.codeRuntime 服务（worker-thread 后端，headless bundle 提供），
 *    程序以 async 函数体 + 全局绑定 input 运行，返回值经 JSON 无损传递；
 *  - VmSandbox：code-runtime 缺失时的 node:vm 进程内回落，执行同一程序源。
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

/** 宿主 code-runtime 服务的最小结构化视图（不做 npm 依赖）。 */
export interface CodeRuntimeLike {
  run(req: {
    program: string;
    bindings: Array<{
      global: string;
      functions: Record<string, (args: unknown) => Promise<unknown>>;
    }>;
  }): Promise<{
    value?: unknown;
    error?: { kind: string; message: string };
  }>;
}

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

/** code-runtime 执行器（默认路径）。 */
export class CodeRuntimeSandbox implements SandboxRunner {
  /** @param runtime 宿主 ctx.codeRuntime 服务实例。 */
  constructor(private readonly runtime: CodeRuntimeLike) {}

  /** 经宿主沙箱执行派生程序；失败（含 value 非法）时抛错。 */
  async run(text: string): Promise<SummaryJson> {
    const result = await this.runtime.run({
      program: SUMMARY_PROGRAM,
      bindings: [
        // 程序按宿主编解码约束传一个占位参数（见 SUMMARY_PROGRAM 注释），绑定实现忽略之
        { global: "input", functions: { text: async () => text } },
      ],
    });
    if (result.error !== undefined) {
      throw new Error(
        `code-runtime 派生失败: ${result.error.kind}: ${result.error.message}`,
      );
    }
    // round-trip + 校验：保证结果可无损序列化（契约要求）且原型归一为本 realm
    return normalizeSummaryJson(result.value);
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
