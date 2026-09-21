# @dsh-toolset/ast-tools

DSH（DeepSeek Harness）进程内插件：基于 ast-grep 的 AST 结构搜索、结构化替换、文件大纲与 YAML 规则执行。零运行时依赖，全部操作经系统 `ast-grep` CLI 子进程完成。

## 能力

本包不注册模型侧工具，以 bundle + TS API 形式供宿主与其他插件（如 code-map）调用：

| 导出 | 说明 |
| --- | --- |
| `searchAst(params, opts?)` | AST 模式搜索 → `AstMatch[]`（`text` / `range` / `metaVariables`） |
| `replaceAst(params, opts?)` | 结构化替换 → `ReplaceResult`（`updatedSource` / `replacedCount` / `written` / `matches`） |
| `outlineFile(params, opts?)` | 文件大纲 → `OutlineFile[]`（顶层符号与成员，含 0-based 行列与字节偏移） |
| `runRules(params, opts?)` | YAML 规则执行 → `AstRuleHit[]`（`ruleId` / `severity` / `message`，fix 规则附 `replacement`） |
| `createAstToolsBundle(config?)` | 核心工厂：绑定二进制与超时，返回 `search` / `replace` / `outline` / `rules` / `dispose` 服务对象 |
| `findAstGrepBin` / `ensureAstGrepBin` | 二进制探测（未找到返回 `null` / 抛 `AstGrepMissingError`） |
| `name` / `Config` / `apply(ctx, config?)` | DSH bundle 契约 |

各操作的参数（`opts` 为通用选项 `bin` / `timeoutMs`）：

- `search`：`pattern`、`language`、`path`（文件或目录）、`strictness?`
- `replace`：`pattern`、`replacement`、`language`、`path`（仅具体文件）、`strictness?`、`write?`（缺省 false，仅内存返回）
- `outline`：`path`、`language?`、`items?`（缺省 `auto`：文件取 `structure`，目录取 `exports`）、`types?`
- `rules`：`rule`（`{ kind: "file", rulePath }` 或 `{ kind: "inline", rules }`）、`paths`、`includeMetadata?`、`minSeverity?`

另导出 `normalizeLanguage`、`runCli` / `runCliJson`、`DEFAULT_TIMEOUT_MS`、`INSTALL_GUIDANCE` 与错误类型 `AstGrepError` / `AstGrepMissingError` / `AstGrepProcessError` / `AstGrepJsonError`（含 `exitCode` / `stderr`）。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `bin` | 自动探测 | ast-grep 二进制绝对路径，优先于一切探测 |
| `timeoutMs` | `30000` | 单次子进程超时（超时 SIGKILL，`exitCode = -1`） |

二进制探测顺序：显式 `bin` → `AST_GREP_BIN` 环境变量 → `PATH` 中的 `ast-grep` → `PATH` 中的 `sg` → 本地 `node_modules/.bin/ast-grep`。

探测失败抛 `AstGrepMissingError`，报错内含安装方式：`npm install -g @ast-grep/cli`、`brew install ast-grep`、`cargo install ast-grep`、预编译二进制下载，或用 `AST_GREP_BIN` / `bin` 指定路径。bundle 的 `apply` 捕获该错误后记录日志并禁用插件，不使宿主崩溃；其他错误照常抛出。

## 使用示例

```ts
import {
  outlineFile,
  replaceAst,
  runRules,
  searchAst,
} from "@dsh-toolset/ast-tools";

// 搜索（$VAR 单节点元变量，$$$VAR 节点序列元变量）
const hits = await searchAst({
  pattern: "console.log($ARG)",
  language: "ts",
  path: "src/",
});

// 结构化替换（缺省仅返回内存结果，write: true 写回磁盘）
const result = await replaceAst({
  pattern: "console.log($MSG)",
  replacement: "console.info($MSG)",
  language: "ts",
  path: "src/app.ts",
  write: true,
});

// 文件大纲
const outline = await outlineFile({ path: "src/app.ts", items: "all" });

// YAML 规则（文件或内联文本）
const ruleHits = await runRules({
  rule: {
    kind: "inline",
    rules: [
      "id: no-console-log",
      "language: typescript",
      "message: 禁止 console.log",
      "severity: warning",
      "rule:",
      "  pattern: console.log($MSG)",
      "fix: console.info($MSG)",
    ].join("\n"),
  },
  paths: ["src/"],
});
```

包内可运行样例（临时文件全流程断言）：

```sh
npm run example:search    # 输出 SEARCH_EXAMPLE_PASS
npm run example:replace   # 输出 REPLACE_EXAMPLE_PASS
```

## 边界与限制

- 依赖系统 ast-grep CLI（不内置二进制、无 NAPI 绑定）：每次操作为一次性子进程，语言覆盖与规则能力随本机 ast-grep 版本；无法安装二进制的环境按上文降级。
- 元变量语法：`$VAR` 捕获单个 AST 节点，`$$$VAR` / `$$$` 捕获节点序列（0 个或多个兄弟节点）。`$$VAR` / `$$` / `$(name)` 不产生序列捕获（`$(name)` 匹配不到），不要使用。
- 替换文本中 `$VAR` 引用单节点捕获，`$$$VAR` 按原文展开整个序列。
- CLI 退出码不作为判据：`run` 无命中与 `scan` 的 error 级命中都可能非零退出而 stdout 为纯 JSON；仅在「无 JSON 且非零退出」时抛 `AstGrepProcessError`，无命中返回空数组。
- 语言名支持别名（`js` → `javascript`、`py` → `python` 等），未知值原样透传给 CLI 校验；`replace` 要求具体文件路径，不支持目录输入。

## 测试

```sh
npm run check   # tsc --noEmit（strict + noUncheckedIndexedAccess）
npm run build   # 编译到 dist/
npm run test    # node --test（27 例：多语言匹配/替换/大纲/规则 + 降级路径）
```

依赖二进制的用例在缺 ast-grep 的机器上自动 skip，降级路径用例恒跑。
