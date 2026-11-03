// TUI/src/app/runtime/commands-model.ts — 模型命令: /model、/provider、/effort、/thinking、启动参数模型
//
// 2026-11-04 拆分自 TUI/src/app/index.ts 的 App 类体: 方法体只做 this. -> ctx. 改写,
// 跨模块调用经 ctx.self, 公共状态在 ./context.ts.

import {
  matchEffort,
  modelCommandSpec,
  modelRouteError,
  parseModelSpecArg,
  resolveModelSpec,
  slashCommandArg,
} from "../commands.ts";
import type { AppContext } from "./context.ts";

export function createCommandsModelPart(ctx: AppContext) {
  /** /model 命令：无参进入交互选择；带参切换当前会话模型
   *  （`<provider>/<model>[:<effort>]` 或 `<model>[:<effort>]`，无后缀保留当前 effort） */
  async function handleModelCommand(line: string): Promise<void> {
    const spec = modelCommandSpec(line);
    try {
      if (!spec) {
        const catalog = await ctx.deps.adapter.modelCatalog();
        ctx.self.openModelPicker(catalog);
        return;
      }
      const catalog = await ctx.deps.adapter.modelCatalog();
      const resolved = resolveModelSpec(catalog, spec);
      if ("error" in resolved) {
        ctx.self.notice(resolved.error, "warn");
        return;
      }
      const selection = resolved.selection;
      if (selection.reasoningEffort !== undefined) {
        const efforts = await ctx.deps.adapter.modelEfforts(
          selection.provider,
          selection.model,
        );
        let hit = matchEffort(efforts, selection.reasoningEffort);
        if (
          hit === undefined &&
          catalog.current?.reasoningEffort !== undefined &&
          catalog.current.reasoningEffort.toLowerCase() ===
            selection.reasoningEffort.toLowerCase()
        ) {
          hit = catalog.current.reasoningEffort;
        }
        if (hit === undefined) {
          ctx.self.notice(
            `effort "${selection.reasoningEffort}" not available for ${selection.provider}/${selection.model}`,
            "warn",
          );
          return;
        }
        selection.reasoningEffort = hit;
      }
      await ctx.self.applyModelSelection(selection);
    } catch (err) {
      ctx.self.notice("model command failed: " + String(err), "error");
    }
  }

  /** /provider <name>：只改 provider，保留当前 model 与 effort；组合不存在 → 警告 + 不操作 */
  async function handleProviderSwitch(provider: string): Promise<void> {
    try {
      const catalog = await ctx.deps.adapter.modelCatalog();
      const cur = catalog.current;
      if (!cur?.provider || !cur?.model) {
        ctx.self.notice("no current model; use /model first", "warn");
        return;
      }
      if (provider === cur.provider) {
        // 设置到当前 provider：按 already-on 处理（不依赖 advisory 目录是否收录当前路由）。
        await ctx.self.applyModelSelection({
          provider: cur.provider,
          model: cur.model,
          ...(cur.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: cur.reasoningEffort }),
        });
        return;
      }
      const error = modelRouteError(catalog, provider, cur.model);
      if (error !== undefined) {
        ctx.self.notice(error, "warn");
        return;
      }
      if (cur.reasoningEffort !== undefined) {
        const efforts = await ctx.deps.adapter.modelEfforts(
          provider,
          cur.model,
        );
        const hit = matchEffort(efforts, cur.reasoningEffort);
        if (hit === undefined) {
          ctx.self.notice(
            `effort "${cur.reasoningEffort}" not available for ${provider}/${cur.model}`,
            "warn",
          );
          return;
        }
        await ctx.self.applyModelSelection({
          provider,
          model: cur.model,
          reasoningEffort: hit,
        });
        return;
      }
      await ctx.self.applyModelSelection({ provider, model: cur.model });
    } catch (err) {
      ctx.self.notice("model command failed: " + String(err), "error");
    }
  }

  /** /effort <level>（含 /thinking）：只改思考等级；未命中 → 警告 + 不操作 */
  async function handleEffortSwitch(level: string): Promise<void> {
    try {
      const catalog = await ctx.deps.adapter.modelCatalog();
      const cur = catalog.current;
      if (!cur?.provider || !cur?.model) {
        ctx.self.notice("no current model; use /model first", "warn");
        return;
      }
      const efforts = await ctx.deps.adapter.modelEfforts(
        cur.provider,
        cur.model,
      );
      let hit = matchEffort(efforts, level);
      if (
        hit === undefined &&
        cur.reasoningEffort !== undefined &&
        cur.reasoningEffort.toLowerCase() === level.toLowerCase()
      ) {
        hit = cur.reasoningEffort;
      }
      if (hit === undefined) {
        ctx.self.notice(
          `effort "${level}" not available for ${cur.provider}/${cur.model}`,
          "warn",
        );
        return;
      }
      await ctx.self.applyModelSelection({
        provider: cur.provider,
        model: cur.model,
        reasoningEffort: hit,
      });
    } catch (err) {
      ctx.self.notice("model command failed: " + String(err), "error");
    }
  }

  /** /provider | /effort | /thinking：无参打开 /model 面板并预置焦点列（0=provider、2=effort）；
   *  带参走对应字段的直接切换（只改该字段，其余保持）。 */
  async function handleModelFocus(name: string, line: string): Promise<void> {
    const arg = slashCommandArg(line);
    if (arg !== "") {
      if (name === "provider") await handleProviderSwitch(arg);
      else await handleEffortSwitch(arg);
      return;
    }
    try {
      const catalog = await ctx.deps.adapter.modelCatalog();
      ctx.self.openModelPicker(catalog, name === "provider" ? 0 : 2);
    } catch (err) {
      ctx.self.notice("model command failed: " + String(err), "error");
    }
  }

  /**
   * 启动参数模型覆盖（`--provider` / `--model` / `--effort`）：adapter 就绪后按目录校验并落地。
   * 只改指定字段：provider 保留当前 model / effort；`--model` 带 provider 段时同时改 provider；
   * 裸 model 用当前（默认）provider。组合不存在 → 警告并保持启动路由；
   * effort 未命中 → 回退该模型最低等级（用户 2026-10-27 裁定）。
   */
  async function applyStartupModel(args: {
    provider?: string;
    model?: string;
    effort?: string;
  }): Promise<void> {
    try {
      const catalog = await ctx.deps.adapter.modelCatalog();
      const current = catalog.current;
      if (!current?.provider || !current?.model) {
        ctx.self.notice("startup model: no current model route", "warn");
        return;
      }
      const parsed =
        args.model === undefined ? undefined : parseModelSpecArg(args.model);
      if (args.model !== undefined && parsed === undefined) {
        ctx.self.notice(
          `startup model: invalid --model "${args.model}"`,
          "warn",
        );
        return;
      }
      const provider = parsed?.provider ?? args.provider ?? current.provider;
      const model = parsed?.model ?? current.model;
      const error = modelRouteError(catalog, provider, model);
      if (error !== undefined) {
        ctx.self.notice(
          `startup model: ${error}; keeping current route`,
          "warn",
        );
        return;
      }
      const efforts = await ctx.deps.adapter.modelEfforts(provider, model);
      const requested =
        parsed?.effort ?? args.effort ?? current.reasoningEffort;
      let effort: string | undefined;
      if (requested !== undefined) {
        const hit = matchEffort(efforts, requested);
        if (hit !== undefined) {
          effort = hit;
        } else {
          effort = efforts?.[0]?.id;
          ctx.self.notice(
            `startup effort "${requested}" not available for ${provider}/${model}; using ${effort ?? "default"}`,
            "warn",
          );
        }
      }
      await ctx.self.applyModelSelection({
        provider,
        model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      });
    } catch (err) {
      ctx.self.notice("startup model failed: " + String(err), "error");
    }
  }

  return {
    handleModelCommand,
    handleProviderSwitch,
    handleEffortSwitch,
    handleModelFocus,
    applyStartupModel,
  };
}
