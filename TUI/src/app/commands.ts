// src/app/commands.ts — slash 命令纯逻辑（解析/决策，无副作用）
//
// 只处理「输入文本/状态 → 决策结果」的纯函数；副作用编排
// （adapter 调用、paint、notice）留在 App 执行。

import type { ModelCatalog, ModelSelection } from "./adapter/dsh.ts";
import type { ThemeId } from "../renderer/theme.ts";

/** 格式化模型目录为多行文本（/model 无参输出）：纯 ASCII，当前模型前 ->、其余空格缩进 */
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
  "help" | "clearscreen" | "quit" | "model" | "theme" | "registry";

export function routeSlashCommand(name: string): SlashRoute {
  switch (name) {
    case "help":
      return "help";
    case "clearscreen":
    case "cls":
      return "clearscreen";
    case "quit":
      return "quit";
    case "model":
      return "model";
    case "theme":
      return "theme";
    default:
      return "registry";
  }
}

/** /model 参数（命令名之后的文本，去首尾空白）；空串 = 无参（进入交互选择） */
export function modelCommandSpec(line: string): string {
  return line.slice("/model".length).trim();
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
