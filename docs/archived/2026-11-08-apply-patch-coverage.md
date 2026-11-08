# apply_patch 写面覆盖（接取条目：docs/BACKLOG.md「apply_patch 写面覆盖: security-guard 与 escalation-hint」）

状态：已完成　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 启用 `apply_patch` 工具前补齐写面覆盖：`security-guard` 的 `FILE_TOOLS` / `WRITE_FILE_TOOLS` 未登记它（参数只有 `input` 补丁文本, 目标路径藏在补丁文本里）——从补丁文本解析目标路径, 或把整工具按写类拒绝。
2. `escalation-hint` 的 write / edit 类提示补 `apply_patch` 的同类提示。
3. 同步 `security-guard` / `escalation-hint` 两份 README 的覆盖边界说明。
4. 保持 rc.1 出厂 `applyPatch: false`（本任务只补覆盖面, 不启用工具；启用与否的取舍见「宿主升级待裁定」条目）。

## 决策（2026-11-08 用户批准 A 档）

| 编号 | 决策项 | 结论 |
| --- | --- | --- |
| 1 | 覆盖方式 | 解析补丁文本的四类路径标记（不做整工具拒绝） |
| 2 | 登记位置 | 走官方工具分支: `FILE_TOOLS` + `WRITE_FILE_TOOLS` |
| 3 | 读写面 | 一律 `write`（回执写「写入」） |
| 4 | 解析不出路径 | 放行, 并把边界写进 README |
| 5 | `escalation-hint` | 缺省文件族加 `apply_patch` |
| 6 | 是否启用 | 维持 `applyPatch: false` |

## 计划改动文件清单

- `security-guard/src/tool-registry.ts`（`FILE_TOOLS` / `WRITE_FILE_TOOLS` 加 `apply_patch`）
- `security-guard/src/sensitive.ts`（新增 `extractPatchPaths`）
- `security-guard/src/engine.ts`（官方文件工具分支对 `apply_patch` 走补丁解析）
- `security-guard/src/index.ts`（重新导出 `extractPatchPaths`）
- `security-guard/tests/sensitive.test.ts` / `tests/guard.test.ts`（解析器用例 + 端到端 deny / allow 用例 + 回执措辞）
- `security-guard/README.md`（敏感文件来源行 + `apply_patch` 覆盖与边界段）
- `escalation-hint/src/index.ts`（`DEFAULT_FILE_TOOLS` 加 `apply_patch`）
- `escalation-hint/tests/judge.test.ts`（工具族与提示用例）
- `escalation-hint/README.md`（文件族与配置表）
- `docs/implementation/2026-11-08-apply-patch-coverage.md`（本文件）

## 实现记录

1. `security-guard/src/tool-registry.ts:11-32`：`FILE_TOOLS` 与 `WRITE_FILE_TOOLS` 都加 `apply_patch`, 注释写明它的路径来自补丁标记行而不是参数键。
2. `security-guard/src/sensitive.ts:179-206`：新增纯函数 `extractPatchPaths(patch)`, 按行首匹配 `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:`, 取标记后整段文本, 去两端空白与成对引号, 同一路径去重, 空路径丢弃。
3. `security-guard/src/engine.ts:220-238`：官方文件工具分支里对 `apply_patch` 读 `input` 走 `extractPatchPaths`, 其余文件工具仍走 `FILE_PATH_KEYS`。
4. `security-guard/src/index.ts`：`extractPatchPaths` 加入重新导出面。
5. `escalation-hint/src/index.ts:30-35`：`DEFAULT_FILE_TOOLS` 加 `apply_patch`（配置注释同步）。
6. 两份 README 同步：`security-guard/README.md` 拦截面表格行 + 新增 `apply_patch` 覆盖段（含两条残留边界）；`escalation-hint/README.md` 文件族表格与 `fileTools` 缺省值。

## 验证

- `pnpm -C security-guard run check` / `run test`：通过 / 166 例全绿（新增解析器 2 例、端到端 deny 1 例、allow 1 例、回执措辞 1 例）。
- `pnpm -C escalation-hint run check` / `run test`：通过 / 51 例全绿（新增 `apply_patch` 工具族与提示 1 例）。
- 可观察行为: 补丁写 `~/.ssh/config` / `~/.aws/credentials` / `.env` / `config/.env.local` 均被拦; 工作区内补丁与无标记文本放行; 回执标「写入」。

## 未覆盖

- 未启用工具（`applyPatch: false`）, 故未做真机补丁调用的拦截观察。
- 相对路径窄面（含 `/` 的绝对目录规则对相对书写路径不生效）与 `normalizePath` 的同源口径, 只在 README 记边界, 未在代码层修（要接会话工作目录, 属独立条目）。
