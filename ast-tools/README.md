# @dsh-toolset/ast-tools

DSH（DeepSeek Harness）进程内集成插件：基于 **ast-grep** 的 AST 结构搜索、结构化替换、文件大纲与 YAML 规则执行。

零运行时依赖；通过系统 `ast-grep` CLI 子进程完成全部工作（选型依据见下）。

## 二进制选型

**采用系统 ast-grep CLI，而非 `@ast-grep/napi` 原生绑定。** 依据（均在 ast-grep 0.45.3 实测）：

| 维度 | 系统 CLI（选用） | @ast-grep/napi |
| --- | --- | --- |
| 语言覆盖 | 25+ 语言（含 go/rust/java/c++/python 等） | 仅内置 5 种：CSS/HTML/JS/TS/TSX |
| YAML 规则执行 | 原生 `scan --rule/--inline-rules`，支持 fix 重写与关系子句 | 规则类型无 `fix`/rewrite 字段，无 scan 语义 |
| 输出 | `--json=compact` 结构化（含字节偏移、元变量捕获） | 命中对象，无 replacementOffsets |
| 包依赖 | 零运行时依赖（二进制在系统侧） | 需安装 NAPI 原生模块（平台二进制体积大） |

代价是每次操作一次子进程启动（毫秒级），对本插件的使用频率可接受。

### 二进制探测顺序

1. 插件配置 / API 参数的 `bin` 显式路径
1. `AST_GREP_BIN` 环境变量
1. `PATH` 中的 `ast-grep`
1. `PATH` 中的 `sg`（ast-grep 别名）
1. 本地 `node_modules/.bin/ast-grep`（`@ast-grep/cli` 作为项目依赖安装时的回落）

### 二进制不可用时的降级与安装

探测失败时抛 `AstGrepMissingError`（bundle 入口 `apply` 捕获后仅记录日志并禁用插件，宿主不崩溃）。报错信息内含全部安装路径，任选其一：

```sh
npm install -g @ast-grep/cli   # 安装 ast-grep / sg 二进制（推荐）
brew install ast-grep          # macOS
cargo install ast-grep         # Rust 工具链
# 或下载预编译二进制: https://github.com/ast-grep/ast-grep/releases
# 或用 AST_GREP_BIN 环境变量 / 插件配置 bin 字段指定二进制绝对路径
```

## 快速开始

```ts
import { searchAst, replaceAst, outlineFile, runRules } from "@dsh-toolset/ast-tools";

// 1. AST 结构搜索（$VAR 单节点元变量，$$$VAR 节点序列元变量）
const hits = await searchAst({
  pattern: "console.log($ARG)",
  language: "ts",
  path: "src/",
});
// hits[0].text / hits[0].range（0-based 行列 + 字节偏移）/ hits[0].metaVariables

// 2. 结构化替换（缺省仅内存，write: true 写回磁盘）
const result = await replaceAst({
  pattern: "console.log($MSG)",
  replacement: "console.info($MSG)", // $MSG 引用捕获的实参
  language: "ts",
  path: "src/app.ts",
  write: true,
});

// 3. 文件大纲
const outline = await outlineFile({ path: "src/app.ts", items: "all" });
// outline[0].items: 顶层符号（函数/类/import），类含 members（方法）

// 4. YAML 规则执行（文件或内联文本）
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

### 可运行样例（本包内）

```sh
npm --prefix ast-tools run example:search    # SEARCH_EXAMPLE_PASS
npm --prefix ast-tools run example:replace   # REPLACE_EXAMPLE_PASS
```

样例 1（搜索，`examples/search.example.ts`）：在临时 TS 文件中搜 `console.log($ARG)`，断言恰好命中 1 处、行号 0-based、元变量捕获为 `add(1, 2)`，输出：

```
hit: console.log(add(1, 2)) (L5:1)
SEARCH_EXAMPLE_PASS
```

样例 2（替换，`examples/replace.example.ts`）：把 2 处 `console.log` 替换为 `console.info`（`console.warn` 不受影响），断言替换后全文逐字一致且缺省不写回磁盘，输出：

```
replaced 2 occurrence(s):
  + console.info('before');
  + console.info(x);
REPLACE_EXAMPLE_PASS
```

## API

| 导出 | 说明 |
| --- | --- |
| `searchAst(params, opts?)` | AST 模式搜索 → `AstMatch[]` |
| `replaceAst(params, opts?)` | 结构化替换 → `ReplaceResult`（`updatedSource`/`replacedCount`/`written`/`matches`） |
| `outlineFile(params, opts?)` | 文件大纲 → `OutlineFile[]`（items/members 含 0-based 范围与签名） |
| `runRules(params, opts?)` | YAML 规则执行 → `AstRuleHit[]`（`ruleId`/`severity`/`message`，fix 规则附 `replacement`） |
| `findAstGrepBin(bin?)` / `ensureAstGrepBin(bin?)` | 二进制探测（返回 null / 抛错） |
| `createAstToolsBundle(config?)` | 核心工厂：绑定配置返回 `search/replace/outline/rules` 服务对象 |
| `name` / `Config` / `apply(ctx, config?)` | DSH bundle 契约（见下） |
| `AstGrepError` 及子类 | `AstGrepMissingError`（无二进制，含安装路径）/ `AstGrepProcessError`（CLI 失败，含 stderr）/ `AstGrepJsonError` |

### 模式语法注意事项（ast-grep 0.45.x）

- `$VAR`：捕获**单个** AST 节点；`$$$VAR` / `$$$`：捕获**节点序列**（0 个或多个兄弟节点，含分隔符）。
- `$$VAR` / `$$` 以及带括号的元变量名（如 `$(name)`）在当前版本**不生效或匹配失败**，请勿使用。
- 替换文本中 `$VAR` 引用单节点捕获，`$$$VAR` 按原文展开整个序列。

## DSH bundle 集成

对齐 `DSH-CTX-API.md` §0 的插件 bundle 约定（`export { name, Config, apply }`，cordis 加载器识别 named `apply` 导出）：

- `package.json` 声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`
- `cordis.patch.yml` 以 `insert` 条目把 `ast-tools` 插件挂入宿主
- `apply(ctx, config?)`：二进制可用时记录 ready 日志；缺失时走降级（记录含安装路径的日志并禁用插件，不抛出）

真实宿主侧挂载效果按仓库惯例由部署时人工确认（与 knowledge-base/TUI 一致）。

## 开发

```sh
npm --prefix ast-tools run check   # tsc --noEmit（strict + noUncheckedIndexedAccess）
npm --prefix ast-tools run test    # node --test，多语言匹配/替换/大纲/规则 + 降级路径
npm --prefix ast-tools run build   # 产物 dist/src/index.js
```

- 无二进制的机器上，依赖二进制的测试自动 skip，降级路径用例恒跑。
- CLI 输出约定：`run` 无命中时 exit=1 但 stdout 为 `[]`；`scan` 的 error 级命中非零退出但 stdout 仍为纯 JSON——本包一律以可解析 JSON 为准，仅在「无 JSON 且非零退出」时抛 `AstGrepProcessError`。
