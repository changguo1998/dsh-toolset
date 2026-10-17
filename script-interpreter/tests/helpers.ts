/**
 * 测试公共辅助：宿主替身（`ctx` 五件的可选组合）、临时目录、假解释器、语言可用性。
 *
 * 本包宿主面全部按结构类型声明，故替身只需形状满足；`ctx.tools` / `ctx.sandbox`
 * / `ctx.sandboxPolicy` / `ctx.approval` 各自独立注入，便于逐项隔离验收。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BundleHost } from "../src/index.ts";
import { pythonBackend } from "../src/langs/python.ts";
import { probeInterpreter } from "../src/probe.ts";
import { SpillStore } from "../src/run.ts";
import type { ToolHost, ToolRuntime, ToolSettings } from "../src/tools.ts";
import type {
  ApprovalServiceLike,
  ConfinedArgvLike,
  EnabledLanguage,
  InterpreterInfo,
  LangBackend,
  LoggerLike,
  SandboxExecutionPolicyLike,
  SandboxPolicyServiceLike,
  SandboxProviderLike,
} from "../src/types.ts";

/** 工具定义的最小结构面（与宿主 `ToolDefinition` 的结构子集一致）。 */
export interface ToolDefLike {
  name: string;
  description: string;
  parameters: {
    type: string;
    required?: readonly string[];
    properties: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  execute(
    args: Record<string, unknown>,
    exec?: Record<string, unknown>,
  ): Promise<unknown>;
  output: {
    schema: Record<string, unknown>;
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: string }>;
  };
}

/** 宿主替身：注册面 + 日志 + 可选四件（沙箱 / 策略 / 审批 / 工具面开关）。 */
export interface MockHost {
  /** 按注册顺序收集的工具定义。 */
  readonly defs: ToolDefLike[];
  /** `ns: message` 形式的日志行。 */
  readonly logs: string[];
  /** 传给 `ctx` 的对象（直接交给 apply）。 */
  readonly ctx: BundleHost;
  /** 取最后一个注册的工具定义。 */
  tool(): ToolDefLike;
}

/** 构造宿主替身；未给的项不出现在 ctx 上（模拟极简 profile 缺服务）。 */
export function mockHost(
  overrides: {
    sandbox?: SandboxProviderLike;
    sandboxPolicy?: SandboxPolicyServiceLike;
    approval?: ApprovalServiceLike;
    tools?: boolean;
  } = {},
): MockHost {
  const defs: ToolDefLike[] = [];
  const logs: string[] = [];
  const logger = (ns: string): LoggerLike => ({
    info: (message: string) => logs.push(`${ns}: ${message}`),
    warn: (message: string) => logs.push(`${ns}: 警告：${message}`),
  });
  const ctx: BundleHost = {
    logger,
    ...(overrides.tools === false
      ? {}
      : {
          tools: { register: (def: unknown) => defs.push(def as ToolDefLike) },
        }),
    ...(overrides.sandbox === undefined ? {} : { sandbox: overrides.sandbox }),
    ...(overrides.sandboxPolicy === undefined
      ? {}
      : { sandboxPolicy: overrides.sandboxPolicy }),
    ...(overrides.approval === undefined
      ? {}
      : { approval: overrides.approval }),
  };
  return {
    defs,
    logs,
    ctx,
    tool(): ToolDefLike {
      const last = defs.at(-1);
      if (last === undefined) throw new Error("没有注册任何工具");
      return last;
    },
  };
}

/** 创建临时目录，返回路径与清理函数。 */
export function withTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "script-interpreter-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 在目录里写一个可执行文件（补齐 0755 权限位），返回绝对路径。 */
export function writeExecutable(
  dir: string,
  fileName: string,
  content: string,
): string {
  const path = join(dir, fileName);
  writeFileSync(path, content, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/**
 * 假解释器脚本：`--version` 打印给定版本行，其余情况把 stdin 原样回显。
 * 用于探测用例（不依赖机器上真有什么解释器）。
 */
export function fakeInterpreter(version: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "${version}"
  exit 0
fi
cat
exit 0
`;
}

/** 当前机器上的 Python 解释器（缺失时 `null`）。 */
export function pythonInfo(): InterpreterInfo | null {
  return probeInterpreter(pythonBackend).info;
}

/** 机器上有 Python 解释器时为 true（缺解释器的用例走 skip）。 */
export function hasPython(): boolean {
  return pythonInfo() !== null;
}

/** 构造工具 runtime 的输入。 */
export interface RuntimeOptions {
  settings?: Partial<ToolSettings>;
  languages?: EnabledLanguage[];
  host?: ToolHost;
  spillRoot?: string;
}

/** 造一个 `ToolRuntime`（测试用；不经过 apply，避免探测与注册的耦合）。 */
export function makeRuntime(options: RuntimeOptions = {}): ToolRuntime {
  const languages: EnabledLanguage[] = options.languages ?? [
    { backend: pythonBackend, interpreter: pythonInfo() },
  ];
  return {
    settings: {
      languages: languages.map((entry) => entry.backend.id),
      approval: "never",
      timeoutMs: 20_000,
      maxTimeoutMs: 600_000,
      maxOutputChars: 20_000,
      ...options.settings,
    },
    languages,
    spill: new SpillStore("script-interpreter-test-", options.spillRoot),
    host: options.host ?? {},
  };
}

/** 会记录调用并返回固定策略的 `ctx.sandboxPolicy` 替身。 */
export function fakePolicyService(policy: SandboxExecutionPolicyLike): {
  service: SandboxPolicyServiceLike;
  calls: Array<{ session?: unknown } | undefined>;
} {
  const calls: Array<{ session?: unknown } | undefined> = [];
  return {
    calls,
    service: {
      resolve(request) {
        calls.push(request);
        return policy;
      },
    },
  };
}

/** 会记录 argv / 策略并返回固定围栏结果（或抛错）的 `ctx.sandbox` 替身。 */
export function fakeSandbox(confined: ConfinedArgvLike | Error): {
  provider: SandboxProviderLike;
  calls: Array<{ argv: readonly string[]; policy: SandboxExecutionPolicyLike }>;
} {
  const calls: Array<{
    argv: readonly string[];
    policy: SandboxExecutionPolicyLike;
  }> = [];
  return {
    calls,
    provider: {
      async confine(argv, policy) {
        calls.push({ argv, policy });
        if (confined instanceof Error) throw confined;
        return confined;
      },
    },
  };
}

/** 会记录请求并返回固定结果的 `ctx.approval` 替身。 */
export function fakeApproval(outcome: string): {
  service: ApprovalServiceLike;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    service: {
      async request(req) {
        calls.push({ ...req });
        return outcome;
      },
    },
  };
}

/** 永远不该被调用的审批替身（用于断言「缺省不弹审批」）。 */
export function explodingApproval(): {
  service: ApprovalServiceLike;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    service: {
      async request(req) {
        calls.push({ ...req });
        throw new Error("缺省（approval: never）不应请求审批");
      },
    },
  };
}

/** 自定义后端（探测用例用；指向假解释器，不碰机器上的真解释器）。 */
export function fakeBackend(overrides: Partial<LangBackend> = {}): LangBackend {
  return {
    id: "fake",
    label: "Fake",
    configKey: "pythonPath",
    envVar: "FAKE_INTERPRETER",
    candidates: ["fakepy"],
    absolutePaths: [],
    args: ["-"],
    versionArgs: ["--version"],
    ...overrides,
  };
}
