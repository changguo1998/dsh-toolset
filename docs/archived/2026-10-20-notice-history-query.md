# 模型按需检索 notice 历史原文（接取条目：docs/BACKLOG.md「模型按需检索 notice 历史原文（compaction 后取回）」）

状态：关闭　　开启：2026-10-20　　关闭：2026-10-20
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给模型提供可调用的 notice 历史原文查询通道：compaction 按 `retainTokens` / `retainRatio` 保留近期尾段后，被压出保留段的 notice 原文（宿主以 user-role 送进上下文、全量落持久日志）模型仍能按需取回（至少取最近 N 条，可按 `kind` 过滤）。验收待细化：compaction 后能取回被折叠的 notice 原文；缺失 / 无权限会话报错语义明确；不越权读其它目录。

## 调研

（来源：本仓先例 `TUI/docs/archived/2026-10-19-notice-model-view.md`、宿主源码 `@deepseek-ai/dsh-session` / `dsh-session-persistence-jsonl` / `dsh-llm`（0.2.0-rc.2，路径 `~/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/...`）、本机真实会话日志实测解压（`~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/7d950eaa-.../session.v4.jsonl.zstd`，623 KB / 299 帧 / 解压 1.6 MB / 523 行）。）

1. **数据面可行性（核心）**：持久日志 `session.v4.jsonl.zstd` 是**拼接式多帧 zstd 容器**（宿主 `dsh-session-persistence-jsonl` 每次批量追加写一个独立可解压帧）；Node 自带 `node:zlib.zstdDecompressSync`（v24.16 已含 `ZstdDecompress` 一族，**无需新依赖**），但一次性 API 只解第一帧，必须复刻宿主的 `scanZstdFrames`（按帧头 + 块结构定位完整帧，尾帧撕裂容忍）逐帧解压后拼接。已在本机 623 KB / 299 帧真实日志上验证：复刻脚本解出 1.6 MB / 523 行，事件类型齐全（`user/message` / `assistant/message` / `tool/*` 等），与宿主 `PublicZstdFrameDecoder` 同法。
2. **notice 消息在日志里的形态**：`user/message` 事件的 `data` 即 `UserMessage`（`{id, role, content: ContentBlock[], source}`）；notice 由 `source.form === 'notice'` 判别（可带 `source.summary` ≤120），`content` 为 `[{type:'text', text:<原文>}]`，**原文全量落日志**（与调研文档实测一致）。`agent/inbox/spliced` 的载荷是 `{target, start, inserted}`（旧形态, 未直接带 `source`）, 含 notice 时在 `inserted` 数组里。
3. **宿主会话服务面不可行**：`Session.deriveMessages()` 只走 surface 派生——compaction 的 surface replace 会把被折叠节点从派生里删除（`dsh-session/lib/types/index.d.ts` 注释原文 "a compaction `replace` deletes the shadowed nodes from the derivation"），**压出保留尾段的 notice 原文在内存会话面上不可再取**；`eventAt` / `snapshotEvents` / `ownEvents` 已标 `@deprecated`，注释明令「new calls are prohibited」，新插件不应调用。故要取回被折叠 notice 原文，唯一可行数据面是**读持久日志**。
4. **落点解析有现成服务**：`session-paths` 的 `sessionDirFor(sessionId)`（内部经宿主 `sessions.get(id).header.cwd` → `sessionDir`）正是一切会话目录的唯一事实源，路径恒落在 `<DSH_HOME>/sessions` 之下, 天然满足「不越权读其它目录」。既有消费先例：`memory-base`（S 层落点）、`output-compress` / `auto-approve` / `agent-group` 均经它解析。
5. **既有模型侧工具先例**：`tui_local_log`（`TUI/src/app/adapter/local-log-tool.ts`，本任务同族）已确立「缺省当前会话 + 可选 `session_id` + 会话不可定位即明确报错」的参数契约，可对齐复用语义。
6. **分工基线**：`output-compress` 自持 `digest.db`（大工具输出摘要）、`spill` 保原始大输出字节、`memory-base` 管知识——notice 原文唯一事实源是宿主持久日志，本任务只做**按需只读**，不写任何自有库（避免二次落库与一致性分裂）。

## 决策

（2026-10-20 主分支 ui-ravine-5e31 修正裁定, 已确认；技术事实依据见调研节。）

- **① 承载形态（裁定：TUI 包内, 不建新包）**：依据归档追踪文档 `TUI/docs/archived/2026-10-19-notice-model-view.md` 决策 6-8（2026-10-19 用户裁定）——「写入端与读取工具都在 TUI 包内, 不跨模块、不新包, 工具注册走 `ctx.tools.register`」, 先例 `tui_local_log`（`TUI/src/app/adapter/local-log-tool.ts`）。本任务同族对齐：数据面 `TUI/src/app/adapter/notice-history.ts` + 工具 `notice_history` 注册进 TUI 插件作用域。根 `package.json` 委托清单不变。
- **② 数据面（确认）**：读持久日志 `<会话目录>/session.v4.jsonl.zstd`（拼接多帧 zstd）→ 复刻宿主 `scanZstdFrames` + `node:zlib.zstdDecompressSync` 逐帧解压（TUI engines node ≥22.19, Node 24.16 自带, 无新依赖）；`.zstd` 缺失回落明文 `session.v4.jsonl`。宿主会话服务面排除（调研 3）。
- **③ 覆盖范围（确认）**：缺省当前会话（`exec.agent.session.id`）+ 可选 `session_id`（契约对齐 `tui_local_log`）; 落点复用 TUI adapter 既有 `locateSessionDir` / `sessionRoots`（`app/adapter/session-paths.ts`, 含 id 白名单 + realpath 包含性校验, 恒在 `<DSH_HOME>/sessions` 下, 不越权）; 会话 id 非法 / 目录未定位 → 明确报错。
- **④ 分工（确认）**：纯按需只读, 不写任何自有库（不碰 digest.db / memory-base / spill / tui-local）, notice 原文唯一事实源 = 宿主持久日志。
- 查询语义：notice 判别 `source.form === 'notice'`; 取 `user/message` 与 `agent/inbox/spliced.inserted` 两处、按消息 `id` 去重（实测同 id 双现, 见调研）; `kind` 过滤实现在 **`source.kind`（生产者类别：tool-jobs / subagent-settled / model-selection / plan-mode / webhook / repeat-tool-reminder / tool-goal 等, open-set 精确匹配）**——条目判别字段 `source.form` 恒为 `'notice'`, 作为过滤参数无区分度, 故过滤参数取 `source.kind`（与 BACKLOG「可按 kind 过滤」的本意一致; 工具描述与回报中均明示此口径, 若主分支本意另有所指可再裁定, 属一处小改）; `limit` 缺省 20 / 上限 200（对齐 `tui_local_log`）。
- 配置面：**无**（只读工具, 不设开关; 与 `localLog` 的可写开关不同）。若后续需要可加 `noticeHistory.enabled`, 本期不做。

## 规划

计划改动文件清单（裁定后定稿）：

- `TUI/src/app/adapter/notice-history.ts`（新：数据面——`scanZstdFrames` / 多帧解压 / notice 事件抽取去重 / 按最近 N 条 + kind 过滤读取）
- `TUI/src/app/adapter/notice-history-tool.ts`（新：模型侧工具 `notice_history`）
- `TUI/src/main.ts`（工具注册, 对齐 `tui_local_log` 注册块）
- `TUI/tests/notice-history.test.ts`（新：单测, 含多帧 zstd 夹具与真实日志回归）
- `TUI/README.md` / `TUI/docs/SPEC.md`（口径）
- 追踪文档一份（本文件）
- 不改宿主代码；根包委托清单不变。

## 实现记录

- 2026-10-20：调研完成（宿主源码 + 本机真实会话日志解压实测），结论写入「调研」节；四点裁定提案送主分支 ui-ravine-5e31。
- 2026-10-20：主分支修正裁定——承载改 **TUI 包内**（依据归档决策 6-8，先例 tui_local_log），② ③ ④ 维持已认可口径；按裁定更新「决策」「规划」节。
- 2026-10-20：实现（TUI 包内）——
  - `TUI/src/app/adapter/notice-history.ts`（新）：`scanZstdFrames`（复刻宿主帧定位，含尾部残留容忍）、`decodeSessionLogText`（`node:zlib.zstdDecompressSync` 逐帧解压，`zstd` 缺失抛明确错误，坏帧跳过计数）、`parseNoticeEntries`（`user/message` + `agent/inbox/spliced.inserted` 两处抽取 `source.form==='notice'`，按消息 id 去重，坏行/非 notice 跳过，带 `source.kind`/`summary`/正文/事件 `time`/`seq`）、`readNoticeHistory`（错误语义：非法 id / 目录未定位 → ok=false 明确报错；日志缺失 → ok=true + 说明；kind 过滤 + 最近 N 切片，limit 缺省 20 上限 200）。
  - `TUI/src/app/adapter/notice-history-tool.ts`（新）：模型侧工具 `notice_history`（参数 `kind`/`limit`/`session_id`，缺省当前调用方会话；结构化结果 + 预渲染文本；kind 过滤实现在 `source.kind`）。
  - `TUI/src/main.ts`：注册 `notice_history`（与 `tui_local_log` 同块、同 try/catch/effect 释放口径）。
  - `TUI/tests/notice-history.test.ts`（新）：18 例（帧扫描 / 多帧解压还原 / 撕裂与坏帧 / notice 抽取去重 / 错误语义 / kind+limit / 明文回落 / 工具参数归一与渲染 / 临时会话根注入）。
  - `TUI/README.md` / `TUI/docs/SPEC.md`：口径节各补一段。
- 2026-10-20：验证——`npm run check` 通过；TUI 全量 1679 例通过（含新增 18 例）；`npm run build` 通过；**产物级**（`dist/src/app/adapter/notice-history-tool.js`）对真实多帧日志（background-daemon 会话，1208 帧 / 1.9 MB）`notice_history.execute` 读回 4 条 notice 全文，渲染正确。

## 偏差

- 承载形态按主分支修正裁定为 **TUI 包内**（原提案为新插件包）；根 `package.json` 委托清单不变。
- 落点解析用 TUI adapter 既有 `locateSessionDir` / `sessionRoots`（`app/adapter/session-paths.ts`，本地编码 + id 白名单 + realpath 包含性校验），而非 session-paths 插件服务的 `sessionDirFor`——与 `tui_local_log` 同口径（TUI 包内自足），同样满足「落 `<DSH_HOME>/sessions` 下、不越权」。
- `kind` 过滤实现在 `source.kind`（生产者类别）；条目判别字段 `source.form` 恒为 `'notice'` 本身无过滤区分度（详见「决策」节，已向主分支明示）。**主分支 2026-10-20 确认认可**：`source.kind` 实现更合理，无需改代码。
- 真实主机注册面（fff profile 加载后 `notice_history` 出现在宿主工具清单、模型可调用）**未在本机复验**——profile TUI 链接指向主检出，需合并后生效；工具注册代码与 `tui_local_log` 完全同构（后者已 2026-10-20 真机验证），单测 + 产物级数据面实测已覆盖实现风险。**主分支 2026-10-20 确认接受**按 `tui_local_log` 先例：合并 + 重建 dist + 重启后由主分支复验（与 2026-10-19 任务同一路径）。

## 测试与证据

- `TUI` 单包：`npm run check`（tsc --noEmit）通过；`npm test` 全量 **1679 例通过 / 0 失败**（含新增 `tests/notice-history.test.ts` 18 例）；`npm run build` 通过。
- 新增测试覆盖：帧定位（单帧 / 多帧 / 尾部残留 / 非 zstd）、多帧解压字节级还原、坏帧跳过、notice 抽取与 `user/message`+`spliced` 同 id 去重、非 notice 与坏行跳过、错误语义（非法 id / 目录未定位 / 日志缺失三态）、最近 N 切片、kind 过滤、limit 钳制、明文回落、工具参数归一、会话未知与目录未定位明确报错、渲染。
- 真实数据面（本机 `~/.dsh/sessions`）：background-daemon 会话（`tui-382965e7`，`session.v4.jsonl.zstd` 1.9 MB / 1208 帧）解压 6.4 MB / 数千行，`notice_history` 读回 4 条 tool-jobs notice 全文（含 summary 与原文），kind 过滤与 limit 生效；`--home-guochang-Projects-dsh-toolset--` 主会话日志（2.2 MB / 1525 帧）约 20 ms 全量解压。
- 未验证：真实 fff profile 下工具注册与模型调用（待合并后复验）。

## 收尾

（已完成，2026-10-20 收尾。）

- 主分支 ui-ravine-5e31 确认：① `kind` 过滤按 `source.kind` 实现获认可；② 真机注册面接受按 `tui_local_log` 先例（合并 + 重建 + 重启后由主分支复验）；③ 同意关闭条目 4，收尾提交为该任务最后一次提交。
- 提交：f1（feat，实现 + 测试 + README/SPEC 口径）；f2（docs，本文件状态关闭 + 收尾节 + BACKLOG 清理 + 归档移动）；commit id 见 git log。
- BACKLOG 清理：`docs/BACKLOG.md` 条目 4「模型按需检索 notice 历史原文（compaction 后取回）」已标完成并从 §2 移除（注记见该文件头部）。
- 归档：本文件移入 `docs/archived/2026-10-20-notice-history-query.md`。
- 遗留：真实 fff profile 注册面待主分支合并 + `npm run build` + 重启后复验（`notice_history` 出现在宿主工具清单、模型可调用）。
