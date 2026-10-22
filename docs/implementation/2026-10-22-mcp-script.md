# MCP 脚本化（mcpScript）（接取条目：`docs/BACKLOG.md` §2「6. MCP 脚本化（mcpScript）」）

状态：进行中（仅接取：本文档已建，调研未开始；**形态未定，允许结论为「不新建包」**）　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

**协作约定（2026-10-23）**: 本包可**写自己包目录内的代码与文档**（含包内 `docs/`），以及**自己的追踪文档**；共享文档（两级 BACKLOG、`TUI/docs/SPEC.md`、两份 README、`COMMANDS*.md`）与根级接线（根 `package.json`、`AGENTS.md`、`profiles/example/cordis.patch.yml`、用户 profile）**只由主分支代理回写**，见项目级 `docs/BACKLOG.md` §2「7. 共享文档与根级接线」。

## 目标

补齐「MCP 脚本化」的**设计**并据其结果决定是否落地：默认假设是让模型以脚本方式一次编排多步 MCP 调用（工具或资源），回传结构化结果，而不是逐个工具往返。

本阶段交付以设计文档为主：目标场景、与 `script-interpreter` 的边界（扩展它 vs 新包）、是否需要挂 `dsh-mcp-client`、凭据与权限边界、失败与超时语义。

边界：不实现 MCP server 端；不改宿主 `mcp-resources` 的既有行为；若评估后不成立，本条目的结论就是「不立项」并记录理由。

## 调研

（待填；现状：宿主有 `dsh-mcp-client`（未挂）与 `dsh-mcp-resources`（base 已挂，`dsh-base/cordis.patch.yml:492-493`），仓内无 MCP 代码）

## 决策

（待填；若定为新包，届时在包目录内建追踪文档并把本文件移入；若定为扩展 `script-interpreter`，落点改到该包）

## 规划

### 计划改动文件清单

（待设计定稿）

### 验收

（待设计定稿）
