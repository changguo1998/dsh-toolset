# `ast_replace` 改走 `ctx.fs`（接取事项：项目级 `docs/archived/2026-11-08-tool-write-path-fence.md` 的 D1 / D2）

状态：实现完成（待合并回主分支）　　开启：2026-11-08　　关闭：
本文件是本包本次改造的唯一追踪文档；跨包决策与共用口径见项目级文档，此处只写本包任务与机械审计。

## 目标

把 `ast_replace` 的读写从 `node:fs` 改成调用官方 `ctx.fs` 的方法, 写回时带版本守卫; 保留 ast-grep 匹配、dry-run 预览与替换计数。改造后本工具受 `workspace-write` 围栏约束, 写工作区外需升档。

## 现状

| 位置 | 现在 |
| --- | --- |
| `src/replace.ts:80-86` | `readFileSync(params.path)` 读原文 → `applyEdits` → `writeFileSync(params.path, updated)` 整文件重写, 无任何读后复核 |
| `src/tools.ts:30-37` | `AstOperations.replace(params)` 只有业务参数, 没有执行上下文 |
| `src/tools.ts:410-437` | `ast_replace` 的 `execute(args)` 不接 `exec`, 拿不到 `signal` / 会话 cwd / 观察 actor |
| `src/index.ts:145-165` | `createAstToolsBundle()` 把 `replaceAst` 直接绑到 `ops.replace` |
| `src/index.ts:172-202` | `apply(ctx)` 注册工具, 当前 `inject` 未含 `fs` |
| `src/binary.ts` | 用 `node:fs` 探测 ast-grep 二进制 —— **不属文件编辑面, 保持不变** |

## 详细任务与机械判据

下表「判据」列都能用「审计命令」列直接验; 命令均在**包目录**下执行。

| 序 | 任务 | 落点 | 完成判据 | 审计命令 |
| --- | --- | --- | --- | --- |
| T1 | 新增 `AstFileIo` 接口与 `node:fs` 缺省实现 | `src/io.ts`（新增） | 文件存在; 含接口 `AstFileIo` 与工厂 `nodeAstFileIo`; 接口声明四个成员 | `grep -c -e "interface AstFileIo" -e "nodeAstFileIo" src/io.ts` ≥ 2; 成员声明见 A14 |
| T2 | 新增 `ctx.fs` 实现 | `src/ctx-fs-io.ts`（新增） | 调 `ctx.fs.resolve` / `readText` / `writeText`; 写前取意图; 有错误码映射 | `grep -n -e "ctx.fs.writeText" -e "fs/write-intent" -e "FS_STALE_VERSION" src/ctx-fs-io.ts` 三处均命中 |
| T3 | `replaceAst` 增 `io` 参数并换读写 | `src/replace.ts:53-89` | `replace.ts` 不再出现 `node:fs` 的读写调用; 写前把读到的 `version` 作为 `expected` | `grep -n "node:fs" src/replace.ts` 无命中; `grep -n -e "expected" -e "version" src/replace.ts` 命中 |
| T4 | `AstOperations.replace` 与工具 `execute` 透传 `exec` | `src/tools.ts:18-37`、`:410-437` | 接口第二参数为 `exec`; `execute` 形参含 `exec` 且传给 `ops.replace` | `grep -c "exec?: ToolExecLike" src/tools.ts` ≥ 2（接口与 execute 各一处） |
| T5 | 装配 `ctx.fs` io 并注入服务 | `src/index.ts:145-202` | `inject` 含 `fs`; bundle 接收由 `ctx.fs` 构造的 io | `grep -n "inject" src/index.ts` 行内含 `fs`; `grep -n -e "ctx-fs-io" -e "ctxFsIo" src/index.ts` 命中 |
| T6 | 新增假 io 测试用例 | `tests/` | 四个主题各有用例: dry-run 不写 / 带 intent / stale 拒绝 / sandbox 拒绝 | 见 A10 至 A13（逐主题各计一次） |
| T7 | README 覆盖边界同步 | `README.md` | README 提到 `ctx.fs` 与「升档」; 不再写「直接 node:fs 写」 | `grep -n "ctx.fs" README.md` 命中; `grep -n "不受围栏" README.md` 无命中 |

## 接口改动对照

```
// 之前
replaceAst(params, opts): Promise<ReplaceResult>
AstOperations.replace(params): Promise<ReplaceResult>

// 之后
replaceAst(params, opts, io?: AstFileIo): Promise<ReplaceResult>
AstOperations.replace(params, exec?: ToolExecLike): Promise<ReplaceResult>
```

## 错误码映射（本包相关）

| 后端码 | 本包对外 |
| --- | --- |
| `FS_NOT_FOUND` | 现有「文件不存在」文案 |
| `FS_NOT_TEXT` | 「目标不是 UTF-8 文本」 |
| `FS_STALE_VERSION` | 「文件在读取后被修改, 请重新读取后重试」 |
| `FS_SANDBOX_DENIED` | 原样透出（含 `[sandbox: …]` 标记与升级指引） |
| `FS_IO_ERROR` / `FS_PERMISSION_DENIED` | io 失败文案, 保留原始 message |

## 机械审计清单

按序执行, 全部满足才算完成:

| 序 | 命令（在 `ast-tools/` 下） | 期望 |
| --- | --- | --- |
| A1 | `pnpm run check` | 退出码 0 |
| A2 | `pnpm run build` | 退出码 0 |
| A3 | `pnpm run test` | fail 0 |
| A4 | `grep -rn 'from "node:fs' src/*.ts` | 只命中 `src/io.ts` 与 `src/binary.ts`（注释里提到 `node:fs` 不算） |
| A5 | `grep -rn -e "writeFileSync" -e "writeFile(" src/*.ts` | 只命中 `src/io.ts` |
| A6 | `grep -rn "process.cwd()" src/*.ts` | 只剩 `src/binary.ts:97`（二进制探测的候选根, 与本包写面无关; 见「实现记录」） |
| A7 | `grep -rln "fs/write-intent" src/` | 只输出 `src/ctx-fs-io.ts`（文件级唯一） |
| A8 | `grep -n "inject" src/index.ts` | 行内含 `fs` |
| A9 | `grep -n "ctx.fs" README.md` | 至少一处 |
| A10 | `grep -c -e "dry-run" tests/*.test.ts` | 每个测试文件计数 ≥ 1（至少一个文件命中） |
| A11 | `grep -c -e "intent" tests/*.test.ts` | 同上 |
| A12 | `grep -c -e "stale" tests/*.test.ts` | 同上 |
| A13 | `grep -c -e "sandbox" tests/*.test.ts` | 同上 |
| A14 | `grep -c -e "resolve(" -e "stat(" -e "readText(" -e "writeText(" src/io.ts` | ≥ 4（四个成员声明） |

## 实现记录

### 落点（改动文件）

| 文件 | 性质 | 内容 |
| --- | --- | --- |
| `ast-tools/src/io.ts` | 新增 | `AstFileIo` 接口（`resolve` / `processPath` / `stat` / `readText` / `writeText`）、`AstFileError` 与码表、`astFileErrorText` 文案映射、`nodeAstFileIo()` 缺省实现 |
| `ast-tools/src/ctx-fs-io.ts` | 新增 | `ctxAstFileIo(host, exec)`：解析（cwd 由 `workingDirectory.ensure` 给）、意图瀑布、带会话策略的 `writeText`、读写后 `fs/observed`、`FsError` 到本包码的映射、服务缺失替身 |
| `ast-tools/src/replace.ts` | 改 | 读写改走 `io`; 顺序 = stat（取版本）→ readText → 跑 CLI → 按字节偏移拼接 → `replaceIfVersion` 写回 |
| `ast-tools/src/tools.ts` | 改 | `AstOperations.replace(params, exec?)` 与 `execute(args, exec)` 透传; 工具描述去掉「无读后改前版本守卫 / 直接 node:fs 写」旧口径 |
| `ast-tools/src/types.ts` | 改 | 新增 `ToolExecLike` |
| `ast-tools/src/index.ts` | 改 | `inject = ["tools", "fs"]`; `createAstToolsBundle(config, deadline, ioFor)`; `apply` 注入 `ctxAstFileIo`; 导出新面 |
| `ast-tools/tests/assemble.ts` | 改 | 假 `ctx.fs`（真落盘 + 可编程 version 与抛错）、假 `workingDirectory`、瀑布与观察记录 |
| `ast-tools/tests/ctx-fs-io.test.ts` | 新增 | dry-run / 带 intent / stale / sandbox / 服务缺失 / 沙箱策略 / 相对路径 七例 |
| `ast-tools/tests/tool.test.ts`、`ast-tools/tests/integration/plugin.test.ts` | 改 | `inject` 期望改 `["tools", "fs"]`; 服务面期望补 `fs` 与 `workingDirectory` |
| `ast-tools/README.md` | 改 | 覆盖边界、库面口径与测试例数同步 |

### 与计划的差异（三条）

1. **意图瀑布的兜底返回自己带的意图**。项目级文档第 3 步照抄官方 `write` 的 `() => undefined`, 但官方 `write` 自身没有版本基准才这么兜底; 本包自己就有 `replaceIfVersion` 基准, 兜底成 `undefined` 会让版本守卫在 `dsh-base`（观测策略缺省关闭）下静默消失。故兜底为 `() => 自身意图`——监听者仍可覆盖或拒绝。项目级文档合并后按此修订。
2. **读后与写后各发一条 `fs/observed`**。项目级文档第 5 步标为可选, 这里做了: 观测策略打开时先观察再写, 才不会被判成 `FS_NOT_OBSERVED`（官方 `read` / `write` 同口径）。
3. **`AstFileIo` 多一个 `processPath`**。ast-grep 是子进程, 需要真实路径; 只给不透明的 `targetKey` 跑不了 CLI。

### 审计命令的口径修订

- A4 从「`node:fs` 字样」改为「`node:fs` import 行」: 改造后的注释要说明「不回落 `node:fs`」, 字样必然出现; 真正要守的是 import 面。
- A7 从「一处」改为「文件级唯一」: 同一文件里 `fs/write-intent` 会出现在文件头注释、类型声明与调用点三处; 有意义的不变量是「只有 `ctx-fs-io.ts` 碰这个事件」。
- A6 仍有命中, 唯一一处是 `ast-tools/src/binary.ts:97` 的 `process.cwd()`: 用途是探测本地 `node_modules/.bin/ast-grep` 的候选根, 与本包写面无关; 且「不做」明确不改 `binary.ts`。项目级 C6 需按此放宽（合并后由项目级文档统一改）。

### 验证证据

| 命令（`pnpm run check:docs` 在仓库根） | 结果 |
| --- | --- |
| `pnpm run check` | 退出码 0 |
| `pnpm run build` | 退出码 0 |
| `pnpm run test` | 89 例全通过（原 82 + 新增 7） |
| `pnpm run test:integration` | 9 例全通过 |
| `pnpm run example:replace` | 输出 `REPLACE_EXAMPLE_PASS` |
| `pnpm run check:docs` | 错误 0 / 警告 0 |

## 验证口径（真机, 合并后由项目级文档统一跑）

- 工作区内 `ast_replace`（`write: true`）正常写回; 指向工作区外时被围栏拦并给出升级指引。

## 不做

- 不加 `sandbox_permissions` / `justification` 参数（升档能力属后续事项）。
- 不改 ast-grep 调用、匹配语义与输出格式; 不改 `src/binary.ts` 的二进制探测。
- 不改跨包文档（`docs/ARCHITECTURE-REUSE.md` §4 D 等, 合并回主分支后由项目级文档统一处理）。
