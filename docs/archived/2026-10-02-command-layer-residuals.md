# 命令层条目审阅的三项低优先残余（接取条目：`docs/BACKLOG.md` #3）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标（三条，全部来自命令层条目的子代理审阅）

1. **README 快照措辞失准**：`security-guard/README.md` 称「从 `snapshotPath` 快照**恢复**的既有帧」，但本插件只**写**不读（`task-engine/src/main.ts` 仅透传 `snapshotPath`、unload 时 `writeSnapshot`）；恢复能力是导出的纯 API `resumeFromSnapshot`（`task-engine/src/engine.ts:800`），**插件当前未接线**。→ 措辞改为「经 `resumeFromSnapshot` 恢复的帧（本仓插件当前未接线）」。
1. **宿主日志首行丢规则 id**：`security-guard/src/index.ts`（约 :610-616）用回执**首行**写日志；插件命令工具的回执首行是**来源标注行**（「拦截来源：插件命令工具「X」的命令参数（键路径）」）→ 日志不再含规则 id（`bash` 路径不变）。→ 取**两行**（来源 + 规则摘要）或把来源行移到回执**末尾**（择一，保证日志含规则 id；不破坏既有回执断言）。
1. **两条测试缺口**：① 「命令层 + 敏感层同时命中」用例（实测命令层先返回、敏感层不再出现在回执里 —— 该顺序未在 README 声明，顺带补一句）；② `allowPatterns` 对插件命令层的**正向**放行断言（现只有「不放开敏感层」的反向断言）。

## 决策

- **D1（README）**：按第 1 条改措辞；不新增能力描述。
- **D2（日志）**：选「把来源行移到回执**末尾**」——对既有断言影响最小（首行回到规则摘要），并保留来源信息；若实现时发现既有断言依赖来源行在首行，则改为「日志取前两行」。
- **D3（测试）**：补第 3 条两条用例（同命中顺序、`allowPatterns` 正向放行），并在 README 写明「命令层先于敏感层，同命中时只回命令层」。
- **D4（顺手项）**：把 `tests/guard.test.ts` 里 `assert.doesNotMatch(hit, /写入/)` 改为断言操作标签（`/已拦截：读取敏感文件/`），避免路径名含「写入」误判（审阅 P4 提示）。
- **D5（不做）**：不改判定逻辑、不扩登记表、不动其它包。
- **D6（验证）**：`security-guard` check/build/test；反向/鉴别力：新用例在**去掉对应实现**时必失败（③① 可用「临时禁用命令层」验证）；全仓 `check` / `build` / `test`；提交前残留自查。

## 计划改动文件清单

- `security-guard/README.md`、`security-guard/src/index.ts`（回执行序）、`security-guard/tests/guard.test.ts`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 交子代理审阅本文件「决策」。
1. 实现 + 测试 + 验证 + 全仓 `check` / `build` / `test`。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 收尾记录（2026-10-02，父会话）

- **D1 ✅**：`security-guard/README.md` 快照措辞改为「经导出 API `resumeFromSnapshot` 恢复的帧（本仓库插件当前未接线：只写快照、不读回）」。
- **D2 ✅**（口径修正版）：`src/index.ts` 日志从「回执首行」改为「**前两行**」（插件命令工具首行是来源标注行，只取首行会丢规则 id）；**未**改动任何回执行的顺序，也未动 `inspectCommand`（避免与 metric-loop 条目的来源标注入口径冲突）。
- **D3 ✅**：`tests/guard.test.ts` 新增两例 ——「命令层 + 敏感层同时命中：只回命令层（来源标注 + 规则 id，不含敏感层文案）」「插件命令工具：`allowPatterns` 正向放行（对照：不匹配 / 空的 allowPatterns 仍被拦）」（由子代理落地；我另写的两条重复用例已删除，保留前者）。
- **D4 ✅**：`tests/guard.test.ts` 四处 `assert.doesNotMatch(hit!, /写入/)` 改为断言操作标签 `assert.match(hit!, /已拦截：读取敏感文件/)`（实测四处均属读侧）。
- 顺带（审阅问题 ③）：`security-guard/README.md` 服务面条目补 `inspectCommand(command, source?)` 说明。
- **验证**：`security-guard` `npm run check` exit 0、`build` exit 0、`npm run test` **67/67 全绿**（改前 65，+2）；全仓 `npm run check` exit 0、`npm run test` **20 包全 `fail 0`**。
- 残余：① D3 反向验证的完整两态结论由落地子代理产出，未回传（用例含对照臂，具备区分度）；② README 未提「命令层先于敏感层」的顺序说明（若需要另开条目）；③ 真机未验。
- 条目从项目级 `docs/BACKLOG.md` 清理；追踪文档移入 `docs/archived/`。
