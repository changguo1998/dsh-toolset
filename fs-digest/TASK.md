# 任务：fs-digest

> 本文件为 herdr worktree 任务契约。**只允许修改本 worktree 的 `fs-digest/` 目录内文件**（pre-commit 钩子强制，其他目录/根文件的提交会被拒绝）。

## 目标

实现上下文感知文件读取工具：`outline`（章节/符号大纲）/ `signatures`（函数签名）/ `pruned`（按 token/行裁剪）三种模式，在大文件读取时只把结构化摘要或裁剪片段送进上下文，节省 token。

## 来源

`docs/DEVELOPMENT-BACKLOG.md` #12（hypa 拆项 2）：上下文感知文件读取 outline/signatures/pruned；dsh 侧 `tool-fs` + `tool-lsp` 有基础但不含这些读取模式。

## 复用底座（不新建）

- `tool-fs`：文件读取底座（裁剪模式）
- `tool-lsp`：符号/签名数据来源（outline/signatures 模式）
- 参考主仓 `knowledge-base/` 插件模板（`dsh.bundle` + `cordis.patch.yml` + `src/` + `tests/`）

## 接口对齐

`DSH-CTX-API.md`（0.1.5-rc.2 契约）+ 词汇表。三种模式语义：

- `outline`：返回章节/顶层符号结构（深度可调），不返回正文
- `signatures`：返回函数/方法签名列表（参数、返回类型）
- `pruned`：按行数/字节上限返回头部+尾部线索（可仿 hypa 思路：智能裁剪而非硬截断）

## 交付物（均在 `fs-digest/` 下）

- `fs-digest/package.json`（含 `dsh.bundle` 键）+ `cordis.patch.yml`
- `fs-digest/src/`：三模式核心逻辑 + DSH bundle 接入面；LSP 不可用时 outline/signatures 降级（如正则/启发式或明确报错）
- `fs-digest/tests/*.test.ts`：各模式输出结构、大文件 pruned 上限、降级路径

## 完成门槛

1. `npm --prefix fs-digest run check`（tsc --noEmit 严格）通过
2. `npm --prefix fs-digest run test` 全绿（node --test）
3. `npm --prefix fs-digest run build` 产出 `dist/`
4. 改动文件执行 `format <文件...>`
5. 附可运行检查样例（outline + pruned 各一例）

## 硬约束

- 只改 `fs-digest/` 目录；其余目录与根文件一律禁止改动
- 提交仅限本 worktree 的 `feat/fs-digest` 分支；不 merge main、不 push
- 不装全仓依赖，自包依赖按需最小
- 不实现任务未提及的额外功能；代码注释中文、标识符英文
