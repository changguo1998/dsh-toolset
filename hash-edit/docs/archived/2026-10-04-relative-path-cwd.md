# 相对路径基准拿不到会话 cwd（接取条目：`hash-edit/docs/BACKLOG.md`「相对路径基准拿不到会话 cwd」）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`hash_read` / `hash_edit` 的相对路径以**调用会话 cwd** 为基准（`exec.agent?.session?.header?.cwd`，宿主 `dsh-tools` 的 `exec` 第二实参）；显式 `Config.root` 仍优先；无会话上下文回退 `process.cwd()`（现状不退化）。单测覆盖「exec 带 cwd 且与进程 cwd 不同」（撤修复必红）+ `Config.root` 优先。

## 调研

- 现状：`toDshTool.execute` 丢弃宿主第二实参（`src/main.ts:82`：`execute: (args) => def.execute(args)`），`resolvePath` 只用 `root ?? process.cwd()`（`src/fs.ts:56`）→ 会话 cwd ≠ 进程 cwd 时相对路径解析到错目录（not_found 或读错文件）。
- 契约与对照：宿主 `dsh-tools/lib/index.js:3310` 传 `exec`；会话 cwd 取 `exec.agent?.session?.header?.cwd`（本仓对照 `fs-digest/src/main.ts:66`、`md-logic/src/tools.ts:34`、`md-map/src/tools.ts` 的 `resolveExecCwd`；宿主 tool-fs 同口径）。
- 影响面：仅工具面 `createTools(root)` 两个入口；`fs.ts` 的 `readHashlines` / `applyAnchoredEditsFile` 已接受 `root` 参数（签名不用改）。
- 文案：`README.md:15`「宿主 cwd」、`:41` 默认值 `process.cwd()`；工具参数描述两处「宿主 cwd」（`src/main.ts:151/228`）；`Config.root` 注释与 `fs.ts:52` 注释同口径。

## 决策（待审阅）

按条目给定修法（最小改动）：

1. `src/main.ts`：新增 `resolveExecCwd(exec)`（口径同 fs-digest / md-logic：`exec.agent?.session?.header?.cwd`，空/缺省回退 `process.cwd()`）；`ToolDef` / `DshTool` / `toDshTool` 透传第二实参 `exec`；`createTools` 内按调用计算基准 `config.root ?? resolveExecCwd(exec)`（显式配置优先）。
1. 文案口径改「会话 cwd」：工具参数描述两处、`Config.root` 注释、`fs.ts` 注释、README 两处。
1. 测试（`tests/tool.test.ts`）：① exec 会话 cwd 与进程 cwd 不同 → 相对路径解析到会话 cwd（撤修复 → not_found 必红）；② `Config.root` 优先于 exec cwd。
1. 不动：`fs.ts` 两个函数签名（root 参数已就位）、`execute` 的错误语义与返回形状、demo。

## 规划

- 计划改动文件清单（**只改这些**）：`hash-edit/docs/BACKLOG.md`（状态）、本追踪文档、`hash-edit/src/main.ts`、`hash-edit/src/fs.ts`（仅注释）、`hash-edit/tests/tool.test.ts`、`hash-edit/README.md`。
- 验证：`hash-edit` 包 `check` / `build` / `test`；撤修复必红复核；根 `npm run check`。
- 明确不做：不动 `fs.ts` 函数签名与错误码；不动其它包；不顺手改相邻代码。

## 实现记录（2026-10-04）

- 子代理只读审阅（决策后、实现前）：通过；采纳——① `config.root` 空串按未配置处理（仓库惯例），加 1 行守卫；② `fs.ts` 注释不写「缺省会话 cwd」（该层不掌握 exec，会话 cwd 由工具层传入）；③ 测试用 `res.path` 判别式断言（而非只看 `not_found`）+ 前提守卫 `dir !== process.cwd()`；④ `RegisteredTool.execute` 接口加第二可选参（`npm run test` 走 transform-types 不做类型检查，只有 check 拦得住）；⑤ README 测试计数 50 → 52、`hash_edit` 的 path 行对齐措辞；⑥ `hash_read` 与 `hash_edit` 两个受点各覆盖一次（第二个用例内含「配置优先」+「未配置按 exec」两段）。
- 代码：`src/main.ts` 新增 `resolveExecCwd(exec)`（内部，不导出）与 `baseRoot(exec)`，`toDshTool` 透传宿主第二实参；`src/fs.ts` 仅注释。
- 未做：无 exec 回退 `process.cwd()` 的正向 pin（审阅列为可选，评估后不新增，保持改动最小）。

## 测试与证据

- `hash-edit` 包 `npm run check` / `npm run build`：exit 0；根 `npm run check`：exit 0（`error TS` 计数 0）。
- `hash-edit && npm test`：52 pass / 0 fail（新增 2 条）。
- 反向验证（撤修复必红）：把 `toDshTool.execute` 临时改回单参（丢弃 `exec`）→ 两条新用例均红（`AssertionError: 相对路径解析到会话 cwd 下的文件` / `…未配置 config.root 时按 exec 会话 cwd 解析`）；恢复修复态后复绿。
- 判别式：未修复时 `res.path === undefined`（相对路径落到进程 cwd → `not_found`），修复后等于会话 cwd 下的绝对路径。

## 收尾

- 回写：`hash-edit/README.md`（`path` 两处「会话 cwd」、`root` 默认值口径、测试计数 52）。
- 本文件移入 `hash-edit/docs/archived/`；`hash-edit/docs/BACKLOG.md` 清空该项（仅留未完成项）。
- 临时产物：无（测试在系统临时目录内建/删，未落仓库）。
