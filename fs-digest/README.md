# @dsh-toolset/fs-digest

DSH（DeepSeek Harness）进程内插件：上下文感知文件读取。注册工具 `fs_digest`，按文件类型与读取意图返回最小充分上下文，替代整文件 `read`；只读，不改文件。

## 能力

| mode | 返回 | 选项 |
| --- | --- | --- |
| `outline` | 章节/符号层级树（1 基行号） | `depth`（默认 3，≥1；Markdown = 最大标题级） |
| `signatures` | 函数/方法/构造器签名（1 基行号） | — |
| `pruned` | 大文件头尾裁剪正文（头部约 2/3、尾部约 1/3，中间一行省略标记） | `maxLines`（默认 200，≥2）、`maxTokens`（默认 4000，≥2，按 4 字符/token 估算） |

工具参数：`path` 与 `mode` 必填；`depth`、`maxLines`、`maxTokens` 为整数（范围见上表）；`language` 为语言提示（`markdown` / `typescript` / `python`，缺省按扩展名推断）；`requireLsp` 为 true 时 LSP 不可用直接报 `lsp_unavailable`，不降级。

结果 `source` 标注实际来源：`lsp` / `heuristic` / `markdown`。渲染上限：outline 树 60 行、signatures 60 条、pruned 展示 80 行，超出以省略行收尾。

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

TS API：`digest(ctx, filePath, opts, deps?)`，`deps` 可注入 `provider` / `read` / `resolvePath` / `maxBytes`（单测与嵌入场景）。

## 边界与限制

- `outline` / `signatures` 优先消费宿主 LSP（duck-typed：`ctx.lsp` 或 `ctx.get("lsp")` 的 `documentSymbols` / `symbols`）；不可用时 Markdown 走原生标题解析，TypeScript/JavaScript 与 Python 走启发式（多行签名配平、注释剥离、缩进层级）。
- `requireLsp: true` 对 Markdown 不生效（Markdown 有原生解析路径，不参与 LSP 可用性检查）。
- 无法识别语言且无 LSP → `unsupported_language`，可用 `language` 提示绕过。
- 错误分类：`invalid_option` / `file_not_found` / `not_a_file` / `too_large` / `binary` / `lsp_unavailable` / `unsupported_language`；失败返回 `{ ok: false, error, message }`，不抛未捕获异常。
- **已知缺陷（工具当前不可用）**：会话 cwd 的取值路径不可用——`resolvePath` 直接读 `ctx.cwd`，而 `cwd` 不是宿主服务，未 `inject` 的属性访问即抛错（`?? process.cwd()` 兜底走不到），任何调用都会失败。详见 `fs-digest/docs/BACKLOG.md` D1（待修复）。
- `pruned` 的切点会吸附到最近的边界行（空行、Markdown 标题/分隔线、闭合括号行、顶层语句结束行），最多偏移 5 行；文件在预算内时返回全文（`truncated: false`）。

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # 编译到 dist/
npm run test    # node --test（42 例：三模式 + 语言推断/LSP/读取守卫）
npm run demo    # 三模式本地示例（无 DSH 依赖）
```
