// src/app/model-transition.ts — 模型选择面板纯状态转换（无副作用）
//
// 自 App（index.ts）拆出：面板初始构建（buildPickerInit）、思考等级预设索引
// （pickerEffortIndex）、各列选中值解析（resolvePickerSelection）、切换决策
// （planModelSwitch）。modelCatalog()/modelEfforts()/setSessionModel() 等异步
// 调用、apply/paint/notice 仍由 App 执行，副作用顺序与原实现一致。

import type { PickerState } from "./state.ts";
import type { ModelCatalog, ModelSelection } from "./adapter/dsh.ts";

/** 面板初始构建结果：empty = 无可用模型（App 提示后不打开）；open = picker-open 载荷 */
export type PickerInit = { ok: false } | { ok: true; picker: PickerState };

/**
 * 由模型目录构建选择面板初始状态：
 * - provider 列：去重（当前 provider 恒首位，可能不在 catalog.providers 中）
 * - 每个 provider 的模型列表：去重（当前模型恒首位，可能不在目录中）
 * - model 列初始 = 首位 provider 的模型列表
 * - 初始选中 = 当前生效值（打开面板 Enter 不改模型）
 */
export function buildPickerInit(catalog: ModelCatalog): PickerInit {
  const current = catalog.current;
  // provider 列：去重（当前 provider 恒首位，可能不在 catalog.providers 中）
  const providers: string[] = [];
  const pushProvider = (p: string | undefined) => {
    if (p && !providers.includes(p)) providers.push(p);
  };
  pushProvider(current?.provider);
  for (const pr of catalog.providers) pushProvider(pr.provider);
  for (const m of catalog.models) pushProvider(m.provider);
  // 每个 provider 的模型列表（去重；当前模型恒首位，可能不在目录中）
  const providerModels: Record<string, string[]> = {};
  const pushModel = (p: string | undefined, id: string | undefined) => {
    if (!p || !id) return;
    const list = providerModels[p] ?? (providerModels[p] = []);
    if (!list.includes(id)) list.push(id);
  };
  pushModel(current?.provider, current?.model);
  for (const m of catalog.models) pushModel(m.provider, m.id);
  const models = providerModels[providers[0]!] ?? [];
  if (models.length === 0) return { ok: false };
  return {
    ok: true,
    picker: {
      providers,
      providerIndex: 0,
      providerModels,
      models,
      modelIndex: 0,
      efforts: [],
      effortIndex: 0,
      phase: 0,
      // 初始选中 = 当前生效值（打开面板 Enter 不改模型）
      selectedProvider: current?.provider,
      selectedModel: current?.model,
      selectedEffort: current?.reasoningEffort,
      current:
        current?.provider && current?.model
          ? {
              provider: current.provider,
              model: current.model,
              reasoningEffort: current.reasoningEffort,
            }
          : undefined,
    },
  };
}

/**
 * 思考等级加载完成后的预设高亮索引：当前生效模型自带等级时，
 * 预设为列表中同一等级（未命中回退第一项）；否则默认第一项。
 */
export function pickerEffortIndex(
  picker: PickerState,
  model: string,
  provider: string | undefined,
  efforts: { id: string; name: string }[] | undefined,
): number {
  // 当前生效模型自带等级时，预设为列表中同一等级（其余默认第一项）
  const onCurrent =
    picker.current &&
    picker.current.model === model &&
    picker.current.provider === (provider ?? "");
  const wantIdx =
    onCurrent && picker.current?.reasoningEffort
      ? (efforts?.findIndex((e) => e.id === picker.current!.reasoningEffort) ??
        -1)
      : -1;
  return wantIdx >= 0 ? wantIdx : 0;
}

/**
 * 解析面板各列选中值（星号所指，回退焦点位置）为待应用的 ModelSelection；
 * provider/model 缺失返回 undefined（App 仅关闭面板不切换）。
 * 无等级可选 → 不带 reasoningEffort。
 */
export function resolvePickerSelection(
  picker: PickerState,
): ModelSelection | undefined {
  const provider =
    picker.selectedProvider ?? picker.providers[picker.providerIndex];
  const model = picker.selectedModel ?? picker.models[picker.modelIndex];
  if (!provider || !model) return undefined;
  const effort = picker.selectedEffort
    ? picker.efforts.find((e) => e.id === picker.selectedEffort)
    : picker.efforts[picker.effortIndex];
  const selection: ModelSelection = { provider, model };
  if (effort) selection.reasoningEffort = effort.id; // 无等级可选 → 不带 effort
  return selection;
}

/** 模型切换决策：same = 已是当前模型+等级（App 提示后返回）；否则给出待应用的 selection */
export type ModelSwitchPlan =
  { same: true } | { same: false; selection: ModelSelection };

/**
 * 面板已显式选了等级时用面板选择，否则沿用当前模型的等级（/model <id> 路径）。
 * 目标与当前 provider/model/等级全同 → same（App 提示 already on current model）。
 */
export function planModelSwitch(
  selection: ModelSelection,
  cur: ModelSelection | undefined,
): ModelSwitchPlan {
  const effort = selection.reasoningEffort ?? cur?.reasoningEffort;
  if (
    cur &&
    cur.provider === selection.provider &&
    cur.model === selection.model &&
    (cur.reasoningEffort ?? "") === (effort ?? "")
  ) {
    return { same: true };
  }
  return {
    same: false,
    selection: effort ? { ...selection, reasoningEffort: effort } : selection,
  };
}
