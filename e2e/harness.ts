/**
 * 端到端夹具：为单个插件起一个真实 dsh 宿主。
 *
 * 每个测试文件一个进程、一个宿主：
 * - 在 `tmp/e2e/<随机>/` 建独立 `DSH_HOME` 与 profile（`@deepseek-ai/dsh-base` + 被测包）；
 * - 仓库包以符号链接挂进 profile 的 `node_modules`，宿主按 profile 装配；
 * - `runProfile()` 起树，工具经 `ctx.tools.execute()` 调用；
 * - 结束时释放树并删掉整个临时目录。
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP_ROOT = join(REPO_ROOT, "tmp", "e2e");

/** 宿主环境快照：把进程环境作为唯一来源层（测试不读 `.env`）。 */
function processEnvironment(): {
  get(name: string): { value: string; source: "process" } | undefined;
  getFrom(
    name: string,
    sources: readonly string[],
  ): { value: string; source: "process" } | undefined;
} {
  const get = (name: string) => {
    const value = process.env[name];
    return value === undefined
      ? undefined
      : { value, source: "process" as const };
  };
  return {
    get,
    getFrom: (name, sources) =>
      sources.includes("process") ? get(name) : undefined,
  };
}

/** 读取仓库包的 npm 名（用于 profile `bundles` 与 `node_modules` 链接）。 */
function packageNameOf(dir: string): string {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"),
  ) as { name?: string };
  if (typeof manifest.name !== "string")
    throw new Error(`${dir}: package.json 缺少 name`);
  return manifest.name;
}

/** 一条注册工具的最小面（真实宿主是完整 `ToolDefinition`，夹具只取用到的字段）。 */
export interface ToolDefinitionLike {
  name: string;
  description?: string;
}

/** 工具调用结果（`ToolExecutionResult` 的夹具侧口径）。 */
export interface ToolResultLike {
  isError: boolean;
  value?: unknown;
  error?: { message?: string; info?: { code?: string } };
  content?: { type: string; text?: string }[];
  additionalContexts?: unknown[];
}

export interface E2eHost {
  /** 宿主根上下文。 */
  ctx: Record<string, any>;
  /** 本次 profile 的临时 `DSH_HOME`。 */
  home: string;
  /** 被测包所在的仓库目录名（如 `fs-digest`）。 */
  packageDir: string;
  /** 按名调用已注册工具；超时抛错。`agent` 用于需要会话归属的工具。 */
  callTool(
    name: string,
    args: unknown,
    options?: { timeoutMs?: number; agent?: unknown },
  ): Promise<ToolResultLike>;
  /** 已注册工具清单。 */
  tools(): ToolDefinitionLike[];
  /** 建一个真实 agent（工具的会话归属与 `agent` 参数用）。 */
  createAgent(
    sessionId?: string,
  ): Promise<{ agent: unknown; dispose(): Promise<void> }>;
  /** 释放宿主并删掉临时目录。 */
  dispose(): Promise<void>;
}

export interface BootOptions {
  /** 除 `dsh-base` 与被测包外，还需一起挂载的仓库包目录名（服务依赖）。 */
  extraPackages?: readonly string[];
  /** 覆盖 profile 用户层 `cordis.patch.yml`（可先拿到临时 `DSH_HOME` 再生成内容）。 */
  patch?: string | ((home: string) => string);
  /** 工具调用缺省超时（毫秒）。 */
  toolTimeoutMs?: number;
  /** 起宿主前追加的环境变量（如 herdr 握手）。 */
  env?: Record<string, string>;
  /** 起宿主前准备外部资源（拿到临时 `DSH_HOME`，如本地 Redis / unix socket 服务）。 */
  prepare?: (home: string) => Promise<void> | void;
}

/** 起一个只挂 `dsh-base` + 被测包（及其服务依赖）的真实宿主。 */
export async function bootPackage(
  packageDir: string,
  options: BootOptions = {},
): Promise<E2eHost> {
  mkdirSync(TMP_ROOT, { recursive: true });
  const home = mkdtempSync(join(TMP_ROOT, `${packageDir}-`));
  const profileName = `e2e-${packageDir}`;
  const profileDir = join(home, "profiles", profileName);

  const repoDirs = [packageDir, ...(options.extraPackages ?? [])];
  const bundles = repoDirs.map(packageNameOf);
  mkdirSync(join(profileDir, "node_modules"), { recursive: true });
  for (const [index, dir] of repoDirs.entries()) {
    const name = bundles[index]!;
    const target = join(profileDir, "node_modules", ...name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(REPO_ROOT, dir), target, "dir");
  }
  writeFileSync(
    join(profileDir, "package.json"),
    `${JSON.stringify(
      {
        name: "dsh-toolset-e2e-profile",
        private: true,
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", ...bundles] } },
      },
      null,
      2,
    )}\n`,
  );
  if (options.patch !== undefined) {
    const patch =
      typeof options.patch === "function" ? options.patch(home) : options.patch;
    writeFileSync(join(profileDir, "cordis.patch.yml"), patch);
  }

  process.env.DSH_HOME = home;
  process.env.DSH_TELEMETRY_DISABLED = "1";
  for (const [key, value] of Object.entries(options.env ?? {}))
    process.env[key] = value;
  await options.prepare?.(home);
  const { runProfile } = await import("@deepseek-ai/dsh/profile-boot");
  const { ctx } = await runProfile({
    environment: processEnvironment(),
    profile: profileName,
    patchFiles: [],
    args: [],
  });

  let callSeq = 0;
  const host: E2eHost = {
    ctx: ctx as unknown as Record<string, any>,
    home,
    packageDir,
    async callTool(name, args, callOptions = {}) {
      const controller = new AbortController();
      const timeoutMs =
        callOptions.timeoutMs ?? options.toolTimeoutMs ?? 10_000;
      const timer = setTimeout(
        () =>
          controller.abort(new Error(`${name} 调用超时（${timeoutMs} ms）`)),
        timeoutMs,
      );
      try {
        return (await ctx.tools.execute({
          callId: `e2e-${callSeq++}`,
          name,
          arguments: args,
          ...(callOptions.agent === undefined
            ? {}
            : { agent: callOptions.agent }),
          signal: controller.signal,
        })) as ToolResultLike;
      } finally {
        clearTimeout(timer);
      }
    },
    tools() {
      return ctx.tools.schemas().map((schema: ToolDefinitionLike) => ({
        name: schema.name,
        description: schema.description,
      }));
    },
    async createAgent(sessionId = `e2e-${Date.now().toString(36)}`) {
      const handle = (await ctx.get("agents").create({
        sessionId,
        meta: { cwd: process.cwd() },
      })) as { agent: unknown; dispose: () => Promise<void> };
      return {
        agent: handle.agent,
        dispose: () => Promise.resolve(handle.dispose()),
      };
    },
    async dispose() {
      await ctx.fiber.dispose();
      rmSync(home, { recursive: true, force: true });
    },
  };
  return host;
}

/** 工具结果里的纯文本（多块拼接）。 */
export function textOf(result: ToolResultLike): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** 拦住 agent 的三条注入路径，收集 rule-engine 实际投递的消息。 */
export function captureInjections(
  agent: unknown,
): { via: string; message: Record<string, any> }[] {
  const collected: { via: string; message: Record<string, any> }[] = [];
  const target = agent as Record<string, any>;
  for (const via of ["followup", "steer", "inject"]) {
    if (typeof target[via] === "function") {
      target[via] = (message: Record<string, any>) => {
        collected.push({ via, message });
      };
    }
  }
  return collected;
}

/** 像真实回合一样往会话日志追加正文并收尾（rule-engine 的 assistant-text 依赖这一对事件）。 */
export function appendTurn(agent: unknown, text: string, turn = 1): void {
  const session = (agent as { session: Record<string, any> }).session;
  session.append(
    "assistant/message",
    {
      turn,
      step: 1,
      message: { content: [{ type: "text", text }] },
      stream: [],
    },
    { surfaceOp: "append" },
  );
  session.append("turn/end", { turn, reason: "completed" });
}

/** 往会话日志追加一个步边界事件（ponytail 等 `step-end` 消费者的兜底触发点）。 */
export function appendStepEnd(agent: unknown, turn = 1, step = 1): void {
  (agent as { session: Record<string, any> }).session.append("step/end", {
    turn,
    step,
  });
}

/** 注入消息里可见的正文（拼接全部 text 块）。 */
export function injectionText(
  message: Record<string, any> | undefined,
): string {
  const content = message?.["content"];
  return Array.isArray(content)
    ? content
        .filter((block) => block?.type === "text")
        .map((block) => String(block.text ?? ""))
        .join("\n")
    : "";
}

/** 轮询等待条件成立（只在有落盘/排期时用，避免固定 sleep）。 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时（${timeoutMs} ms）：${message}`);
}

/** 仓库内某路径相对临时 `DSH_HOME` 的绝对可用路径（夹具写盘统一入口）。 */
export function tempPath(home: string, relativePath: string): string {
  const path = join(home, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export { REPO_ROOT };
