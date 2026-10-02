# `unknownToolPolicy` 的逃生门与脚本口径（接取条目：`docs/BACKLOG.md` #1）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

修掉 `2c0991c` 的两个 P1 问题（子代理 `14adcc02` 审阅）：
① 开 `deny` 会 **100% 拦死在用工具** `present`（唯一必填 `files[].path`）与 `workflow`（`script`），且**配置面无 per-tool 逃生门**（回执只说「改源码登记」）；
② 差异检查脚本 `tool-surface-check.mjs` 三分类**不可用**（报「需关注 13」而引擎真 deny 集 4；漏 `workflow`/`subagent`；默认根下 142 条噪声含 `id`/`name` 等非工具名；「带参数」是包级文本 grep）。

## 决策

- **D1（新增 `check` 模式，主修）**：`unknownToolPolicy: "allow" | "check" | "deny"`（缺省 `"allow"` 不变）。取 `"check"`：对「未登记且携带 watched 键」的工具**不整工具硬拦**，而是把 watched 键下的**字符串值**过**既有两层**（敏感文件层按路径语义 + 命令黑名单层），命中才拦、否则放行 —— `present` 普通路径放行、敏感路径照拦；`workflow` 的 `script` 走命令层。这样逃生门是**配置级**的，不必改源码。
- **D2（`unknownToolAllowlist`）**：`string[]`（工具名，支持 `*` 前缀通配）——命中即**无条件放行**（在策略之前判定）；用于 `deny` 模式下的显式例外与 MCP 工具名。
- **D3（`deny` 保留但不再唯一）**：`deny` 语义不变（整工具拦），但 (a) 先过 `unknownToolAllowlist`；(b) 回执**给出可行动作**：`unknownToolPolicy: "check"`、`unknownToolAllowlist: [...]`、或按参数面登记进 `FILE_TOOLS` / 两张登记表（不再只提「改源码」）。
- **D4（键集单一来源 + 补漏）**：watched 键集抽为**单一常量**并被脚本复用（脚本从 `dist` 动态 import 或读同源 JSON）；补 `root` / `workdir` / `cwd` / `filePath`（驼峰归一 `filepath`）；**值面**扫描：字符串值里以 `cwd:` 前缀或明显绝对路径（`/`、`~/`）开头者，也纳入 check 模式的路径判定。
- **D5（脚本改按 schema 判定）**：解析工具包 `parameters` 里的 `properties` 对象字面量，**逐工具**取参数键（不再整包文本 grep）；`name:` 为计算值（`workflow` / `subagent` / `subagent_fork`）时单列「名称未解析 + 包名」行；默认根**不再回退 $HOME**：无 `--root` 且无 `DSH_INSTALL` 时打印用法并 **exit 2**（避免 142 条噪声与「静默绿」）；`--root` 指到 scope 目录（无 `dsh-tool-*`）时给**可读纠正提示**（要指 dsh 包目录）。
- **D6（`policy()` 暴露 + 非法值可观测）**：`policy()` 增加 `unknownToolPolicy`（含**原始值 / 生效值 / 是否非法**）与 `unknownToolAllowlist`；非法值（如 `"Deny"`、`true`）→ **warn 一次** + 按 `"allow"` 生效（保持兼容），并在快照里标 `invalid: true`，TUI `/guard` 能看见。
- **D7（发布面）**：`security-guard/package.json` 的 `files` 增加 `scripts/`。
- **D8（文档）**：README 三模式 + allowlist + 回执可行动作 + 脚本新口径与 `--root` 正确指法；`docs/host/HOST-UPGRADE-0.2.0-rc.2.md` §5 增一行「升版后跑 `tool-surface-check`」。
- **D9（不做）**：`#2` 的两项（两层嵌套递归深度、④ 对等断言的鉴别力）留给 `#2`；不引入按 schema 类型判定；不做默认 deny。
- **D10（验证）**：`security-guard` check/build/test + 反向验证（check 模式命中/放行各撤一处必失败）；脚本 fixture 用例（含「名称未解析」行与 exit 2）；全仓 check/test/build；真机：开 `check` 后 `present` 可用、敏感路径被拦。

## 计划改动文件清单

- `security-guard/src/index.ts`（模式 / allowlist / 键集 / 回执 / policy）、`security-guard/scripts/tool-surface-check.mjs`、`security-guard/tests/{guard.test.ts, script.test.ts 新建}`、`security-guard/package.json`、`security-guard/README.md`、`docs/host/HOST-UPGRADE-0.2.0-rc.2.md`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 交子代理审阅本文件「决策」。
1. 实现 + 测试 + 反向验证 + 全仓 `check` / `build` / `test`。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02）

- `src/index.ts`（+358）：`unknownToolPolicy: "allow" | "check" | "deny"` + `unknownToolAllowlist`（精确 + `*` 结尾前缀通配，`"*"` = 全放行）；键集抽为**单一来源常量**并导出 `TOOL_SURFACE` 快照（新增**代码键** `script`/`code`/`program`，路径键补 `root`/`workdir`/`cwd`/`filePath`，键名**小写归一**）；`check` 模式按键类定向派发 —— 命令键（`command`/`measureCmd`/`cmd`）→ 命令层；路径键 + 值面兜底（`cwd:` 前缀 / 绝对路径 / `~`）→ 敏感层；**代码键只做路径提取**（不整段送命令层，避免 JS 脚本误报）；回执首行给来源标注 + 复用既有 `formatCommandReceipt` / `formatSensitiveReceipt`。
- `deny` 保留（先过 allowlist），回执改**三条可行动作**（改 `unknownToolPolicy: "check"` / 配 `unknownToolAllowlist` / 按参数面登记进 `FILE_TOOLS` / 两张登记表）。
- `policy()` 增 `unknownToolPolicy{value,effective,invalid}` 与 `unknownToolAllowlist`；非法值 `console.warn` 一次 + 按 `allow` 生效 + `invalid:true`。
- `scripts/tool-surface-check.mjs` 重写（+838）：逐工具解析 `parameters`（**顶层键即参数名**，对象取 `properties`、数组取 `items.properties`，深度与引擎一致）；`name:` 为计算值单列「名称未解析」且其参数键命中 watched 时仍计入门禁；三分类去重；退出码 0/1/2（无 `--root`/`DSH_INSTALL` 不回退 cwd → exit 2；scope 层 → 纠正提示 + exit 2；键集 **dist 优先 / src 仓库内回退**，都不可用 → exit 2「先 npm run build」）。
- 其它：`package.json` `files += scripts/`（只手工改 files，未过 jq 以免整文件重排）；README（三态 + allowlist + 回执动作 + 脚本口径与 `--root` 指法 + 键名大小写不敏感）；`docs/host/HOST-UPGRADE-0.2.0-rc.2.md` §5 增一行「升版后跑 tool-surface-check」。

## 测试与证据（2026-10-02）

- `security-guard`：`check` exit 0、`build` exit 0、**91/91 全绿**（blacklist 9 + guard 66 + script 9 + sensitive 7；改前 70 → +21）。
- **反向验证两态**（实现者 + 父会话复核）：撤 `check` 派发 → **83 pass / 6 fail**（失败全为 check 用例）；撤 allowlist 早退 → **88 pass / 1 fail**；还原后 91/91，`src/index.ts` md5 与备份一致，无变异残留。
- **脚本 fixture + exit 码实测**（假宿主树 5 包）：需关注 3 + 名称未解析 1 + 未覆盖无参数 1 → exit 1；干净宿主 exit 0；无 root exit 2；两种 scope 形态 exit 2 + 纠正提示；缺值/未知参数/空目录 exit 2；损坏安装 exit 2 + build 提示；发布形态（仅 dist + scripts）键集来源 dist 且与 src 输出一致。
- **真实宿主实测**：21 包 / 33 工具 / 已覆盖 8（去重）/ **需关注 3**（`present`(path)、`str_replace_editor`(path+command)、计算名 `workflow`(script)）/ 名称未解析 2 / 未覆盖无参数 19 → exit 1（对比旧脚本：覆盖 10 含重复、需关注 13 含 `create_goal`/`web_fetch` 等文本噪声）。
- 全仓：`npm run check` exit 0、`npm run test` **20 包全 `fail 0`**、`npm run build` exit 0（父会话复跑）。
- **审阅（`6da04f1f`）结论：有条件通过** —— 三条 P1 均已按更正口径落地：① D5 解析口径（顶层键 + 递归 `properties`/`items.properties`，不再漏 `files`/`script`）；② D7 发布面（脚本 dist 优先 + src 回退 + 缺则 exit 2，`files += scripts/`）；③ `check` 残余误报（代码键降级为只做路径提取）。另采纳：D2 通配语义以「`*` 结尾」为准、D6 措辞改为「`policy()` 暴露，TUI 后续消费」、D3 回执补配置指法、README 写明键名大小写不敏感。审阅实测「引擎真会 deny 的 4 个工具」已列名：`present`、`str_replace_editor`、计算名 `workflow`、agent-team 的 `send_message`/`interrupt_agent`（`target`）。

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 决定采纳项：脚本「dist 缺失/过期 → 回退 src 并提示，两者都不可用才 exit 2」（不采用严格 dist-only：dist 未入库，严格口径会让干净检出的 `npm test` 变红）。
- 残余：① `npm run smoke` 未跑（需真机 dsh + 模型 API + zstd）；② TUI `/guard` 未渲染策略字段（不在本条目清单，`policy()` 已暴露）；③ **两层嵌套**（`children[].executor.command`）仍漏 → 归 `#2`（其描述已含）；④ 真机未验证「profile 切 `check` 后 `present`/`workflow` 实跑」；⑤ `docs/STATUS.md` 按流程不改，留 `#6` 统一对齐。
