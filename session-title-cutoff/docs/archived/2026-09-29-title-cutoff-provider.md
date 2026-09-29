# 会话标题按「会话内提交」推进起名（接取条目：`docs/BACKLOG.md`「会话标题按『会话内提交』推进起名（触发策略不变，只改参考窗口）」）

状态：规划　　开启：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

自动会话标题的触发保持 `all-prompts`（每条真实用户消息触发一次，手动 `/rename` 的 pin 语义不变），但**参考窗口**改为「最近一次会话内提交动作（`git commit`）之后的人类消息」；会话内从未提交过 → 等同全量（现状）。落地形态：新建插件包 `session-title-cutoff`，接管 `ctx.sessionTitle` 的唯一 provider。

## 调研

（来源：宿主包类型/实现 / 本仓 profile 现状）

- 宿主契约（`@deepseek-ai/dsh-session-title@0.1.7-rc.2`）：`ctx.sessionTitle.register(provider)` **只允许一个 provider**（二次注册抛错）；provider = `{ id, automatic: 'first-prompt'|'all-prompts', generate(request) }`；`request.messages: readonly { seq: SessionSeq; text: string }[]` 是**全部合格人类消息**（带 seq）✓；`generate` 返回 `{ title, messageSeqs, model? }`。
- 官方 LLM helper（`@deepseek-ai/dsh-session-title-llm`）：导出 `resolveSessionTitleLlmConfig` / `generateSessionTitleWithLlm(ctx, config, request, selectedMessages, providerId)` / `registerSessionTitleLlmProvider(ctx, config, id, automatic, selectMessages)`。其中 `registerSessionTitleLlmProvider` 的 `selectMessages(messages)` **拿不到 session**，无法按会话取 cutoff ⇒ 本包改用 `ctx.sessionTitle.register` + `generateSessionTitleWithLlm(request.session.id → cutoff → selectedMessages)`。
- 依赖姿态（关键决策）：宿主包不在仓库可解析路径内（`~/.dsh/profiles/fff` 的 link: 插件按源码真实路径解析依赖，仓库内没有 `@deepseek-ai/*`）。**选用零依赖方案**：运行时经 `createRequire($DSH_HOME/profiles/node_modules/x.js)` 解析并动态 `import()` 官方 helper（该路径是宿主官方兜底解析路径，profile 模板注释有记载；实测可解析到 dsh 安装内的同版副本，导出齐全）。解析失败 → 告警并**不注册 provider**（官方 provider 保持禁用时标题回落宿主确定性 fallback，不崩）。
- profile 现状：`~/.dsh/profiles/fff/cordis.patch.yml` 已禁用 `session-title-llm` 并插入了 `session-title-all-prompts-llm`（provider: ustc / model: deepseek-flash / maxInputBytes 32768 等）；用户裁定：**不直接改其文件**，由本仓提供（a）安装脚本集成（可一条命令更新）与（b）需人工复制的片段。
- 待补：`session/event` 的 `tool/call` 载荷字段、`ctx.sessionQuery.listEvents` 签名（由只读调研补齐后回填本节）。

## 决策

- 落点：**新建独立包** `session-title-cutoff`（用户裁定）。
- 触发：保持 `all-prompts`（触发策略不变）。
- 参考窗口：`selected = messages.filter(m => m.seq > cutoff)`；`cutoff` = 最近一次 `git commit` 工具调用事件的 seq（用户裁定「工具调用 seq」）；**过滤后为空 → 回退全量**（保持标题可生成）。
- 提交动作判定：命令文本匹配 `\bgit\s+commit\b`（含 `--amend` / `-a`）；`gh pr merge` 之类暂不纳入（用户裁定）。
- 路由：不写 `provider/model`，复用会话当前记录的路由（用户裁定）；其余配置（targetWords / targetCjkCharacters / maxInputBytes / maxOutputTokens / timeoutMs）给缺省值，可在 profile 覆盖。
- profile：不直接改用户文件；改动落 `profiles/example/` 模板 + `scripts/install.sh`（新增包 + 可一条命令更新既有 profile：补挂 bundle、追加禁用官方 provider 的 patch 片段、跑 pnpm install），另给人工复制片段。

## 规划

计划改动文件清单：

1. `session-title-cutoff/package.json`、`tsconfig.json`、`cordis.patch.yml`、`README.md`（新包骨架与契约）。
1. `session-title-cutoff/src/index.ts`：运行时加载官方 helper（零依赖解析）、provider 注册（`all-prompts` + 窗口过滤）、`cutoff` 记账（`session/event` 的 `tool/call` 监听 + 每会话缓存；可选 `sessionQuery.listEvents` 重建）。
1. `session-title-cutoff/tests/*.test.ts`：提交判定匹配、窗口过滤与回退、注册装配（假 ctx）、helper 缺失降级。
1. `profiles/example/cordis.patch.yml`：禁官方 all-prompts + 注释说明改挂本包。
1. `scripts/install.sh`：`canonical_pkgs` 增包；既有 profile 的「一条命令更新」路径（manifest 合并式更新 + 追加禁用片段，幂等）。
1. `README.md`（根）：插件表加一行。
1. `docs/BACKLOG.md`：#56 状态与归档（收尾时）。
1. 本追踪文档。

明确不做：改用户 `~/.dsh/*` 配置文件（仅产出片段与脚本能力）；`gh pr merge` 等其他提交动作；compaction 与 cutoff 的耦合处理（不做特殊处理，按 seq 线性语义）；手动 `/rename` 语义改动。

## 实现记录

- 2026-09-29：新建包骨架 —— `package.json`（`dsh.bundle.patch` 指向本包 `cordis.patch.yml`）、
  `tsconfig.json`、根 `index.ts`、`cordis.patch.yml`（自带 insert 与缺省配置）、`README.md`。
- 2026-09-29：`src/main.ts` —— 纯函数（`commandOf` / `isCommitCall` / `selectSinceCommit` /
  `latestCommitSeq` / `resolveConfig`）+ `CommitCutoffTracker`（FIFO 256）+ `loadTitleLlmHelper`
  （`createRequire($DSH_HOME/profiles/node_modules/x.js)` → 动态 import 宿主同版 helper）+
  `apply`（注册 `all-prompts` provider；`generate` 内取 cutoff → 过滤 → 调
  `generateSessionTitleWithLlm`；`session/event` 监听 `tool/call` 记账；重启后若本会话无记账，
  经 `ctx.get("sessionQuery").readSession` 重建一次）。
- 2026-09-29：路由决策**修正**（调研发现）：官方 helper 在 config 未给 provider/model 时回落
  `request.route`，而 all-prompts 在首条消息时通常尚无已记录路由 → 会抛错。故本包配置**建议显式
  provider/model**（与官方 provider 口径一致）；`install.sh --sync` 会自动从官方条目复制两者。
- 2026-09-29：`scripts/install.sh` —— `canonical_pkgs` 增包；新增 `--sync`（合并式更新既有
  manifest：本仓库依赖/bundles 刷新、用户额外条目保留；追加「禁用官方 all-prompts」片段与
  `session-title-cutoff` 显式路由，均幂等）；`--plugins`/头部注释口径同步。
- 2026-09-29：`profiles/example/cordis.patch.yml` 增注释示例；根 `README.md` 插件表增一行；
  根 `package.json` 的 `check` / `build` 增本包。
- 2026-09-29：`tests/main.test.ts` —— 8 例（命令解析与提交判定、窗口与回退、记账容量、
  事件重建、配置合并、apply 装配与降级）。
- 2026-09-29：**真机验证后修正提交判定**：原按「命令文本含 `git commit`」匹配，核对脚本 /
  提及该字样的命令会被误判为提交（会话日志实证：核查脚本把 cutoff 顶高）→ 改为「按
  `;`/`&&`/`||`/`|`/换行切段后，某段以 `git commit` 开头」（放行 `sudo` 与 `git -C <目录>` 前缀）；
  用例补正反例（脚本提及、管道 `grep` 不算；`cd x && git commit`、`git -C`、`sudo git commit` 算）。
- 2026-09-29：`scripts/install.sh` 运行目录修复：1/5 增加 `cd "$repo_root"`（从 `scripts/` 直接
  `./install.sh` 也可用）；`--sync` 的官方条目检测改为只看非注释行（模板注释不再误触发追加）。

## 测试与证据

- `npm --prefix session-title-cutoff run check` ✓；`build` ✓；`test` 8/8 ✓（无宿主依赖，全部打桩）。
- `sh -n scripts/install.sh` ✓；`--sync` 在仓库内探针 profile（`tmp/install-probe`）实测：
  manifest 合并保留额外条目（官方 provider 依赖 + `dsh-scheduler` bundle）✓、禁用片段与显式路由
  追加且二次运行幂等 ✓、provider/model 复制正确（ustc / deepseek-flash）✓、模板注释不误判
  （新装 profile 不追加，追加块计数 0）✓。
  （探针里的 `pnpm install` 因沙箱只读全局 store 报 EROFS，属环境限制，非脚本缺陷。）
- **真机验证（2026-09-29，通过）**：用户执行 `scripts/install.sh --sync`（修复运行目录与注释误判
  后）并重启会话。会话日志显示：标题请求的 `titleProvider` 已由 `session-title-all-prompts-llm`
  切换为 `session-title-cutoff`；按修正后的判定重算，最后一次真实提交为 seq 2320，cutoff provider
  的请求（seq 2789）`messageSeqs=[2722,2787]`，与「提交之后的人类消息」**完全一致** ✓。

## 收尾

- 状态：**完成**（条目 `docs/BACKLOG.md` #56 已从 §2 移除并记入 §1 索引）。
- 回写：根 `README.md` 插件表（本次实现提交内）；`session-title-cutoff/README.md` 为本包契约
  来源；`profiles/example/cordis.patch.yml` 注释给出两种 provider 的二选一示例。
- 代码提交：`f6e1dcd`（实现 + 脚本 + 测试 + 本文档）；本文档随收尾提交移入 `docs/archived/`。
- 遗留与边界：进程重启后首个标题触发若查不到提交（`sessionQuery` 不可用）则按「无提交」回退
  全量；`gh pr merge` 等其它提交动作暂不纳入；不处理 compaction 与 cutoff 的耦合。
