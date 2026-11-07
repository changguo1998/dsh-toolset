// TUI/src/app/adapter/types/model.ts — 模型目录 / 选择 / 用量

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  description?: string | undefined;
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string | undefined;
}

/** 模型推理元数据（状态行/面板展示用，不触发请求）：
 *  efforts = 可选思考等级；defaultEffort = provider 配置的默认等级（请求未显式指定时实际生效值） */
export interface ModelReasoning {
  efforts?: { id: string; name: string }[] | undefined;
  defaultEffort?: string | undefined;
}

/** 会话级模型选择引用：current 是用户选择（显示与目录兜底用；请求路由由宿主 `agent.model.select()` 承担） */
export interface SessionModelSelectionRef {
  current: ModelSelection | undefined;
}

export interface ModelCatalog {
  providers: { provider: string; name?: string | undefined }[];
  models: ModelInfo[];
  current: ModelSelection | undefined;
}

/** 单次模型调用的 token 用量（assistant/message.usage 载荷；cache 字段可选） */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
