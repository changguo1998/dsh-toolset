# 工具咨询插件：按需揭示工具（接取条目：`docs/BACKLOG.md` §2「5. 工具咨询插件…」）

状态：进行中（仅接取：本文档已建，调研未开始；条目原「设计未定稿」状态保留）　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

**协作约定（2026-10-23）**: 本包可**写自己包目录内的代码与文档**（含包内 `docs/`），以及**自己的追踪文档**；共享文档（两级 BACKLOG、`TUI/docs/SPEC.md`、两份 README、`COMMANDS*.md`）与根级接线（根 `package.json`、`AGENTS.md`、`profiles/example/cordis.patch.yml`、用户 profile）**只由主分支代理回写**，见项目级 `docs/BACKLOG.md` §2「7. 共享文档与根级接线」。

## 目标

新增插件 `tool-consult`：模型用自然语言描述「我要做什么」，插件返回**匹配的工具**（名称 + 一句话简述），并让该工具对当前会话可见；咨询工具自身常驻可见（own-layer 注册，豁免 `tools.restrict`）。

要解决的问题是工具面全量暴露：模型需记住大量工具名、且这些描述全程占用上下文。交付物是一层按需揭示：遮罩（`tools.restrict`）+ 单条活动 mask 替换揭示 + 匹配索引。

边界：不改动其它工具的行为与描述；不做工具自动收回之外的策略（收回语义待定稿）；不引入外部服务依赖（匹配先用本地索引 / 关键词，语义匹配另议）。

## 调研

（待填）

## 决策

（待填；待定项：初始可见集、匹配方式（关键词索引 vs LLM 语义）、揭示与收回语义）

## 规划

### 计划改动文件清单

（初判，调研后定稿；本包从零创建）

- `tool-consult/package.json`（`dsh.bundle` 契约）、`tool-consult/cordis.patch.yml`
- `tool-consult/src/main.ts`（own-layer 注册豁免 `tools.restrict`）、索引与匹配、`tools.restrict` 遮罩 + 单条 mask 揭示
- `tool-consult/README.md`、必要时 `tool-consult/docs/DESIGN.md`
- 根 `package.json` 脚本链、`AGENTS.md`、根 README 双侧、profile 挂载 —— **不属本包写入范围，由主分支代理承接**（项目级 §2「7. 共享文档与根级接线」）

### 验收

（待填；须先定设计）
