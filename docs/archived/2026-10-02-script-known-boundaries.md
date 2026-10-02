# 差异检查脚本的已知边界（接取条目：`docs/BACKLOG.md`「差异检查脚本的已知边界」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标（四项，拆两批）

1. **① 符号链接包目录被跳过**（`entry.isDirectory()` 不跟随 symlink）→ pnpm 风格软链树整体漏扫（**预存在行为**，本次修）。
1. **② `seenPkgs` 按包名去重**：同名包的**外层 stub 可能遮蔽内层真实包**（首个副本无 `defineTool(` 即整包静默丢弃）→ 修。
1. ③ 「仅含 `parameters:` 的包不纳入」存在**潜在假阴性**（纯对象 `tools.register({ name, parameters })` 注册；今日 0 漏报）。
1. ④ **动态参数工厂**（`parameters: normalized.spec`）→ 包计入面、工具解析 0（动态注册看不见）。

## 决策（本批 = ①②；③④ 另立条目）

- **D1（symlink 跟随）**：包目录判定由 `entry.isDirectory()` 放宽为 `isDir()`（`statSync().isDirectory()`，**跟随软链**）；`collectScope`、`findToolPackages` 的内嵌下钻、`isScopeLayer` **三处**同改（审阅订正：原写「两处」）；环/终止的实际界是 `maxDepth = 8`（`seen` 存路径串、不按 realpath 去重）。
- **D2（同名遮蔽修正）**：`seenPkgs` 改为**按内容择优**：`defineTool(` 命中优先于 `parameters:`-only；即先记为 `parameters:`-only 的包，后续副本含 `defineTool(` 时**升级**为面内包（保持「同一包名只报一次」）。
- **D3（测试）**：① symlink fixture：真包在别处、`@deepseek-ai/<pkg>` 是**软链** → 工具被计入（旧实现 exit 0/未找到）；② 同名遮蔽：外层 stub（无 `defineTool(`）+ 内层真包（含） → 真包被计入且只报一次。
- **D4（反向验证）**：撤 D1（退回 isDirectory）→ ① 必失败；撤 D2（退回首个即定）→ ② 必失败；各自还原逐字节。
- **D5（文档）**：README 差异检查小节补「跟符号链接」一句；BACKLOG 新增条目覆盖 ③④（含动态参数工厂）。
- **D6（不做）**：不改判定/键集/退出码；不做 MCP 运行时探测；不改其它包。

## 计划改动文件清单

- `security-guard/scripts/tool-surface-check.mjs`、`security-guard/tests/script.test.ts`、`security-guard/README.md`
- `docs/BACKLOG.md`（标进行中 → 关闭；③④ 另立条目）、本追踪文档

## 待办

1. 实现 ①② + 测试 + 反向验证 + 包与根验证。
1. 交子代理审阅（只读）→ 关闭 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02，父会话直接实现）

- `scripts/tool-surface-check.mjs`：**① 跟随符号链接** —— 三处包目录判定改用既有 `isDir()`（`statSync().isDirectory()`；`Dirent.isDirectory()` 对软链为 false 会整树漏扫）；**② 同名多副本按内容择优** —— `found.some(name)` / `seenPkgs` 双向拦住重复，非面内 stub 先到也会在之后真包出现时**升级**并把该名从 `parametersOnly` 摘除；同名只报一次。判定/键集/退出码语义未动。
- `tests/script.test.ts`（+2）：软链 fixture（真包在 `store/`、scope 里是软链 → 工具被解析）；同名遮蔽（外层 stub `parameters:`-only + 内层真包 → 真包工具被解析、`--json.packages===1`、`parametersOnly` 不含该名）。
- `README.md`：补「两条实现细节」（跟随软链 / 同名择优）+ **两条窄边界**（评审补充）：择优只覆盖「非面内 stub」（外层文本里出现 `defineTool(` 字样仍会遮蔽）；异名同实体（真目录 + 软链）会各计一次（未按 realpath 去重）。
- `docs/BACKLOG.md`：③④（纯对象注册不可见 / 动态参数工厂）**re-file 为新条目**（本条目只做 ①②）。

## 测试与证据（2026-10-02）

- `security-guard`：`check` exit 0、**116/116 全绿**（原 114 → +2）。
- **反向验证两轮**：① 三处退回 `entry.isDirectory()` → **恰 1 例红**（软链用例）；② 同名择优退回「首个副本即定」→ **恰 1 例红**（同名用例）；两次还原后 `scripts/tool-surface-check.mjs` sha256 **逐字节一致**（`b674b2ec…`）→ 116/116。
- **真实宿主**：27 包 / 49 工具 / 需关注 8 / 提示 6 包，**与改动前逐字节一致**（`diff` 无差异）；宿主安装树内 0 个 `dsh-*` 软链 → 不多不少。
- 全仓：`npm run check` exit 0、`npm run test` **20 包全 `fail 0`**。

## 审阅（子代理 `b56dc302`）——结论：**有条件通过**（无 P1/P2）→ 处置

| 审阅发现 | 处置 |
|---|---|
| 三处改动一致、全文件无残留 `Dirent.isDirectory()`；自环 fixture 正常终止（无挂起）；真宿主 0 软链 | 已确认 |
| 择优三序（先 stub 后真包 / 先真包后 stub / 多真包）均「只报一次」，`found ∩ parametersOnly = ∅` | 已确认 |
| 反向验证两条均**恰 1 例红**、还原 116/116（审阅独立在 /tmp 副本复现） | 已确认 |
| **P4**：新 `isPkgDir()` 与既有 `isDir()` 逐字重复 | 已删除重复函数、统一用 `isDir()`（4 处调用点） |
| **P3**：README「外层 stub 不得遮蔽」写成一般性质（注释型 `defineTool(` 字样仍遮蔽、静默假阴性） | README 已补窄边界 (a) |
| **P3**：异名同实体（真目录 + 软链）会各计一次 | README 已补窄边界 (b) |
| 漏项：D1 写「两处同改」（实为三处）、「不引入循环（`seen` 已有）」不准确（真实界是 `maxDepth=8`） | 已订正 |
| 漏项：BACKLOG 新条目 4 的 `dsh-subagent-in-process-driver` 佐证与结论不匹配（该包**恰在**提示行） | 已订正为「真正的风险是连 `parameters:` 子串都不出现的纯对象注册包」 |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：① 注释/再导出型 stub 仍会遮蔽内层真包（README 已记）；② 异名同实体重复计数（未按 realpath 去重，窄）；③ ③④（纯对象注册不可见 / 动态参数工厂）已 re-file 为新条目跟进。
