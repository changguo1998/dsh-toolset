# `hash_read` / `hash_edit` 改走 `ctx.fs`（接取事项：项目级 `docs/archived/2026-11-08-tool-write-path-fence.md` 的 D1 / D2）

状态：实现完成（待合并回主分支）　　开启：2026-11-08　　关闭：
本文件是本包本次改造的唯一追踪文档；跨包决策与共用口径见项目级文档，此处只写本包任务与机械审计。

## 目标

把 `hash_read` / `hash_edit` 的读写从 `node:fs` 改成调用官方 `ctx.fs` 的方法, 写回带版本守卫; 保留 `LINE:HASH` 锚点生成与「整批拒绝、失败文件字节不变」语义。改造后本工具受 `workspace-write` 围栏约束, 写工作区外需升档。

## 现状

| 位置 | 现在 |
| --- | --- |
| `src/fs.ts:56-61` | `resolvePath`: 绝对路径原样放行; 相对路径 `resolve(root ?? process.cwd(), p)` |
| `src/fs.ts:52-54` | 严格 UTF-8 解码（`TextDecoder({ fatal: true })`）, 非法字节 → `not_utf8` |
| `src/fs.ts:67-100` | `readHashlines` 用 `readFile` + `stat` 读全文, 算 `file_hash` 与窗口内 `hashlines` |
| `src/fs.ts:109-168` | `applyAnchoredEditsFile`: 锚点校验 → 同目录临时文件 + `chmod` + `rename` 原子替换 |
| `src/fs.ts:169` | `listDir` 用 `readdir`（目录列表, 只读面） |
| `src/index.ts:295-298` | `baseRoot(exec)`: 配置 `root` 优先, 否则 `resolveExecCwd(exec)`, 再否则 `process.cwd()` |
| `src/index.ts:307` / `:340` | 两个工具的 `execute(args, exec)` 已带 `exec` |

## 详细任务与机械判据

下表「判据」列都能用「审计命令」列直接验; 命令均在**包目录**下执行。

| 序 | 任务 | 落点 | 完成判据 | 审计命令 |
| --- | --- | --- | --- | --- |
| T1 | 新增 `HashFileIo` 接口与 `node:fs` 缺省实现 | `src/io.ts`（新增） | 文件存在; 含接口 `HashFileIo` 与工厂 `nodeHashFileIo`; 接口声明四个成员 + `listDir` | `grep -c -e "interface HashFileIo" -e "nodeHashFileIo" src/io.ts` ≥ 2; 成员声明见 A19 |
| T2 | 新增 `ctx.fs` 实现 | `src/ctx-fs-io.ts`（新增） | 调 `ctx.fs.resolve` / `stat` / `readText` / `writeText` / `listDir`; 写前取意图; 五值错误码映射 | `grep -n -e "ctx.fs.writeText" -e "fs/write-intent" -e "FS_STALE_VERSION" -e "FS_SANDBOX_DENIED" src/ctx-fs-io.ts` 四处均命中 |
| T3 | `readHashlines` 换读写并回传 `version` | `src/fs.ts:67-100` | `fs.ts` 不再直接 `node:fs` 读; 返回体含 `version` | `grep -n "node:fs" src/fs.ts` 无命中; `grep -n "version" src/fs.ts` 命中 |
| T4 | `applyAnchoredEditsFile` 换写入, 锚点校验保持在写之前 | `src/fs.ts:109-168` | 不再出现临时文件 / `chmod` / `rename`; 写用 `{ version }` 作 `expected`; 锚点校验在写调用之前 | `grep -n -e "rename(" -e "chmod(" -e "\.tmp" src/fs.ts` 无命中; `grep -n -e "expected" -e "{ version }" src/fs.ts` 命中 |
| T5 | `baseRoot` 改用 `workingDirectory`, 删 `process.cwd()` 回落 | `src/index.ts:295-298` | 配置 `root` 仍优先; 否则取会话 cwd; 无 `process.cwd()` | `grep -n "process.cwd()" src/index.ts` 无命中; `grep -n "workingDirectory" src/index.ts` 命中 |
| T6 | 错误码由三值扩为五值 | `src/fs.ts:28` | `FileErrorCode` 含 `stale` 与 `sandbox_denied` | `grep -n "FileErrorCode" src/fs.ts` 行内含 `stale` 与 `sandbox_denied` |
| T7 | 装配 io 并注入服务 | `src/index.ts` | `inject` 含 `fs`; io 由 `ctx.fs` 构造后传给 `createTools` | `grep -n "inject" src/index.ts` 行内含 `fs`; `grep -n -e "ctx-fs-io" -e "ctxFsIo" src/index.ts` 命中 |
| T8 | 假 io 测试用例 | `tests/` | 七个主题各有用例: 读窗口与哈希稳定 / 锚点 stale 整批拒绝 / 非法 UTF-8 / 写成功带 intent / stale / sandbox 拒绝 / 目录列表 | 见 A12 至 A18（逐主题各计一次） |
| T9 | 文档同步 | `README.md` | 覆盖边界改「经 `ctx.fs`, 受围栏与版本守卫; 越界写需升档」; 错误码表补两个新码 | `grep -n "ctx.fs" README.md` 命中; `grep -n -e "stale" -e "sandbox_denied" README.md` 命中 |

### 可选步骤（非验收项, 做与不做都要在实现记录里说明）

| 序 | 任务 | 落点 | 判据 | 审计命令 |
| --- | --- | --- | --- | --- |
| O1 | 读 / 写成功后 `ctx.emit('fs/observed', target, { kind: 'present', version }, exec)` | `src/fs.ts` | 命中即视为已做; 未命中则在实现记录写「未做, 理由: 与 D1 重复」 | `grep -n "fs/observed" src/*.ts` |

## 接口改动对照

```
// 之前
readHashlines(filePath, root?, offset?, limit?): Promise<ReadResult>
applyAnchoredEditsFile(filePath, edits, root?): Promise<FileEditSuccess>
listDir(p: string): Promise<string[]>

// 之后
readHashlines(filePath, options?: ReadOptions): Promise<ReadResult>        // { io?, cwd?, offset?, limit? }
applyAnchoredEditsFile(filePath, edits, options?: FileIoOptions): Promise<FileEditSuccess>  // { io?, cwd? }
listDir(p: string, io?: HashFileIo): Promise<string[]>
createTools(root, options?: ToolOptions)                                   // { host?, ioFor? }
resolveExecCwd(host, exec): Promise<string | undefined>                     // 取 ctx.workingDirectory, 无回落
```

`root` 参数由 `io.resolve(path, { cwd })` 取代；`exec` 不再单列进 options——io 由 `apply` 按一次调用构造
（`ctxHashFileIo(host, exec)`），cwd 在它内部按会话解析。

## 错误码映射（本包相关）

| 后端码 | 本包对外（`FileErrorCode`） |
| --- | --- |
| `FS_NOT_FOUND` | `not_found` |
| `FS_NOT_TEXT` | `not_utf8` |
| `FS_IO_ERROR` / `FS_PERMISSION_DENIED` | `io_error` + 原始 message |
| `FS_TOO_LARGE` | `io_error` + 「文件过大」文案 |
| `FS_STALE_VERSION` | `stale`（新增）+ 「文件在读取后被修改, 请重新 `hash_read`」 |
| `FS_SANDBOX_DENIED` | `sandbox_denied`（新增）+ 原样透出 `[sandbox: …]` 与升级指引 |

`FileErrorCode` 由三值扩为五值属对外契约变化, README 与工具描述需同步。

## 机械审计清单

按序执行, 全部满足才算完成:

| 序 | 命令（在 `hash-edit/` 下） | 期望 |
| --- | --- | --- |
| A1 | `pnpm run check` | 退出码 0 |
| A2 | `pnpm run build` | 退出码 0 |
| A3 | `pnpm run test` | fail 0 |
| A4 | `grep -n "node:fs" src/*.ts` | 只命中 `src/io.ts` |
| A5 | `grep -rn -e "rename(" -e "chmod(" -e "\.tmp" src/*.ts` | 无命中 |
| A6 | `grep -rn "process.cwd()" src/*.ts` | 无命中 |
| A7 | `grep -rn "fs/write-intent" src/` | 恰好 `src/ctx-fs-io.ts` 一处 |
| A8 | `grep -n -e "stale" -e "sandbox_denied" src/fs.ts` | 两处均命中（`FileErrorCode` 换行后不再是单行, 改按文件级判） |
| A9 | `grep -n "inject" src/index.ts` | 行内含 `fs` |
| A10 | `grep -n "ctx.fs" README.md` | 至少一处 |
| A11 | `grep -rn "fs/observed" src/*.ts` | 命中 = O1 已做（`src/ctx-fs-io.ts`） |
| A12 | `grep -c -e "哈希" tests/*.test.ts` | 至少一个文件命中读窗口与哈希用例 |
| A13 | `grep -c -e "stale" tests/*.test.ts` | 至少一个文件命中锚点 stale 用例 |
| A14 | `grep -c -e "UTF-8" tests/*.test.ts` | 至少一个文件命中非法 UTF-8 用例 |
| A15 | `grep -c -e "intent" tests/*.test.ts` | 至少一个文件命中写成功带 intent 用例 |
| A16 | `grep -c -e "sandbox" tests/*.test.ts` | 至少一个文件命中 sandbox 拒绝用例 |
| A17 | `grep -c -e "目录" tests/*.test.ts` | 至少一个文件命中目录列表用例 |
| A18 | `grep -n "ctx.fs" README.md` | `FileErrorCode` 五值已在 README 错误码表列出（人工核对这一行, 其余全机械） |
| A19 | `grep -c -e "resolve(" -e "stat(" -e "readText(" -e "writeText(" -e "listDir" src/io.ts` | ≥ 5（四个成员声明 + `listDir`） |

## 实现记录

### 可选步骤 O1

**已做**：`ctxHashFileIo` 在读（`stat`：present / absent）与写（present + 新版本）后各发一条
`ctx.emit("fs/observed", …)`。理由：观测策略（`fs-observation-policy`）打开时，先观察再写才不会被判成
`FS_NOT_OBSERVED`；官方 `read` / `write` 同口径。

### 落点（改动文件）

| 文件 | 性质 | 内容 |
| --- | --- | --- |
| `hash-edit/src/io.ts` | 新增 | `HashFileIo` 接口（`resolve` / `stat` / `readText` / `writeText` / `listDir`）、`HashFileError` 与码表、`nodeHashFileIo()` 缺省实现（无临时文件） |
| `hash-edit/src/ctx-fs-io.ts` | 新增 | `ctxHashFileIo(host, exec)` 与 `resolveExecCwd(host, exec)`：会话 cwd、意图瀑布、带会话策略的 `writeText`、目录遍历、读写后 `fs/observed`、`FsError` 到本包码的映射、服务缺失替身 |
| `hash-edit/src/fs.ts` | 改 | 删 `resolvePath` / 临时文件 + `chmod` + `rename` / 自算 TOCTOU; 读经 `io.stat` + `io.readText`（非法 UTF-8 与 NUL 由 io 拒）, 写经 `io.writeText`（`replaceIfVersion`）; `FileErrorCode` 扩为五值, 错误映射收敛到 `toFileError` 一处 |
| `hash-edit/src/index.ts` | 改 | `inject = ["tools", "fs"]`; `createTools(root, { host, ioFor })`; 删 `process.cwd()` 回落, `resolveExecCwd` 移到 `ctx-fs-io.ts`; 导出 io 面 |
| `hash-edit/tests/assemble.ts` | 改 | 假 `ctx.fs`（真落盘 + 可编程 version / 抛错 / 与真实后端同口径的 `FS_NOT_TEXT`）、假 `workingDirectory`、瀑布与观察记录 |
| `hash-edit/tests/ctx-fs-io.test.ts` | 新增 | 哈希与读窗口 / 锚点 stale / UTF-8 / intent / 后端 stale / sandbox / 目录列表 / 服务缺失 八例 |
| `hash-edit/tests/fs.test.ts`、`tests/tool.test.ts`、`tests/integration/plugin.test.ts` | 改 | 位置参数改 options; 「目录只读」用例改「文件只读」; 并发用例改「要么成功要么 stale」; `inject` 与服务面期望同步 |
| `hash-edit/README.md` | 改 | 目录结构、错误码五值、与官方 `read` / `edit` 的边界（写路径已同源）、写入语义 |

### 与计划的差异（四条）

1. **`FileErrorCode` 换行**：五值写在一行会超 80 列被 prettier 拆行, A8 的「行内含两码」改成「文件内含两码」（判据等价）。
2. **库面 node 实现不再经临时文件 + `rename`**（项目级 D2）。旧的「目录只读 → `write_failed`」用例改为「文件只读（`0o444`）→ `write_failed`」：直接写本文件只需文件写权限, 目录权限不再参与; 插件侧仍由后端原子写（暂存目录 + `rename`）保证。
3. **并发语义变化**：旧实现靠「临时文件名唯一」让 8 个并发写全部成功; 现在版本守卫让后到者报 `stale`。用例改成「至少一次成功, 其余只能是 `stale`, 文件始终完整」——更强的不撕裂断言。
4. **`hash_read` 工具面不返回 `version`**：`ReadResult` 加了内部 `version` 字段（T3 要求）, 但工具返回值仍只有 `{ ok, path, line_count, file_hash, hashlines }`, 版本令牌只在本仓内部流转, 不扩模型可见契约。

### 审计命令的口径修订

- A4 从「`node:fs` 字样」改为「`node:fs` import 行」（注释里会提到「不回落 node 标准库」, 字样不影响判定）。
- A7 从「一处」改为「文件级唯一」。
- A8 从「行内含两码」改为「文件内含两码」（见上）。

### 验证证据

| 命令（`pnpm run check:docs` 在仓库根） | 结果 |
| --- | --- |
| `pnpm run check` | 退出码 0 |
| `pnpm run build` | 退出码 0 |
| `pnpm run test` | 65 例全通过（原 57 + 新增 8） |
| `pnpm run test:integration` | 18 例全通过 |
| `pnpm run demo` | 输出 `SMOKE_PASS` |
| `pnpm run check:docs` | 错误 0 / 警告 0 |

## 验证口径（真机, 合并后由项目级文档统一跑）

- 工作区内 `hash_read` + `hash_edit` 正常往返; 指向工作区外写入被围栏拦并给出升级指引。
- 锚点 stale 时整批拒绝, 文件字节不变。

## 不做

- 不改锚点算法（`LINE:HASH` 与 `file_hash` 的生成规则不变）。
- 不加 `sandbox_permissions` / `justification` 参数。
- 不改跨包文档（`docs/ARCHITECTURE-REUSE.md` §4 D 的重开记录合并回主分支后由项目级文档统一处理）。
