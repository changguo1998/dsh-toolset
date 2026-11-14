# AGENTS.md 瘦身整理（接取条目: docs/BACKLOG.md「AGENTS.md 瘦身整理」）

状态: 已完成　开启: 2026-11-14　关闭: 2026-11-14
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

项目根 `AGENTS.md`（108 行）面向 agent 但混入大量查用型内容。把「每次会话必须遵守的行为规则」留在 `AGENTS.md`, 把「用到才查」的命令 / 安装 / 部署 / 包清单外移到独立文档, 由 README 文档索引统一收录。

## 方案（已获用户确认）

- `AGENTS.md` 精简到约 60 行: 保留定位与文档分工、语言约定（含符号规范与术语口径）、常用命令（check / build / test / test:tui / check:docs 各一行）、格式化、变更流程、内容变更规范（简版, 全文保留）、文档与结构约定（压缩为指针行）、Git。
- 新建 `docs/DEVELOPMENT.md`: 命令全量（含 test:tui 过滤、单包子包命令、bench / smoke:pty）、一键安装、agent 面组合口径、构建 → 部署到 profile 全节。
- 新建 `docs/PACKAGES.md`: 39 包逐包一句话职责（中文, 来源 AGENTS.md 原「结构与约定」插件段）+ TUI 目录要点 + `DESIGN.md` 轻重包口径。
- 根 `README.md` / `README.zh.md` 同步: Documentation 索引补两个新文件, 涉及 AGENTS.md 的描述行与指向 `AGENTS.md` 的命令指针更新。

## 计划改动文件清单

1. `docs/AGENTS.md` — 重写（瘦身）
2. `docs/DEVELOPMENT.md` — 新建（命令 / 安装 / 部署手册）
3. `docs/PACKAGES.md` — 新建（包清单与职责）
4. `docs/backlog.md` 已登记条目（本任务自身, 关闭时移入 §1）
5. `docs/implementation/2026-11-14-agents-md-reorg.md` — 本追踪文档（关闭时归档）
6. `docs/BACKLOG.md` — 条目管理（进行中标记）
7. `README.md` / `README.zh.md` — Documentation 索引与相关行同步

不改: 各包 README、`docs/host/`、其余项目级文档正文。

## 验证

- 实做: AGENTS.md 重写（108 → 62 行）; 新建 `docs/DEVELOPMENT.md`（48 行）与 `docs/PACKAGES.md`（58 行, 38 插件全量覆盖）; README / README.zh.md 双侧同构同步（目录树、文档索引、命令指针、AGENTS.md 描述行）。
- `format` 后自查 diff: AGENTS.md 只删不减（全部行为规则保留, 外移内容完整落在两个新文件）。
- `pnpm run check:docs` 通过: 122 篇 Markdown / 970 个 .ts, 0 错误 0 警告（原 120 篇, +2 新文档）。
- 提交: 实现 `8bf32c69`; 本次为最终关闭提交。

## 收尾

- BACKLOG 条目移入 §1 已完成索引（关闭提交）; 本追踪文档移入 `docs/archived/`。
- 遗留: 无。
