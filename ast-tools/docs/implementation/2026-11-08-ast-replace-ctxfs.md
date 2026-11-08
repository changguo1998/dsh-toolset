# `ast_replace` 改走 `ctx.fs`（接取事项：项目级 `docs/implementation/2026-11-08-tool-write-path-fence.md` 的 D1 / D2）

状态：进行中　　开启：2026-11-08　　关闭：
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
| T4 | `AstOperations.replace` 与工具 `execute` 透传 `exec` | `src/tools.ts:18-37`、`:410-437` | 接口第二参数为 `exec`; `execute` 形参含 `exec` 且传给 `ops.replace` | `grep -n "replace(params" src/tools.ts` 命中带 `exec`; `grep -n "execute(args.*exec" src/tools.ts` 命中 |
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
| A4 | `grep -n "node:fs" src/*.ts` | 只命中 `src/io.ts` 与 `src/binary.ts` |
| A5 | `grep -rn -e "writeFileSync" -e "writeFile(" src/*.ts` | 只命中 `src/io.ts` |
| A6 | `grep -rn "process.cwd()" src/*.ts` | 若仍有命中, 必须是与本包写面无关的用途, 并在实现记录里逐条说明 |
| A7 | `grep -rn "fs/write-intent" src/` | 恰好 `src/ctx-fs-io.ts` 一处 |
| A8 | `grep -n "inject" src/index.ts` | 行内含 `fs` |
| A9 | `grep -n "ctx.fs" README.md` | 至少一处 |
| A10 | `grep -c -e "dry-run" tests/*.test.ts` | 每个测试文件计数 ≥ 1（至少一个文件命中） |
| A11 | `grep -c -e "intent" tests/*.test.ts` | 同上 |
| A12 | `grep -c -e "stale" tests/*.test.ts` | 同上 |
| A13 | `grep -c -e "sandbox" tests/*.test.ts` | 同上 |
| A14 | `grep -c -e "resolve(" -e "stat(" -e "readText(" -e "writeText(" src/io.ts` | ≥ 4（四个成员声明） |

## 验证口径（真机, 合并后由项目级文档统一跑）

- 工作区内 `ast_replace`（`write: true`）正常写回; 指向工作区外时被围栏拦并给出升级指引。

## 不做

- 不加 `sandbox_permissions` / `justification` 参数（升档能力属后续事项）。
- 不改 ast-grep 调用、匹配语义与输出格式; 不改 `src/binary.ts` 的二进制探测。
- 不改跨包文档（`docs/ARCHITECTURE-REUSE.md` §4 D 等, 合并回主分支后由项目级文档统一处理）。
