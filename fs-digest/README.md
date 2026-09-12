# @dsh-toolset/fs-digest

DSH（DeepSeek Harness）进程内集成插件：上下文感知文件读取。注册单一工具 `fs_digest`，
按文件类型与读取意图返回**最小充分上下文**，替代整文件 `read`。

## 三模式

| mode | 返回 | 典型场景 | 选项 |
|---|---|---|---|
| `outline` | 章节/符号大纲（层级树，含行号） | 理解文件结构 | `depth`（默认 3） |
| `signatures` | 函数/方法/构造器签名（含行号） | 理解调用接口 | — |
| `pruned` | 大文件头尾裁剪正文（头部约 2/3、尾部约 1/3，中间一行省略标记） | 查看大文件要点 | `maxLines`（默认 200）、`maxTokens`（默认 4000，按 4 字符/token 估算） |

`language` 选项可显式提示语言（markdown / typescript / python），缺省按扩展名推断。

## LSP 与降级

- `outline` / `signatures` 优先消费宿主 LSP（tool-lsp 底座职责的进程内复用，
  duck-typed 识别 `ctx.lsp.documentSymbols` / `ctx.lsp.symbols` / `ctx.get("lsp")`）。
- LSP 不可用时：Markdown 走原生标题解析；TypeScript/JavaScript 与 Python 走启发式
  （多行签名配平、注释剥离、缩进层级）。
- `requireLsp: true` 时 LSP 不可用不降级，直接返回 `lsp_unavailable` 错误。
- 无法识别的语言且无 LSP → `unsupported_language`（可用 `language` 提示绕过）。

结果中的 `source` 字段标注实际来源：`lsp` / `heuristic` / `markdown`。

## 错误分类

`file_not_found` / `not_a_file` / `binary` / `too_large`（默认 2MB 上限，
`config.maxBytes` 可调）/ `unsupported_language` / `invalid_option` / `lsp_unavailable`。
失败时返回结构化错误（`ok: false` + `error` + 人读 `message`），不抛未捕获异常。

## 开发

```sh
npm install
npm run check   # tsc --noEmit
npm run test    # node --test（node --experimental-transform-types）
npm run build   # 产出 dist/
npm run demo    # 三模式本地示例（无 DSH 依赖）
```

## 结构

- `src/digest.ts` — 编排：选项校验、读取、语言推断、LSP 解析、模式分发
- `src/outline.ts` / `src/signatures.ts` / `src/prune.ts` — 三模式纯函数
- `src/read.ts` / `src/languages.ts` / `src/lsp.ts` / `src/types.ts` — 底座与契约
- `src/main.ts` — dsh bundle 入口（`name` / `inject` / `Config` / `apply`）
- `index.ts` — 包入口（re-export）
