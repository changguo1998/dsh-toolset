# 文档与注释标准检查器

> 定位: `dev/` 下的开发期辅助工具, 只用 Node 标准库, 不参与构建与发布。规则口径来自 `AGENTS.md`「符号规范」与 `docs/GLOSSARY.md`。

## 用法

```sh
pnpm run check:docs          # 报告全部命中, 有「错误」时退出 1
pnpm run check:docs:strict   # 警告也算失败（清理存量与专项验收用）
node dev/standard/index.mjs --all            # 打印全部命中, 不按规则截断
node dev/standard/index.mjs --rule term.interface   # 只看一条规则, 有命中即退出 1
```

检查器只报不改: 命中按 `文件:行` 与一句话原因打印, 修由人做。

## 规则

| 规则 id | 严重度 | 查什么 | 范围 |
| --- | --- | --- | --- |
| `symbol.variant` | 错误 | 20 条变体映射（`✔` → `✓` 等） | Markdown 正文、`.ts` 注释 |
| `symbol.emoji` | 错误 | 36 个白名单符号之外的 emoji | 同上 |
| `term.replace` | 错误 | `docs/GLOSSARY.md`「需要替换」表的条件型以外旧称 | 现行 Markdown |
| `term.interface` | 错误 | 界面旧称（`活动区` / `历史区` / `状态栏` 等），与 `term.replace` 同表同规则 | 同上 |
| `count.packages` / `count.plugins` | 错误 | 「本仓 N 个包」「N 个包（TUI 与 M 个插件）」的数量断言 | 同上 |
| `link.file` | 错误 | 相对链接的目标文件是否存在 | Markdown |
| `link.anchor` | 警告 | `#锚点` 与目标文件的标题 slug 是否对得上 | Markdown |
| `table.columns` | 错误 | 表格表头与数据行的列数是否一致 | Markdown |
| `comment.path-shorthand` | 错误 | `.ts` 注释里 `src/...` 这类包内简写路径 | `.ts` 注释 |
| `comment.path-missing` | 错误 | 注释里从仓库根算起的路径是否存在 | 同上 |
| `pkg.structure` | 错误 | `package.json` 的 `main` / `types` 配套与源文件、`files` / `dsh.bundle.patch` 路径 | 各包 |
| `tsconfig.structure` | 错误 | `extends` / `include` / `exclude` 路径与 4 个基线编译选项 | 各包 |

## 范围与豁免

- 不查归档: `archive/`、`*/docs/archived/`、`*/docs/implementation/` 一律跳过（归档不按现行规范改写）。
- 不查依赖与产物: `node_modules`、`dist`、`tmp` 与以 `.` 开头的目录。
- `docs/host/` 只查符号, 不查术语、数量与链接（`AGENTS.md` 定该目录不参与变更流程）。
- `docs/STATUS.md`（用户择时更新）与 `docs/ARCHITECTURE-REUSE.md`（审计快照）不查术语与数量。
- 行内代码、围栏代码块、链接地址、HTML 注释与 front matter 里的字符不参与检查。
- 讨论字符本身的句子（含 `U+`、`码点`、`字符`)不按符号规范判；符号表源码（`symbol-normalizer/src/`、`TUI/src/app/layout/markdown.ts`、`TUI/scripts/gen-width-table.mts`）与各包 `tests/` 整文件豁免。
- 带「原名」「旧称」「历史对照」的行允许引用旧称。
- 「模块」「工具集」「收口」属条件型术语，检查器不自动判定（`AGENTS.md` 与 `docs/GLOSSARY.md` 有条件说明）。

## 存量与严重度

警告档只余 `link.anchor`. `.ts` 注释的简写路径与失效路径已于 2026-11-04 清零（实测 587 + 60, 规则已改为错误档); 界面旧称已于 2026-11-03 清零. `pnpm run check` 侧即可当门禁用.
