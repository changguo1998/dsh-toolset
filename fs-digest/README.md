# @dsh-toolset/fs-digest

DSH（DeepSeek Harness）进程内插件：上下文感知文件读取。注册工具 `fs_digest`，按文件类型与读取意图返回最小充分上下文，替代整文件 `read`；只读，不改文件。

## 能力

| mode | 返回 | 选项 |
| --- | --- | --- |
| `outline` | 章节/符号层级树（1 基行号）；**Markdown 额外给每节行范围与块级结构清单** | `depth`（默认 3，≥1；Markdown = 最大标题级，同时决定行范围与块归属的分辨率） |
| `signatures` | 函数/方法/构造器签名（1 基行号） | — |
| `pruned` | 大文件头尾裁剪正文（头部约 2/3、尾部约 1/3，中间一行省略标记） | `maxLines`（默认 200，≥2）、`maxTokens`（默认 4000，≥2，按 4 字符/token 估算） |

工具参数：`path` 与 `mode` 必填；`depth`、`maxLines`、`maxTokens` 为整数（范围见上表）；`language` 为语言提示（`markdown` / `typescript` / `python`，缺省按扩展名推断）；`requireLsp` 为 true 时 LSP 不可用直接报 `lsp_unavailable`，不降级。

结果 `source` 标注实际来源：`lsp` / `heuristic` / `markdown`。渲染上限：outline 标题树 45 行 + 块清单 15 行（**两个预算独立**，大文档不会因树满而丢掉块清单）、signatures 60 条、pruned 展示 80 行，超出各自以省略行收尾。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxBytes` | `2097152`（2MB） | 文件尺寸上限，超出返回 `too_large` |

bundle 契约：`name` / `inject: ["tools"]` / `Config` / `apply`；`ctx.tools` 不可用时静默跳过注册。

## 使用示例

```jsonc
{ "path": "src/digest.ts", "mode": "outline", "depth": 2 }
{ "path": "src/main.ts", "mode": "signatures" }
{ "path": "big.log", "mode": "pruned", "maxLines": 80, "maxTokens": 2000 }
{ "path": "src/code.ts", "mode": "outline", "requireLsp": true }
```

Markdown 的 `outline` 输出形如（标题带节行范围，块清单带所属节点的起始行 `§L{n}`）：

```
L1-20 heading 标题一
  L5-11 heading 小节 1.1
  L16-20 heading 小节 1.2
L22 heading 标题二
块结构（2 个）：
§L5 L7 list·1项
§L5 L11-14 code·ts
```

块 kind：`list`（条目数）/ `table`（数据行数，不含表头与分隔行）/ `code`（围栏语言）/ `quote`（行数）/ `frontmatter`（键数）。

TS API：`digest(ctx, filePath, opts, deps?)`，`deps` 可注入 `provider` / `read` / `resolvePath` / `maxBytes`（单测与嵌入场景）。

## 边界与限制

- `outline` / `signatures` 优先消费宿主 LSP（duck-typed：`ctx.lsp` 或 `ctx.get("lsp")` 的 `documentSymbols` / `symbols`）；不可用时 Markdown 走原生标题解析，TypeScript/JavaScript 与 Python 走启发式（多行签名配平、注释剥离、缩进层级）。
- `requireLsp: true` 对 Markdown 不生效（Markdown 有原生解析路径，不参与 LSP 可用性检查）。
- 无法识别语言且无 LSP → `unsupported_language`，可用 `language` 提示绕过。
- 错误分类：`invalid_option` / `file_not_found` / `not_a_file` / `too_large` / `binary` / `lsp_unavailable` / `unsupported_language`；失败返回 `{ ok: false, error, message }`，不抛未捕获异常。
- **相对路径基准 = 调用方会话 cwd**（工具执行上下文 `exec.agent.session.header.cwd`，与宿主 `dsh-tool-fs` 同口径）：同一相对路径在不同会话下解析到各自会话目录的文件；无会话上下文（非 agent 调用方 / 无 exec）时回退进程 cwd（`process.cwd()`）。注意不可读 `ctx.cwd`——cordis 上下文代理上未 `inject` 的属性读取会直接抛错（旧实现即因此不可用，见 `fs-digest/docs/BACKLOG.md` D1）。
- **Markdown 结构视图口径**（`outline`）：① 节行范围 = 标题行 → 下一个「层级 ≤ 本节」的标题前一行（末节到文件末），**尾部空行不计**；父子范围是**包含关系**（父 ⊇ 子），不是分区；② `depth` 以下的标题不建节点，其正文与块归入最近的输出祖先节（`endLine` 与块的 `section` 一律只指向输出中的标题行）；③ 块清单为平铺结构（不做嵌套），只识别围栏代码块、GFM 表格、列表、引用与**文件首行**的 frontmatter（需配对且内部只含 YAML 键 / 注释 / 空行）；④ 不做 setext 标题、HTML 块、嵌套引用、复杂表格对齐；⑤ 只有 Markdown 的标题节点带 `endLine`、结果才带 `blocks`（其它语言无）。
- `pruned` 的切点会吸附到最近的边界行（空行、Markdown 标题/分隔线、闭合括号行、顶层语句结束行），最多偏移 5 行；文件在预算内时返回全文（`truncated: false`）。

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # 编译到 dist/
npm run test    # node --test（61 例：三模式 + 语言推断/LSP/读取守卫 + Markdown 结构视图）
npm run demo    # 三模式本地示例（无 DSH 依赖）
```
