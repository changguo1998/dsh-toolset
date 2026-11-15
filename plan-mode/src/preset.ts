/**
 * plan-mode/src/preset.ts — 权限预设切换与恢复（决策项 8 / 10）。
 *
 * 全部为纯函数 / 面向注入服务面，不直接依赖宿主，最大可测。宿主服务面
 * `ctx.get("permissionPresets")` 的结构子集见 PresetsService；`current` / `set`
 * 都按 Session 读写（多会话各切各的）。
 *
 * 口径：
 * - 进入（决策项 8a）：`names` 里有 `read-only` → 记原值再切只读。三降级：
 *   服务缺席 / 预设名不含 `read-only` / 原值 `custom`（切了恢复不回去）/
 *   `set` 抛错 —— 一律不动预设、只告警，靠本仓拦截兜底。
 * - 二次进入（决策项 10a）：会话已有映射沿用首次原预设，只更新帧 id；
 *   上棵已恢复过时用同一份原预设再切一次只读。
 * - 恢复：`restored` 标记挡重复触发；覆盖保护——用户手动改过则不覆盖。
 */

/** 宿主 permission-presets 服务面的最小形态（current / set 均按 Session）。 */
export interface PresetsService {
  /** 可切换的预设名（含 read-only）。 */
  readonly names: readonly string[];
  /** 当前生效的预设名（旋钮不匹配任何预设时为 "custom"）。 */
  current(session: unknown): string;
  /** 切到某预设；未知名抛错。 */
  set(session: unknown, name: string): void;
}

export interface PresetSwitchResult {
  presetSwitched: boolean;
  presetNote?: string;
  /** 切成功时记原预设；降级时缺失。 */
  originalPreset?: string;
}

export interface RestoreResult {
  /** 是否真的执行了 set（降级 / 已恢复 / 手改过为 false）。 */
  applied: boolean;
  note?: string;
}

/** 首次进入：切只读并记原预设（决策项 8a）。降级不动预设、不阻断。 */
export function switchToReadonly(
  service: PresetsService | undefined,
  session: unknown,
): PresetSwitchResult {
  if (service === undefined) {
    return { presetSwitched: false, presetNote: "权限预设服务缺席, 未切换" };
  }
  if (!service.names.includes("read-only")) {
    return {
      presetSwitched: false,
      presetNote: "预设名不含 read-only, 未切换",
    };
  }
  let original: string;
  try {
    original = service.current(session);
  } catch (error) {
    return {
      presetSwitched: false,
      presetNote: `读取当前预设失败: ${String(error)}`,
    };
  }
  if (original === "custom") {
    return {
      presetSwitched: false,
      presetNote: "原预设为 custom, 切了恢复不回去, 未切换",
    };
  }
  try {
    service.set(session, "read-only");
  } catch (error) {
    return {
      presetSwitched: false,
      presetNote: `切 read-only 失败: ${String(error)}`,
    };
  }
  return { presetSwitched: true, originalPreset: original };
}

/** 进入 / 二次进入的统一决策（决策项 10a）。 */
export function enterPlanPreset(
  service: PresetsService | undefined,
  session: unknown,
  existing:
    | { readonly originalPreset?: string; readonly restored: boolean }
    | undefined,
): PresetSwitchResult {
  if (existing === undefined) return switchToReadonly(service, session);
  // 二次进入且上棵已恢复：沿用同一份原预设再切一次只读（标记复位由调用方做）
  if (existing.restored && existing.originalPreset !== undefined) {
    try {
      service?.set(session, "read-only");
    } catch (error) {
      return {
        presetSwitched: false,
        presetNote: `重新切只读失败: ${String(error)}`,
      };
    }
    return {
      presetSwitched: true,
      presetNote: "二次进入沿用原预设并重新切只读",
    };
  }
  // 二次进入且上棵还没恢复（树仍在进行中）：预设仍是只读, 不动
  return { presetSwitched: false };
}

/** 恢复预设（`restored` 标记挡重复触发；覆盖保护：用户手改过则不覆盖）。 */
export function restorePreset(
  service: PresetsService | undefined,
  session: unknown,
  originalPreset: string | undefined,
  restored: boolean,
): RestoreResult {
  if (restored) return { applied: false };
  if (originalPreset === undefined) {
    // 进入时已降级：不碰预设、不重复告警，只清理
    return { applied: false };
  }
  if (service === undefined) {
    return { applied: false, note: "权限预设服务缺席, 无法恢复" };
  }
  let current: string;
  try {
    current = service.current(session);
  } catch (error) {
    return { applied: false, note: `读取当前预设失败: ${String(error)}` };
  }
  if (current !== "read-only") {
    // 用户手动改过：跳过 set、不拿旧值覆盖，只清标记并告警一次
    return { applied: false, note: "预设被手动改过, 跳过恢复" };
  }
  try {
    service.set(session, originalPreset);
  } catch (error) {
    return { applied: false, note: `恢复预设失败: ${String(error)}` };
  }
  return { applied: true };
}
