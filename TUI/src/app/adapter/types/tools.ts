// TUI/src/app/adapter/types/tools.ts — 工具 / 设置 / 配置编辑面

/** 宿主工具 schema 结构面（dsh-llm ToolSchema 子集） */
export interface ToolSchemaLike {
  name: string;
  description?: string;
}

/** 宿主 ScopeKey 的 TUI 侧形态：对 TUI 不透明（不读任何字段），默认省略即全局视图。 */
export type ScopeKeyLike = Record<string, unknown>;

/** 宿主 tools 服务结构面（ctx.get('tools')，@deepseek-ai/dsh-tools）；
 *  `schemas()` 省略 scope = 全局视图（已核实：peek/chainLayers 对 undefined 返回空叠加）。
 *  `register()` 在调用方作用域注册工具（返回注销器）——TUI 用它注册模型侧工具
 *  `tui_local_log`（见 app/adapter/local-log-tool.ts）。 */
export interface ToolsLike {
  schemas?(scope?: ScopeKeyLike): readonly ToolSchemaLike[];
  get?(name: string, scope?: ScopeKeyLike): Record<string, unknown> | undefined;
  register?(definition: unknown): () => void;
}

/** 宿主设置描述符结构面（dsh-settings SettingsDescriptor 子集：:50-73，含 ns/value/revision） */
export interface SettingsDescriptorLike {
  ns: string;
  value?: unknown;
  revision?: number | string;
  base?: unknown;
  user?: unknown;
  applies?: unknown;
  /** role('secret') 字段名列表；非空时该 ns 的 value 不应明文展示 */
  secrets?: readonly string[];
}

/** 宿主设置服务结构面（ctx.get('settings')，dsh-settings SettingsProvider；
 *  /settings 为只读展示：describe() 一次枚举 ns + 当前值，不做写回。
 *  首版输出仅用 describe()；get(ns) 单读未接入（宿主返回 unknown，
 *  需在接入时定义域类型后再暴露）。 */
export interface SettingsLike {
  describe?(options?: {
    redactSecrets?: boolean;
  }): readonly SettingsDescriptorLike[];
}

/** 宿主 `config-editor` 服务里一个可编辑条目的原始形态（`Entry` 的 TUI 侧宽松子集）：
 *  官方只把 profile 直属、id 唯一的行放进 `entries()`，故 `options.id` 恒有。 */
export interface ConfigEditorEntryLike {
  options?: { id?: string; name?: string; config?: Record<string, unknown> };
}

/** `configEditor.configuration()` 的一行：`inherited` 为去掉本行 override 后的组合值，
 *  `override` 为本行 patch 里的显式值（官方均为 detached 拷贝）。 */
export interface ConfigEditorRowLike {
  entry: ConfigEditorEntryLike;
  inherited?: Record<string, unknown>;
  override?: Record<string, unknown>;
}

/** 宿主配置编辑服务结构面（ctx.get('configEditor')，@deepseek-ai/dsh-config-editor）：
 *  写面 `edit(entry, change)` 内部完成校验 / 原子写 profile patch / 与 HMR 串行 / 失败回滚，
 *  TUI 只经它改写条目 config，不直接碰 YAML。 */
export interface ConfigEditorLike {
  entries?(): readonly ConfigEditorEntryLike[];
  configuration?(): readonly ConfigEditorRowLike[];
  edit?(
    entry: ConfigEditorEntryLike,
    change: (
      current: Record<string, unknown>,
      inherited: Record<string, unknown>,
    ) => Record<string, unknown>,
  ): Promise<void>;
}

/** 一个可编辑条目的纯数据快照（adapter → App；不含 Loader 对象，避免复用陈旧 Entry） */
export interface ConfigEntrySummary {
  id: string;
  name: string;
  inherited: Record<string, unknown>;
  override: Record<string, unknown>;
}
