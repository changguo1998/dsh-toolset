// src/app/adapter/types/model.ts — 模型目录 / 选择 / 用量

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  description?: string;
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** 模型推理元数据（状态栏/面板展示用，不触发请求）：
 *  efforts = 可选思考等级；defaultEffort = provider 配置的默认等级（请求未显式指定时实际生效值） */
export interface ModelReasoning {
  efforts?: { id: string; name: string }[] | undefined;
  defaultEffort?: string | undefined;
}

/** 会话级模型选择引用：current 应用于下一 step；assembled 为当前 step 组装时的快照 */
export interface SessionModelSelectionRef {
  current: ModelSelection | undefined;
  assembled?: ModelSelection | undefined;
}

export interface ModelCatalog {
  providers: { provider: string; name?: string }[];
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
