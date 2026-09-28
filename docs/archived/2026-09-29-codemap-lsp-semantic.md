# LSP 语义层：findReferences 精确确认调用关系（接取条目：docs/BACKLOG.md「LSP 语义层：findReferences 精确确认调用关系」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给 code-map 补上**语义层（precision）**：`callers` 查询在宿主 LSP 能力可用时，经官方 `ctx.lsp` 缝的 `findReferences` 精确确认引用（消歧同名误连）；LSP 不可用 / 查询失败 / 超时则回落现有结构层同名候选（recall），结果显式标注精度来源。

## 调研

来源：`code-map/docs/DESIGN.md`、`code-map/src/{index.ts,types.ts,graph/query.ts,indexer/refs.ts}`、`code-map/tests/*`、`archive/CODEMAP-RESEARCH.md`（选型调研）、`archive/PI-DSH-FEATURE-COMPARISON.md` §3.2（hypa 拆项 3）、`docs/host/HOST-PACKAGES.md` §（LSP 三件套未随包分发）、官方源码 `~/GithubRepos/deepseek-harness`（tag `dsh-v0.1.7-rc.2`）`packages/lsp/lsp/src/{index.ts,types.ts}`、`fs-digest/src/lsp.ts`（既有的宿主 LSP duck-typed 接入先例）。

- **官方 LSP 服务缝（`ctx.lsp`，`@deepseek-ai/dsh-lsp`）**：provider 注册 + 按扩展名选路；暴露**四个操作**（`goToDefinition` / `findReferences` / `goToImplementation` / `hover`），无 JSON-RPC 逃生口。
  - 请求：`{ operation, filePath, position: { line, character }, workspaceRoot }`（**0-based UTF-16**，与 ast-grep 的 0-based 行号一致）。
  - 结果：`{ kind: 'locations', locations: [{ uri, range }], resolvedWorkspaceUri }` 或 `{ kind: 'hover', hover }`；`findReferences` 语义上**包含声明本身**（provider 内部保证），调用方需自行排除定义区间。
  - 错误：`LspError` 带稳定 `code`（`LSP_UNAVAILABLE` / `LSP_UNSUPPORTED_OPERATION` / `LSP_MALFORMED_RESPONSE` 等）；消费方自管超时与结果上限（缝不做默认值）。
- **可用性**：`lsp` / `lsp-stdio` / `tool-lsp` **不随 dsh 分发**（`HOST-PACKAGES.md`：官方源码有、随包分发没有）；是否挂载看 profile。故接入必须是**可选依赖**：`ctx.get("lsp")` 读取（我们其它包读取可选服务的既有口径），缺失即结构层回落。
- **既有先例**：`fs-digest/src/lsp.ts` 用 duck-typing 接 `ctx.lsp` / `ctx.get("lsp")`（`documentSymbols`/`symbols`）并带启发式回落——本任务沿用同一风格，但按官方缝的**查询契约**（`query({operation,…})`）对接，而非猜测方法名。
- **code-map 现状**：结构层（ast-grep outline/search）+ 内存 import 图；`callers` = 同名候选（`candidateRefs` → `excludeDefinitionRange`），文档声明「精确裁决走 LSP 语义层（增量）」且 `DESIGN.md §8` 把「LSP 语义层（`resolve`/`precise` 提升）」列在**明确不做**——本任务即兑现该增量。
- **符号定位**：图里符号只有 `file` / `startLine` / `endLine` / `name`，LSP 查询需要 `{line, character}`——需从定义行文本里定位标识符列（一次单行读文件；不引入全量源码缓存）。

## 决策

1. **对接官方缝而非猜方法名**：`resolveLspReferences(ctx)` 读 `ctx.get("lsp")`（受保护，兼容直接 `ctx.lsp` 读取的测试宿主），要求 `query` 方法；包一层 `findReferences(filePath, position)`：发 `{operation:'findReferences', …}`、解析 `kind:'locations'`、失败/异常/超时 → `null`（回落）。
1. **精度显式化**：`CallersResult` 增 `precision: "lsp" | "structural"`（附加字段，既有消费方不破）；`lsp` = 精确路径结果，`structural` = 同名候选回落。空结果（0 条引用）只要是 LSP 成功返回即为 `precision:"lsp"`（不误判为失败回落）。
1. **回落面**：LSP 面缺失、符号定位失败（定义行找不到标识符）、查询抛错/超时（5s 上限，`AbortSignal.timeout`）任一 → 结构层候选（现状行为）。
1. **范围**：本次只提升 `callers`（条目点名 `findReferences`）；`callees` 的文件级语义与 `resolve` 留后续（不在本条）。
1. **注入面**：`CodeMapConfig.lsp?: LspReferencesProvider`（测试/嵌入用）；`apply()` 内 `config.lsp ?? resolveLspReferences(ctx)`，与 ast 的注入风格一致。
1. **不做**：不做 provider 注册（不自带语言服务器；`lsp-stdio` 不在本仓库）、不做文档同步/诊断、不做结果上限截断（宿主自管；超时兜底已足够）。

## 规划

任务拆分：

1. `code-map/src/semantic/lsp.ts`（新）：缝适配（duck-typed `query` → `findReferences`）、`LspLocation` 类型、受保护的服务读取、超时包装。
1. `code-map/src/semantic/locate.ts`（新）：`symbolPositionAt(file, line, name)` 定义行定位（0-based line + character）。
1. `code-map/src/types.ts`：`CallersResult.precision`。
1. `code-map/src/index.ts`：`CodeMapConfig.lsp`；`CodeMapServiceCore` 持 provider；`callers` 走精确路径（`uriToCandidateRef` + 复用 `excludeDefinitionRange`）；`degradedBundle` 补 `precision`；工具描述更新（callers 精度口径）；`apply` 解析并透传。
1. `code-map/tests/semantic.test.ts`（新）：假 provider（命中/空/抛错三态 + 定义排除 + 列定位）、回落断言。
1. 文档：本追踪文档；关闭时回写 `code-map/docs/DESIGN.md`（§2/§5/§8）与 `code-map/README.md`（工具/服务面精度说明）。

计划改动文件清单（**只改这些**）：

- `docs/BACKLOG.md`（条目状态；途中发现新条目）
- `docs/implementation/2026-09-29-codemap-lsp-semantic.md`（本追踪文档）
- `code-map/src/semantic/lsp.ts`（新）
- `code-map/src/semantic/locate.ts`（新）
- `code-map/src/types.ts`
- `code-map/src/index.ts`
- `code-map/tests/semantic.test.ts`（新）
- `code-map/docs/DESIGN.md`（关闭时回写）
- `code-map/README.md`（关闭时回写）

明确不做：`callees` 符号级提升、`resolve`/`hover`、provider 实现（语言服务器启动）、TUI 侧新命令（`/callers` 等）、跨包改动。

## 实现记录

2026-09-29：

- `code-map/src/semantic/lsp.ts`（新，~180 行）：官方 `ctx.lsp` 查询缝适配——`resolveLspReferences(ctx, workspaceRoot, injected?)`：注入优先；`readLspSurface` 受保护读服务（`ctx.get("lsp")` 优先、直接属性读包 try/catch，兼容 cordis 代理抛错与测试宿主）；支持官方缝 `query({operation:'findReferences',…})`（解析 `kind:'locations'`、hover/形状不符/抛错 → null）与已窄化的 `findReferences` 形态；`AbortSignal.timeout(5000)` 超时兜底。
- `code-map/src/semantic/locate.ts`（新）：`symbolPositionAt(file, line, name)` 只读定义行定位 0-based `{line, character}`（失败 → undefined）。
- `code-map/src/types.ts`：`CallersResult` 增 `precision: "lsp" | "structural"`。
- `code-map/src/graph/query.ts`：结构层 `callers` 返回 `Omit<CallersResult,"precision">`（精度由 core 定）。
- `code-map/src/index.ts`：`CodeMapConfig.lsp` 注入面；`CodeMapServiceCore` 持 provider；`callers` 精确路径优先（`symbolPositionAt` → `findReferences` → `locationToRef`（`file:` URI → 路径）→ 复用 `excludeDefinitionRange` 去声明 → 按文件+行排序），失败回落结构层；`degradedBundle` 补 `precision`；工具描述更新；`apply()` 内 `config.lsp ?? resolveLspReferences(ctx, root)`。
- `code-map/tests/semantic.test.ts`（新，7 用例）：缝解析（注入/官方 query/窄化形态）、fail-open（hover/形状不符/抛错/无服务/cordis 代理直读抛错）、定位（列号/缺失/越界）、callers 精确（含声明排除与入参位置）、null 回落、未注入回落。
- 途中发现（登记新条目）：`fs-digest/src/lsp.ts` 的 `c?.lsp ?? …` **先直读** `ctx.lsp`——真实 cordis ctx 上直读未 inject 的服务属性会抛 `cannot get property "lsp" without inject`，导致 `fs_digest` 工具（outline/signatures 路径）整调用失败而非降级启发式（本会话实测一次）；code-map 本次用受保护读取规避了同类问题。

## 测试与证据

- `npm --prefix code-map run check` / `build`：通过。
- `npm --prefix code-map run test`：21 pass / 0 fail（14 既有 + 7 新）。
- 根 `npm run check`：0 error（15 包）；全仓 `npm run test`：15 包全 OK（code-map 21 / TUI 1205 / 其余无回归）。
- `mdformat`：`code-map/docs/DESIGN.md`、`code-map/README.md` 通过。
- 真机：宿主未挂载 LSP 三件套（`lsp`/`lsp-stdio`/`tool-lsp` 不随包分发），本机 `callers` 实际走结构层回落（工具描述与结果 `precision:"structural"` 一致）；LSP 精确路径由单测的官方缝替身覆盖（真实 provider 需装三件套后联调，属宿主面）。

## 收尾

- 回写 `code-map/docs/DESIGN.md`：§2 语义层行（已实现说明）/ §5 callers 精确优先算法 / §7 接入面（可选 lsp 读取）/ §8（消歧已实现、明确不做列表更新）。
- 回写 `code-map/README.md`：`callers` 行与「引用精度」说明。
- `docs/BACKLOG.md`：#22 清理（已完成入 §1 索引）；途中发现新增条目（fs-digest `ctx.lsp` 直读缺陷）。
- 本文件移入 `docs/archived/`。
- 遗留项：`callees` 符号级提升与 `resolve`/`hover`（LSP 缝其余操作）未做（条目明示范围外）；真实 LSP provider 联调留待装 `lsp`/`lsp-stdio`/`tool-lsp` 三件套时（宿主面）。
- 临时文件：无。
