# ctx.cwd 未注入导致 fs_digest 调用必失败（修复）（接取条目：`fs-digest/docs/BACKLOG.md`「`ctx.cwd` 未注入，导致 `fs_digest` 调用必失败」）

状态：规划（决策已通过审阅，待实现）　　开启：2026-09-27　　关闭：——
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
审阅：用户 2026-09-27 逐条审阅第 1 条（本条），决策**通过**。

## 目标

`fs_digest` 三模式在相对路径输入下可用，相对路径基准 = **调用方会话的 cwd**（非进程 cwd）；补一条回归用例，并在 `fs-digest/README.md` 记一条边界。

## 调研

来源：本包源码 + 宿主包实测 + 现场取证脚本（`tmp/fs-digest-probe.ts`）。

- 现象与既有记录一致：`ctx.cwd` 在 cordis 上下文代理上未 `inject`，读取即抛 `Error: cannot get property "cwd" without inject`，`?? process.cwd()` 兜底永远走不到（`src/main.ts` 的 `PluginCtx.cwd` 无人赋值）。
- 现场取证（2026-09-27，包根 `fs-digest/` 下运行）：`execute({path:"tests/fixtures/sample.md", mode:"outline"})` 无 exec 参数时报
  `file_not_found`，解析目标为 `/home/guochang/Projects/dsh-toolset/tests/fixtures/sample.md`
  （= 进程 cwd + 相对路径）——证实相对路径按**进程 cwd** 解析，且与包根不一致时必然失败。
- 宿主权威口径（`@deepseek-ai/dsh-tools`）：工具执行签名为 `tool.execute(args, exec)`（宿主源码 `lib/index.js:3310` `tool.execute(exec.arguments, exec)`），即 `exec` 是**第二个实参**，由宿主在分派时传入。
- 会话 cwd 取值路径（`@deepseek-ai/dsh-tool-fs` 权威实现，`lib/index.js:159-185`）：
  `function sessionCwd(exec) { return exec.agent?.session.header.cwd; }`，官方 doc 注释明确「agent's per-session workspace (`exec.agent.session.header.cwd`)，各会话相对该 cwd，进程 `process.cwd()` 只在工具边界兜底」。
- 本包现状：`DigestDeps.resolvePath` 已是可注入签名（`src/digest.ts:23` 声明 `(input, cwd)`，`src/main.ts:129` 只传 input 少一个实参），故修复点集中在 `src/main.ts` 取值 + 传参。

## 决策

选项 → 选定：

1. **从会话面取 cwd 注入**（`exec.agent?.session.header.cwd`，官方同口径）——**选定**（用户 2026-09-27 决策）。
1. 改用 `process.cwd()` 一行改完 —— 否决：相对路径基准退化为进程工作目录，与工具描述「相对会话 cwd」及 `/session` 多会话语义不一致。

理由：与宿主 `dsh-tool-fs` 完全同口径，多会话（各自 meta.cwd）下语义正确；改动仍在包内，不引新依赖。

## 规划

任务拆分：

1. `src/main.ts`：`execute` 增第二参 `exec`（结构类型，不编译期依赖 `@deepseek-ai/*`），解析 `sessionCwd = exec?.agent?.session?.header?.cwd`；`resolvePath` 归一化为 `(input, sessionCwd ?? process.cwd())`；`PluginCtx.cwd` 字段删除（无人赋值、且属未注入属性读取陷阱），工具跟 `description` 里「相对会话 cwd」的说法保持不变。
1. 回归用例（`tests/digest.test.ts`）：假 exec 提供 cwd → 相对路径可用；**同一相对路径在「无 exec」与「exec 指向他目录」两种基线下解析到不同文件**（断言不再是进程 cwd 单一口径）；三模式（outline / signatures / pruned）各覆盖一次相对路径可用。
1. `fs-digest/README.md`：记一条边界——相对路径基准为**调用方会话 cwd**（`exec.agent.session.header.cwd`），无会话上下文时回退进程 cwd。

计划改动文件清单（**只改这些**）：

- `fs-digest/src/main.ts`
- `fs-digest/tests/digest.test.ts`
- `fs-digest/README.md`
- 本追踪文档

明确不做：不改 `src/digest.ts` 核心算法；不改 `Config` 面向用户的配置项（不新增 `cwd` 配置）；不动 `ctx` 的其他未注入属性访问（`ctx.lsp` 有宿主注入面背书的既有语义）。

## 实现记录

（待实现）

## 测试与证据

（待补：`npm run check` / `npm run test` 输出 + 现场取证脚本对照）

## 收尾

（待补：README 回写、临时脚本清理、是否移入 `docs/archived/`）
