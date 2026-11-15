# 从项目移除 ponytail 包（实施追踪）

接取条目：`docs/BACKLOG.md` §2「ponytail e2e 用例已过期」（2026-11-15 接取, 解法为用户裁定「项目整体移除 ponytail」）。

## 计划改动文件清单

1. 删除：`ponytail/`（整包目录）、`e2e/ponytail.test.ts`
2. 计数口径同步（42 包 → 41 包 / 41 插件 → 40 插件）：
   - `AGENTS.md`（首段、术语行、结构行）
   - `README.md` + `README.zh.md`（双侧同构：插件表、目录树、DESIGN 列表、安装与索引节）
   - `docs/DEVELOPMENT.md`、`docs/PACKAGES.md`、`docs/ROADMAP.md`、`docs/WORKFLOW-STANDARD.md`
   - `md-logic/README.md`、`security-guard/README.md`
   - `dev/standard/index.mjs`（`checkCounts` 硬编码 42/41 → 41/40）
   - `scripts/test-install.sh`（第 608 行断言 42 → 41）
3. 脚本清理：`scripts/install.sh`（`canonical_pkgs`）、`scripts/test-parallel.sh`（`default_pkgs`）、
   `scripts/test-install.sh`（夹具 `--plugins "TUI ponytail"` 换 `term-check`, 相关断言同步）、
   `scripts/audit-injection-channels.sh`（T4 段删除, 循环/过滤列表移除 ponytail）
4. Profile：`profiles/example/cordis.patch.yml`（ponytail 停挂块删除）、`profiles/README.md`（id 示例替换）
5. 引用文档：`docs/ARCHITECTURE-REUSE.md`（总表行、计数、服务图）、`preference-analysis/README.md`、
   `docs/BACKLOG.md`（第 3 条收尾清理）
6. 调研文档：`docs/ponytail-investigation.md` → 移入 `archive/` 保留（用户裁定）
7. 不动（确认非包引用）：`ponytail:` 注释（TUI 三文件 / memory-base / security-guard / rule-engine / e2e/harness.ts, 「最懒解」理念, 非包引用）、
   全部 archived 历史文档与 `docs/STATUS.md`（按流程由用户择时更新, 收尾提醒）。

## 推进记录

2026-11-15：按计划清单实施完毕, 全部验证通过（明细见下）。过程中两处与计划偏差, 均已在实施时处理:

- `docs/BACKLOG.md` 第 3 条接取时补注解法（用户裁定整体移除 ponytail）。
- test-install.sh 第 11 步比对脚本本体硬编码 42（不只断言文案）, 首轮 test-install 1 项失败后修复（`canon.length` / `dirs.length` 判 41）, 重跑 124 项全通过。

## 验证与证据

- `pnpm run check`：全仓类型检查通过（40 个插件 + TUI, 无 ponytail 残留引用）。
- `pnpm run build`：全仓构建通过（产物性验证）。
- `pnpm run test`：全仓测试通过（各包 pass / fail 0）。
- `pnpm run test:e2e`：43/43 全绿（原 43/44, ponytail e2e 删除后满绿, 唯一红灯消除）。
- `pnpm run check:docs`：通过（122 篇现行 Markdown / 1002 个 .ts, 错误 0 / 警告 0; dev/standard 的 41 包 / 40 插件校验与全部文档一致）。
- `scripts/test-install.sh`：124 项全部通过（含「canonical_pkgs 与仓库包目录一致且为 41 个包」「示例资产默认停挂官方 plan-mode」等替换断言）。
- 四个 shell 脚本 `bash -n` 语法检查通过。

## 收尾

- 本追踪文档关闭, 移入 `docs/archived/2026-11-15-ponytail-removal.md`。
- BACKLOG：§2「ponytail e2e 用例已过期」随包移除而关闭并从清单清理, §1 加完成索引行。
- 残留（按流程不动, 由用户择时）: `docs/STATUS.md` 含 ponytail 行与 42 包计数口径, 待用户更新。
- 历史注记按计划保留: `docs/ARCHITECTURE-REUSE.md` 头部的移除注记、`docs/BACKLOG.md` §1 的 11-13 / 11-14 完成索引、`TUI/docs/DESIGN.md` 的 2026-10-05 历史正文, 以及各源码里的 `ponytail:` 编程理念注释（非包引用）。
