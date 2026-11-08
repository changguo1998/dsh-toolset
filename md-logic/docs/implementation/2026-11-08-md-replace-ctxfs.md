# `md_logic` 的 `replace` 改走 `ctx.fs`（接取事项：项目级 `docs/implementation/2026-11-08-tool-write-path-fence.md` 的 D1 / D2）

状态：实现完成（待合并回主分支）　　开启：2026-11-08　　关闭：
本文件是本包本次改造的唯一追踪文档；跨包决策与共用口径见项目级文档，此处只写本包任务与机械审计。

## 目标

把 `md_logic` 的落盘路径从「自己写临时文件 + chmod + rename」改成调用官方 `ctx.fs.writeText`, 版本守卫用后端的 `version` CAS; 保留节树 / 块 / 链接解析与「失败不落盘」语义。读面（`structure` / `blocks` / `links`）一并改走 `ctx.fs.readText`。

## 现状

| 位置 | 现在 |
| --- | --- |
| `src/edit.ts:645-649` | `resolveTarget`: 绝对路径原样, 相对路径按 `root ?? process.cwd()` |
| `src/edit.ts:665-682` | `stat` 取 size / mode / 签名 → 超限拒绝 → `readFile` |
| `src/edit.ts:721-736` | 临时文件 `writeFile` + `chmod` 保留权限 + 读→写 TOCTOU 复核 + `rename` 原子替换 |
| `src/tools.ts:39-42` | `resolveExecCwd`: `exec.agent.session.header.cwd`, 缺省回落 `process.cwd()` |
| `src/tools.ts:45-60` | `readMarkdown`: 读面（`structure` / `blocks` / `links`）走 `node:fs` |
| `src/tools.ts:273-332` | `execute(args, exec)` 已带 `exec` |

## 详细任务与机械判据

下表「判据」列都能用「审计命令」列直接验; 命令均在**包目录**下执行。

| 序 | 任务 | 落点 | 完成判据 | 审计命令 |
| --- | --- | --- | --- | --- |
| T1 | 新增 `MdFileIo` 接口与 `node:fs` 缺省实现 | `src/io.ts`（新增） | 文件存在; 含接口 `MdFileIo` 与工厂 `nodeMdFileIo`; 接口声明四个成员 | `grep -c -e "interface MdFileIo" -e "nodeMdFileIo" src/io.ts` ≥ 2; 成员声明见 A15 |
| T2 | 新增 `ctx.fs` 实现 | `src/ctx-fs-io.ts`（新增） | 调 `ctx.fs.resolve` / `stat` / `readText` / `writeText`; 写前取意图; 有错误码映射 | `grep -n -e "ctx.fs.writeText" -e "fs/write-intent" -e "FS_STALE_VERSION" src/ctx-fs-io.ts` 三处均命中 |
| T3 | `replaceSectionsFile` 换读写, 删临时文件 / `chmod` / 自算 TOCTOU | `src/edit.ts:652-746` | `edit.ts` 不再出现 `rename(` / `chmod(` / 临时文件后缀; 写用 `{ version }` 作 `expected` | `grep -n -e "rename(" -e "chmod(" -e "\.tmp" src/edit.ts` 无命中; `grep -n -e "expected" -e "{ version }" src/edit.ts` 命中 |
| T4 | `maxBytes` 上限改用 `FsInfo.size` | `src/edit.ts:673-679` | 超限分支仍在, 判断来源改为 `info.size` | `grep -n "maxBytes" src/edit.ts` 命中; `grep -n "size > maxBytes" src/edit.ts` 命中 |
| T5 | 保留非常规文件拒绝 | `src/edit.ts:665-672` | `read_failed` 分支仍在, 判定改用 `FsInfo` | `grep -n "read_failed" src/edit.ts` 命中 |
| T6 | 读面三动作换 `ctx.fs.readText` | `src/tools.ts:45-60`、`:273-332` | `readMarkdown` 不再直接 `node:fs`; cwd 取 `workingDirectory` | `grep -n "node:fs" src/tools.ts` 无命中; `grep -n "process.cwd()" src/tools.ts` 无命中 |
| T7 | 装配 io 并注入服务 | `src/index.ts` | `inject` 含 `fs`; io 由 `ctx.fs` 构造后注入工具 | `grep -n "inject" src/index.ts` 行内含 `fs`; `grep -n -e "ctx-fs-io" -e "ctxFsIo" src/index.ts` 命中 |
| T8 | 假 io 测试用例 | `tests/` | 五个主题各有用例: 成功替换 / stale 拒绝 / 超限 / 非常规文件 / 写失败不留半成品 | 见 A10 至 A14（逐主题各计一次） |
| T9 | 文档同步 | `README.md`、`docs/DESIGN.md` | 两处都写「经 `ctx.fs`, 受围栏」; 不再写临时文件 + rename | `grep -n "ctx.fs" README.md docs/DESIGN.md` 两文件均命中; `grep -n "临时文件" docs/DESIGN.md` 无命中（或已改为说明由后端保证） |

## 接口改动对照

```
// 之前
replaceSectionsFile(filePath, edits, root?, maxBytes?): Promise<ReplaceOutcome>
resolveExecCwd(exec): string            // 缺省回落 process.cwd()

// 之后
replaceSectionsFile(filePath, edits, options?: { io?: MdFileIo; maxBytes?: number }): Promise<ReplaceOutcome>
mdLogicTool(maxBytes?, options?: { host?: MdFsHostLike; ioFor?: (exec?) => MdFileIo })
resolveExecCwd(host, exec): Promise<string | undefined>   // 取 ctx.workingDirectory, 无回落
```

`root` 参数与 `resolveTarget` 一并由 `io.resolve(path, { cwd })` 取代；`exec` 不再单列进 `options`——
`io` 已按一次调用构造（`ctxMdFileIo(host, exec)`），cwd 在它内部按会话解析。

## 错误码映射（本包相关）

| 后端码 | 本包对外 |
| --- | --- |
| `FS_NOT_FOUND` | `read_failed` + 现有「文件不存在」文案 |
| `FS_NOT_TEXT` | `read_failed` + 「不是 UTF-8 文本」 |
| `FS_STALE_VERSION` | `write_failed` + 「文件在读取后被修改, 请重新读取后重试」 |
| `FS_TOO_LARGE` | `read_failed` + 超限文案（保留现有 `maxBytes` 数值） |
| `FS_SANDBOX_DENIED` | `write_failed` + 原样透出 `[sandbox: …]` 与升级指引 |
| `FS_PERMISSION_DENIED` / `FS_IO_ERROR` | `write_failed` / `read_failed` + 原始 message |

## 机械审计清单

按序执行, 全部满足才算完成:

| 序 | 命令（在 `md-logic/` 下） | 期望 |
| --- | --- | --- |
| A1 | `pnpm run check` | 退出码 0 |
| A2 | `pnpm run build` | 退出码 0 |
| A3 | `pnpm run test` | fail 0 |
| A4 | `grep -rn 'from "node:fs' src/*.ts` | 只命中 `src/io.ts`（注释里提到 `node:fs` 不算） |
| A5 | `grep -rn -e "rename(" -e "chmod(" -e "\.tmp" src/*.ts` | 无命中 |
| A6 | `grep -rn "process.cwd()" src/*.ts` | 无命中 |
| A7 | `grep -rln "fs/write-intent" src/` | 只输出 `src/ctx-fs-io.ts`（文件级唯一） |
| A8 | `grep -n "inject" src/index.ts` | 行内含 `fs` |
| A9 | `grep -n "ctx.fs" README.md docs/DESIGN.md` | 两文件均至少一处 |
| A10 | `grep -c -e "替换" tests/*.test.ts` | 至少一个文件命中成功替换用例 |
| A11 | `grep -c -e "stale" tests/*.test.ts` | 至少一个文件命中 stale 用例 |
| A12 | `grep -c -e "超限" tests/*.test.ts` | 至少一个文件命中超限用例 |
| A13 | `grep -c -e "非常规" tests/*.test.ts` | 至少一个文件命中非常规文件用例 |
| A14 | `grep -c -e "半成品" tests/*.test.ts` | 至少一个文件命中写失败用例 |
| A15 | `grep -c -e "resolve(" -e "stat(" -e "readText(" -e "writeText(" src/io.ts` | ≥ 4（四个成员声明） |

## 实现记录

### 落点（改动文件）

| 文件 | 性质 | 内容 |
| --- | --- | --- |
| `md-logic/src/io.ts` | 新增 | `MdFileIo` 接口（`resolve` / `stat` / `readText` / `writeText`）、`MdFileError` 与码表、`nodeMdFileIo()` 缺省实现（无临时文件） |
| `md-logic/src/ctx-fs-io.ts` | 新增 | `ctxMdFileIo(host, exec)` 与 `resolveExecCwd(host, exec)`：会话 cwd、意图瀑布、带会话策略的 `writeText`、读写后 `fs/observed`、`FsError` 到本包码的映射、服务缺失替身 |
| `md-logic/src/edit.ts` | 改 | 删 `resolveTarget` / 临时文件 + `chmod` + `rename` / 自算 TOCTOU; 落盘改 `io.stat` → `io.readText` → `io.writeText`（`replaceIfVersion`）; 新增 `ReplaceFileOptions` 与 `readFailure` / `writeFailure` 映射 |
| `md-logic/src/tools.ts` | 改 | `mdLogicTool(maxBytes, options)`; 读面与写面都经 `io`; `resolveExecCwd` 改为 `(host, exec)`; 参数校验仍先于 IO |
| `md-logic/src/types.ts` | 改 | 新增 `ToolExecLike` |
| `md-logic/src/index.ts` | 改 | `inject = ["tools", "fs"]`; 删 `sameSignature` / `FileSignature` 导出, 增 io 与宿主面导出 |
| `md-logic/tests/assemble.ts` | 改 | 假 `ctx.fs`（真落盘 + 可编程 version 与抛错）、假 `workingDirectory`（按会话 header 给 cwd）、瀑布与观察记录 |
| `md-logic/tests/ctx-fs-io.test.ts` | 新增 | 替换 / stale / 超限 / 非常规文件 / 半成品 / 服务缺失 / 沙箱策略 / 相对路径 八例 |
| `md-logic/tests/edit.test.ts`、`tests/tool.test.ts`、`tests/integration/plugin.test.ts` | 改 | 删 `sameSignature` 用例; 目录只读用例改为假 io 写失败用例; `inject` 与服务面期望同步 |
| `md-logic/README.md`、`md-logic/docs/DESIGN.md` | 改 | 改写面与落盘口径改「经 `ctx.fs`, 受围栏」; 新增「文件读写面」节 |

### 与计划的差异（四条）

1. **保留既有对外码 `not_utf8` 与 `file_changed`**。计划映射表写 `FS_NOT_TEXT → read_failed`、`FS_STALE_VERSION → write_failed`; 实测两者是既有对外码（`render.ts` 的下一步提示与多处用例依赖）。语义一致：非法 UTF-8 → `not_utf8`，后端版本守卫拒绝 → `file_changed`，故不动码表，只把文案对齐。
2. **二进制（含 NUL）现在报 `not_utf8`**。后端只有 `FS_NOT_TEXT` 一个码（NUL 探测与解码失败共用），无法区分二者；两路都 fail-closed、都不落盘，文案写「疑似二进制」。
3. **删除 `FileSignature` / `sameSignature` 与其导出**。自算 TOCTOU 复核交给后端后它们成了死代码; 库面 node 实现用内部版本令牌自比, 不再对外暴露签名类型。
4. **库面 node 实现不再经临时文件 + `rename`**（项目级 D2）。副作用是「目录只读」不再阻止覆盖本文件（直接写只需文件写权限）; 插件侧仍由后端原子写（暂存目录 + `rename`）保证, 行为不变。原「目录不可写 → `write_failed`」用例改成「假 io 写失败 → `write_failed` 且原文件不变」。

### 审计命令的口径修订

- A4 从「`node:fs` 字样」改为「`node:fs` import 行」: 改造后的注释要说明「不回落 `node:fs`」, 字样必然出现; 真正要守的是 import 面。
- A7 从「一处」改为「文件级唯一」: 同一文件里 `fs/write-intent` 会出现在文件头注释、类型声明与调用点三处。

### 验证证据

| 命令（`pnpm run check:docs` 在仓库根） | 结果 |
| --- | --- |
| `pnpm run check` | 退出码 0 |
| `pnpm run build` | 退出码 0 |
| `pnpm run test` | 83 例全通过（原 75 + 新增 8） |
| `pnpm run test:integration` | 10 例全通过 |
| `pnpm run check:docs` | 错误 0 / 警告 0 |

## 验证口径（真机, 合并后由项目级文档统一跑）

- 工作区内 `md_logic replace` 正常; 指向工作区外被围栏拦。
- 读面 `structure` / `blocks` / `links` 行为不变。

## 不做

- 不改节树 / 块 / 链接的解析与选择语义。
- 不加 `sandbox_permissions` / `justification` 参数。
- 不改跨包文档（合并回主分支后由项目级文档统一处理）。
