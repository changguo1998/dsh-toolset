# rule-engine 待办

> 职责：rule-engine 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、引擎契约与规则表（见 `rule-engine/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `rule-engine/docs/archived/`，不在此重复。
> 组织：单一「待办」区（按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）原因 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办

### 1. 工具描述（模型可见文案）与实现口径不一致

- **现状**：`src/tools.ts` 的 `MATCH_SCHEMA.description` 写「缺省仅对 turn-end 表示无条件命中」，`summary` 参数描述写「宿主 notice 呈现用，缺省取正文首行截断」。
- **期望**：与 `README.md`「匹配面 / 注入消息」一致——`match` 缺省时**边界类节点（无文本）无条件命中**；`summary` 是**元数据**（呈现面用，且是 `dedupeInRecord` 的计数键）。
- **落点**：`rule-engine/src/tools.ts`（属模型可见字符串 / 行为面文案，按代码改动流程走，不能当纯注释改）。
- **验收**：`npm --prefix rule-engine run check` 与单测全绿；描述文案与 README 逐句一致。
- **来源·状态·优先级**：2026-10-04 文档刷新（子代理报告）；未接取；P3。
