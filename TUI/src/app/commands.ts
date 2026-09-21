// src/app/commands.ts — slash 命令纯逻辑（解析/决策，无副作用）
//
// 只处理「输入文本/状态 → 决策结果」的纯函数；副作用编排
// （adapter 调用、paint、notice）留在 App 执行。

import { localTitleFromText } from "./adapter/normalize.ts";
import { sanitizeText } from "./state.ts";
import type { ModelCatalog, ModelSelection } from "./adapter/dsh.ts";
import type { ThemeId } from "../renderer/theme.ts";

/** 格式化模型目录为多行文本（/model 无参输出）：纯 ASCII，当前模型前 ->、其余空格缩进 */
/**
 * 会话标题：剥空白并截断到 ≤30 显示字符；空文本 →（新会话）。
 * 为 resume 后从 surface 首条用户消息生成标题的本地兜底（无官方 title 服务依赖时）；
 * 标题核心逻辑与 adapter 列表行共享（normalize.localTitleFromText）。
 */
export function deriveTitle(text: string | undefined): string {
  return localTitleFromText(text) ?? "（新会话）";
}

/**
 * 收集末尾连续 assistant 行（完整最后一条模型回复），以 \n 连接并去首尾空白。
 * 多行回复经 appendStream 按 \n 拆成多条 assistant buffer 行，/copy 须整体收集
 * 而非只取末行；无任何 assistant 正文 → undefined。
 */
export function lastAssistantText(
  lines: readonly { text: string; kind: string }[],
): string | undefined {
  // 从末尾跳过非 assistant 杂讯行（notice/separator 等），定位最后一条 assistant，
  // 再向上收集该回复的全部连续 assistant 行（多行回复整体复制）
  let end = lines.length - 1;
  while (end >= 0 && (!lines[end] || lines[end]!.kind !== "assistant")) end--;
  if (end < 0) return undefined;
  const reply: string[] = [];
  for (let i = end; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.kind !== "assistant") break;
    reply.unshift(line.text);
  }
  const text = reply.join("\n").trim();
  return text === "" ? undefined : text;
}

/** ANSI 转义序列（CSI/OSC/单字符 ESC）正则。OSC 支持 BEL（\x07）与 ST（ESC\）
 *  两种结尾（OSC 8 超链接等 ST 结尾序列不再泄漏载荷文本）。 */
const ANSI_ESCAPE_RE =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** 剥离 ANSI 转义序列 → 纯文本（/copy 编码前必须剥离控制序列） */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/** OSC52 剪贴板序列：ESC ]52;c;<base64 utf8> BEL（终端识别后写入系统剪贴板）；
 *  编码前剥离 ANSI 控制序列，保证剪贴板内容为纯文本 */
export function buildOsc52(text: string): string {
  const b64 = Buffer.from(stripAnsi(text), "utf8").toString("base64");
  return `\x1b]52;c;${b64}\x07`;
}

/** 历史会话表面消息 → buffer 行（仅 user/assistant，供 resume 后展示上下文）；
 *  历史 assistant 均为已完成回合的最终总结 → final: true（历史区展示） */
export function surfaceToBuffer(
  messages: readonly { role: "user" | "assistant"; text: string }[],
): { text: string; kind: "user" | "assistant"; final?: boolean }[] {
  const out: { text: string; kind: "user" | "assistant"; final?: boolean }[] =
    [];
  for (const m of messages) {
    if (m.role === "user" || m.role === "assistant") {
      // assistant 多段文本（extractTextBlocks 以 \n join）拆成独立 buffer 行：
      // 逐行结构是 fence 识别/段落归并的前提。user 消息则整段保留（一次输入 =
      // 一个用户块，显式换行由布局层按物理行渲染，块内行首左对齐）。
      const text = sanitizeText(m.text).text;
      const parts = m.role === "user" ? [text] : text.split("\n");
      for (const line of parts)
        out.push({
          text: line,
          kind: m.role,
          final: m.role === "assistant" ? true : undefined,
        });
    }
  }
  return out;
}

export function formatModelCatalog(catalog: ModelCatalog): string {
  const current = catalog.current;
  const lines: string[] = [];
  // listModels 为 advisory 目录，当前默认模型可能不在其中——始终渲染为首行并带 -> 标记
  if (current?.provider && current?.model) {
    lines.push(`  -> ${current.provider}/${current.model}`);
  }
  for (const m of catalog.models) {
    const key = `${m.provider}/${m.id}`;
    const isCurrent =
      current?.provider === m.provider && current?.model === m.id;
    if (isCurrent) continue;
    lines.push(`     ${key}`);
  }
  if (lines.length === 0) {
    return "no available models (llm service missing or no adapter registered)";
  }
  return lines.join("\n");
}

/** 解析 /model <spec>：显式 provider/model 直通；裸 model id 需跨 provider 唯一匹配 */
export function resolveModelSpec(
  catalog: ModelCatalog,
  spec: string,
): { error: string } | { selection: ModelSelection; same: boolean } {
  const current = catalog.current;
  const same = (p: string, m: string): boolean =>
    current?.provider === p && current?.model === m;
  const slash = spec.indexOf("/");
  if (slash >= 0) {
    const provider = spec.slice(0, slash);
    const model = spec.slice(slash + 1);
    if (!provider || !model)
      return {
        error: "usage: /model <provider>/<model> or /model <modelId>",
      };
    return { selection: { provider, model }, same: same(provider, model) };
  }
  const matches = catalog.models.filter((m) => m.id === spec);
  if (matches.length === 0)
    return {
      error: `model "${spec}" not found in available models. Use /model to list.`,
    };
  if (matches.length > 1) {
    const ps = matches.map((m) => m.provider).join(", ");
    return {
      error: `model "${spec}" exists in multiple providers (${ps}). Use /model <provider>/<model>.`,
    };
  }
  const m = matches[0]!;
  return {
    selection: { provider: m.provider, model: m.id },
    same: same(m.provider, m.id),
  };
}

/** Slash 路由决策：本地命令 → 对应 kind；其余一律 adapter commands 注册表（fail-close，绝不经 sendMessage） */
export type SlashRoute =
  | "help"
  | "clearscreen"
  | "quit"
  | "model"
  | "provider"
  | "effort"
  | "theme"
  | "verbose"
  | "symbol-unify"
  | "session"
  | "copy"
  | "registry"
  | "goal"
  | "policy"
  | "permission"
  | "preset"
  | "jobs"
  | "init"
  | "stats"
  | "rename"
  | "skills"
  | "agents"
  | "tools"
  | "settings"
  | "fork"
  | "task"
  | "guard"
  | "memory"
  | "loop"
  | "contract"
  | "workflows"
  | "council"
  | "search";

/** 本地命令目录：路由与输入补全的**单一来源**（含别名，别名也是独立可补全项）。
 *  desc 供补全候选展示；/help 的逐行说明仍在 App.helpText（历史格式）。 */
export const LOCAL_COMMANDS: readonly {
  name: string;
  route: SlashRoute;
  desc: string;
}[] = [
  { name: "help", route: "help", desc: "本帮助（命令与快捷键）" },
  { name: "clearscreen", route: "clearscreen", desc: "清屏" },
  { name: "cls", route: "clearscreen", desc: "清屏（同 /clearscreen）" },
  { name: "quit", route: "quit", desc: "退出 TUI" },
  { name: "model", route: "model", desc: "切换模型：无参打开选择面板" },
  {
    name: "provider",
    route: "provider",
    desc: "打开模型面板的 provider 列",
  },
  { name: "effort", route: "effort", desc: "打开模型面板的 effort 列" },
  {
    name: "thinking",
    route: "effort",
    desc: "打开模型面板的 effort 列（同 /effort）",
  },
  { name: "theme", route: "theme", desc: "主题切换 dark/light" },
  {
    name: "verbose",
    route: "verbose",
    desc: "活动区详略：on=完整折行 / off=紧凑（每条目 1 行 + 省略号）",
  },
  {
    name: "symbol-unify",
    route: "symbol-unify",
    desc: "模型输出符号统一：on=变体替换为推荐符号并提醒 / off=原样（不替换不提醒）",
  },
  { name: "session", route: "session", desc: "历史会话浏览/恢复" },
  { name: "copy", route: "copy", desc: "复制最后一条回复（OSC52）" },
  { name: "goal", route: "goal", desc: "当前会话目标迷你面板" },
  { name: "policy", route: "policy", desc: "审批策略 ask/never" },
  {
    name: "permission",
    route: "permission",
    desc: "权限预设（sandbox+审批捆绑）",
  },
  { name: "preset", route: "preset", desc: "agent 预设目录" },
  { name: "jobs", route: "jobs", desc: "后台任务面板（Enter 取消）" },
  {
    name: "init",
    route: "init",
    desc: "初始化 AGENTS.md（缺失时由模型阅读目录生成）",
  },
  {
    name: "stats",
    route: "stats",
    desc: "本回合 token 用量与上下文占比（/usage、/context 同）",
  },
  { name: "usage", route: "stats", desc: "同上（同 /stats）" },
  { name: "context", route: "stats", desc: "同上（同 /stats）" },
  { name: "rename", route: "rename", desc: "重命名当前会话标题" },
  {
    name: "skills",
    route: "skills",
    desc: "技能目录面板（Enter 详情、PgUp/PgDn 翻页）",
  },
  {
    name: "agents",
    route: "agents",
    desc: "子代理面板（Enter 直接中断选中项）",
  },
  { name: "tools", route: "tools", desc: "工具目录面板（Enter 详情）" },
  {
    name: "settings",
    route: "settings",
    desc: "只读展示配置（ns：value，secret 脱敏）",
  },
  { name: "fork", route: "fork", desc: "分叉当前会话为新会话" },
  {
    name: "task",
    route: "task",
    desc: "任务面板（TaskEngine 只读：标题/状态）",
  },
  {
    name: "guard",
    route: "guard",
    desc: "守卫面板（security-guard：拦截/放行记录，Enter 看策略）",
  },
  {
    name: "memory",
    route: "memory",
    desc: "知识库概要（knowledge-base：就绪/路径/chunk·source 计数）",
  },
  {
    name: "loop",
    route: "loop",
    desc: "循环面板（metric-loop：活动/历史循环，Enter 详情）",
  },
  {
    name: "contract",
    route: "contract",
    desc: "契约概览（goal-contract：当前目标 + Done-when 条款，notice 型）",
  },
  {
    name: "workflows",
    route: "workflows",
    desc: "工作流运行面板（tool-workflow：只读运行列表，Enter 无操作）",
  },
  {
    name: "council",
    route: "council",
    desc: "二次意见（并行 N 个评审子代理对当前目标给独立意见；notice 展示）",
  },
  {
    name: "search",
    route: "search",
    desc: "网页搜索（dsh-web 多 provider 聚合；列表展示，Enter 看来源）",
  },
];

/** 命令名 → 路由（模块加载时构建一次；不在目录中的名字落 registry 转发） */
const LOCAL_ROUTES = new Map<string, SlashRoute>(
  LOCAL_COMMANDS.map((c) => [c.name, c.route]),
);

export function routeSlashCommand(name: string): SlashRoute {
  return LOCAL_ROUTES.get(name) ?? "registry";
}

/** /init 初始化指令（当前目录无 AGENTS.md 时注入会话）：模型据此阅读目录、总结并写 AGENTS.md */
export const INIT_PROMPT = [
  "请为当前项目初始化 AGENTS.md（面向 agent 的项目协作说明）：",
  "1. 阅读当前目录下的文件与结构（如 package.json、README、配置文件与主要源码目录）；",
  "2. 总结项目用途与技术栈、常用命令（构建/测试/格式化）、代码与提交约定、目录结构与关键模块；",
  "3. 将结果写入当前目录根部的 AGENTS.md（若已存在则不要覆盖，改为报告已存在）。",
].join("\n");

/** 补全候选（命令名 + 一句话说明） */
export interface CommandCandidate {
  name: string;
  desc: string;
}

/** 输入是否仍处于「首个命令 token」（字面 `/` 开头 + 仅命令名字符，无空白与参数） */
export function isCommandTokenInput(text: string): boolean {
  return /^\/[a-z0-9_-]*$/i.test(text);
}

/** 输入模式（与 state.InputMode 结构一致；只关心 slash 与否，避免 commands→state 依赖） */
type InputModeLike = "normal" | "shell" | "slash";

/**
 * 取「命令 token」纯文本（不含前导 `/`）：slash 模式下输入框不含前导 `/`
 * （提交时才补，见 App.submit），故先归一为字面 `/name` 形式再判定；
 * 非 token 输入（含参数、非命令首字符、换行）返回 null。
 */
function commandToken(text: string, mode: InputModeLike): string | null {
  const literal = mode === "slash" && !text.startsWith("/") ? "/" + text : text;
  return isCommandTokenInput(literal) ? literal.slice(1).toLowerCase() : null;
}

/**
 * 输入补全候选（纯函数）：仅当 text 是首个命令 token 时给候选，否则 null。
 * 匹配=名称前缀命中（大小写不敏感）；排序=前缀更短（更贴近输入）优先、同长字典序，
 * 故 items[0] 恒为「最匹配」的默认候选（面板默认高亮它）。
 * extra 为宿主注册表命令（ctx.commands.list），同名不与本地目录重复；
 * mode=slash 时输入框文本无前导 `/`（归一后匹配）。
 */
export function completeCommandInput(
  text: string,
  extra: readonly CommandCandidate[] = [],
  mode: InputModeLike = "normal",
): { items: CommandCandidate[]; index: number } | null {
  const token = commandToken(text, mode);
  if (token === null) return null;
  const seen = new Set<string>();
  const items: CommandCandidate[] = [];
  for (const c of [...LOCAL_COMMANDS, ...extra]) {
    if (seen.has(c.name) || !c.name.toLowerCase().startsWith(token)) continue;
    seen.add(c.name);
    items.push({ name: c.name, desc: c.desc });
  }
  if (items.length === 0) return null;
  items.sort(
    (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
  );
  // 候选不设硬上限：面板按活动区可视行截断（CommandCompletion 超出丢弃、焦点导航
  // 由 App.completionVisibleRows() 同口径限制），候选池足够时活动区即可铺满。
  return { items, index: 0 };
}

/** /model 参数（命令名之后的文本，去首尾空白）；空串 = 无参（进入交互选择） */
export function modelCommandSpec(line: string): string {
  return line.slice("/model".length).trim();
}

/** slash 命令参数（命令名之后的文本，去首尾空白）；`/effort` → ""，`/effort high` → "high" */
export function slashCommandArg(line: string): string {
  return line.replace(/^\/[a-z][a-z0-9_-]*/, "").trim();
}

/** /theme 参数决策：""/toggle → dark|light 互切；显式 light/dark → 取之；其余参数 → usage 错误 */
export type ThemeCommandDecision =
  { kind: "usage" } | { kind: "apply"; theme: ThemeId };

export function themeCommandDecision(
  line: string,
  cur: ThemeId,
): ThemeCommandDecision {
  const arg = line.slice("/theme".length).trim().toLowerCase();
  if (arg === "" || arg === "toggle") {
    return { kind: "apply", theme: cur === "dark" ? "light" : "dark" };
  }
  if (arg === "light" || arg === "dark") {
    return { kind: "apply", theme: arg };
  }
  return { kind: "usage" };
}

/** /rename 参数决策：无参 → usage（用法提示）；参数为空或含换行 → invalid（本地拒绝，
 *  不发服务调用）；其余 → apply。决策为纯函数以便单测覆盖非法分支（App 提交路径已 trim
 *  整行，「仅空白参数」只能经此函数直接构造验证）。 */
export type RenameCommandDecision =
  | { kind: "usage" }
  | { kind: "invalid"; reason: string }
  | { kind: "apply"; title: string };

export function renameCommandDecision(line: string): RenameCommandDecision {
  // 保留未 trim 的原始参数：区分「完全无参」与「有空白参数但内容为空」
  const raw = line.replace(/^\/[a-z][a-z0-9_-]*/i, "");
  const title = raw.trim();
  if (title === "") {
    return raw === ""
      ? { kind: "usage" }
      : { kind: "invalid", reason: "标题不能为空" };
  }
  if (title.includes("\n") || title.includes("\r")) {
    return { kind: "invalid", reason: "标题不能包含换行" };
  }
  return { kind: "apply", title };
}
