# @dsh-toolset/output-compress

DSH（DeepSeek Harness）进程内插件：把**超阈值命令/工具输出**的确定性摘要 + 切片索引写入
knowledge-base 共享 SQLite 库，使原始大输出不进模型上下文、又可按需检索与定位回原始字节。

## 它做什么

- 订阅宿主 `session/event` 的 `tool/result` 事件；
- 触发条件（满足其一）：
  1. **spill 通知**：宿主 spill-policy 已把大输出落盘并在事件文本尾部追加
     `(Omitted N bytes. Full formatted result stored at: <locator>. ...)` 通知；
  1. **阈值**：事件文本长度 ≥ `minChars`（默认 16384）；
- 取回完整输出（spill 文件，`maxSourceBytes` 上限，默认 512KB）；
- 在宿主 `ctx.codeRuntime` 沙箱里运行**单一确定性派生程序**（非 LLM 抽取；该服务经
  `ctx.reflect.get('codeRuntime', false)` 可选读取，未挂载时回落 `node:vm` 执行同一程序源），产出：
  行/字节统计、markdown section 标题（≤40）、错误类关键行（≤20）、固定 16 片切片索引
  （行号/字符区间 + 首行预览 + FNV-1a 指纹）；
- 把摘要渲染为小体积 Markdown 记录，经**共享库写入器**写进 knowledge-base 的
  **同一个** SQLite 文件（`category='output-compress'`），复用其 FTS5 触发器自动建索引。

## 挂载声明文件

`cordis.patch.yml` 是 cordis bundle patch（`insert` 语义），不是 RFC6902 JSON Patch。
该文件刻意不含注释：仓库统一的 `format` 对 YAML 走 `yq -y -i .`（python yq，无法保留注释），
保留注释会让格式化永不收敛（每次 format 都产生工作树改动）。

正因为它是 bundle patch 方言而非 JSON Patch，pi-lens 的 `yaml-schema: JSONPatch` 会对其误报
（缺 op/path/value、insert 不允许）。本目录的 `.pi-lens.json` 用 `ignore` 把该文件排除出
检查输出（仅在 `output-compress/` 作用域生效），避免假阳性阻断；文件作用与挂载方式见
`package.json` 的 `dsh.bundle.patch` 与本文件上文说明。

**边界**：原始字节由宿主 retention/spill 负责保留，本插件不存原文全文、不让原文进模型上下文；
本插件与 knowledge-base 之间无 npm 依赖，只通过共享库文件这一宿主共享面通信。

## 命令

```sh
npm run check   # tsc --noEmit（strict + noUncheckedIndexedAccess）
npm run test    # node --test 单元测试（阈值触发/摘要确定性/切片结构/共享库写入）
npm run build   # tsc 编译到 dist/
npm run smoke   # 真实 dsh headless 会话冒烟（需 dsh CLI + 模型凭据）
```

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dbPath` | `OUTPUT_COMPRESS_DB_PATH` → `KNOWLEDGE_DB_PATH` → `~/.dsh/knowledge-base/knowledge.db` | 共享库路径，必须与 knowledge-base 一致 |
| `project` | `'default'` | 摘要记录的 project 过滤维度 |
| `minChars` | `16384` | 无通知时触发摘要的最小文本长度（字符） |
| `maxSourceBytes` | `524288` | 读取 spill 文件的字节上限（超出截断并标注 `truncated`） |

写前校验库指纹（`PRAGMA application_id = 'KNOW'`、`user_version = 1`）与 `sources`/`chunks`
表存在，不符则拒写（`KbNotMountedError`，事件管线降级为 skipped，不向宿主抛错）。

## 独立 profile

`~/.dsh/profiles/dsh-output-compress`：`link:` 依赖指向本仓库 worktree 的
`output-compress/` 与 `knowledge-base/`，两个 bundle 共享同一 `dbPath` 表达式：

```
dsh --profile dsh-output-compress
```

## 结构

```
src/
  index.ts            # bundle 入口（name/apply/createOutputCompressBundle）
  trigger.ts          # spill 通知解析 + 阈值触发判定
  summary-program.ts  # 单一派生程序源（SUMMARY_PROGRAM）+ SummaryJson 类型/校验
  sandbox.ts          # CodeRuntimeSandbox（宿主）/ VmSandbox（node:vm 回落）
  kb-write.ts         # 共享库写入器（指纹校验/去重/chunk 切分）
  hooks.ts            # session/event 适配 + 摘要记录渲染 + 管线编排
tests/                # node --test 单测（含真实临时 SQLite 库）
smoke/smoke.mjs       # 真实 dsh 会话冒烟
```

设计决策见 `DESIGN.md`；宿主契约研读笔记见仓库根 `DSH-CTX-API.md`。
