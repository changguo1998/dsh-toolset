# 任务：output-compress

> 本文件为 herdr worktree 任务契约。**只允许修改本 worktree 的 `output-compress/` 目录内文件**（pre-commit 钩子强制，其他目录/根文件的提交会被拒绝）。

## 目标

实现大输出压缩入库：把超大命令/工具输出在沙箱内派生结构化摘要并自动索引入库，原始字节不进入模型上下文（确定性压缩，非 LLM 抽取）。

## 来源

`docs/DEVELOPMENT-BACKLOG.md` #11（context-mode 拆项 4 + hypa 拆项 1）：大输出压缩入库；dsh 侧 `output-retention` + `spill` 只保留/落盘，**不做摘要入库**。

## 复用底座（不新建）

- `code-runtime`：沙箱执行（派生摘要代码）
- `output-retention` / `spill`：输出保留与落盘（扩展为「摘要入库」）
- **写入走 knowledge-base 接口**（经宿主 context 的 `ctx_knowledge`，**不做 npm 级互相依赖**）——宿主进程内同时挂 `knowledge-base` bundle 即可
- 参考主仓 `knowledge-base/` 插件模板（`dsh.bundle` + `cordis.patch.yml` + `src/` + `tests/` + `smoke/`）

## 接口对齐

`DSH-CTX-API.md`（0.1.5-rc.2 契约）+ 词汇表。语义：

- 超阈值输出触发 → 沙箱内确定性派生摘要（如行数/字节统计、section 标题、top-N 关键行、结构化切片索引）
- 原始输出保留（retention/spill），摘要 + 切片索引入知识库（`ctx_knowledge.put`）
- 后续检索可从知识库召回切片，原始字节不回填上下文

## 交付物（均在 `output-compress/` 下）

- `output-compress/package.json`（含 `dsh.bundle` 键）+ `cordis.patch.yml`
- `output-compress/src/`：阈值判定、沙箱派生摘要、知识库写入、retention/spill 衔接 + DSH bundle 接入面
- `output-compress/tests/*.test.ts`：阈值触发、摘要确定性（同输入同输出）、切片索引、知识库写入（mock 或真实）
- `output-compress/smoke/smoke.mjs`：真实 dsh 会话验证「大输出→摘要入库→检索召回」

## 完成门槛

1. `npm --prefix output-compress run check`（tsc --noEmit 严格）通过
1. `npm --prefix output-compress run test` 全绿（node --test）
1. `npm --prefix output-compress run build` 产出 `dist/`
1. 改动文件执行 `format <文件...>`
1. 独立 profile `~/.dsh/profiles/dsh-output-compress`（`link:` 指向本 worktree，**需同挂 knowledge-base bundle**）+ smoke 通过 + 人工确认

## 硬约束

- 只改 `output-compress/` 目录；其余目录与根文件一律禁止改动
- 提交仅限本 worktree 的 `feat/output-compress` 分支；不 merge main、不 push
- 与 knowledge-base 只经宿主 context 通信，**不引入 npm 依赖**
- 不实现任务未提及的额外功能；代码注释中文、标识符英文
