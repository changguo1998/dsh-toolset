# agent-group 待办

> 职责：本包（群组编排）未完成项：缺陷、二期能力、联调与接线跟进
> 不负责：已完成项的历史（见 git 历史与 `docs/DESIGN.md`）、跨包条目（见项目级 `docs/BACKLOG.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**，不用于跨引用；每次整理时从 1 起重新编号
> 本文件只列**未完成**项。设计依据：`docs/implementation/2026-10-16-peer-group-protocol-design.md`（决策项 20 的首期 / 二期划分）。

## 1. 缺陷与联调

**#1 真机联调未做（两个会话各挂本插件跑通全流程）**（2026-10-17 登记）：**现象 / 现状** —— 本批只做了单测（纯模型 / 动作层假传输 / 接入面假宿主），没有在真机两个会话间跑过 `create_group → add_member → link → send → check → remove`；`<会话目录>/agent-group.json` 的真实落点、镜像行能否用 memory 的 `search({kind: "agent_group"})` 查到，都只有单测依据。**期望** —— 起两个会话（各挂 session-channel / session-paths / agent-group），一个建组并把另一个加为成员，跑完整流程；确认状态文件生成且为 0600，memory-base 已挂时能按 `kind` 检索到镜像行。**落点** —— 无代码改动（除非联调暴露问题）。**验收** —— 上述流程在真机上走通，回报正文与成因在 `check` 结果里正确出现。**优先级** —— P1（首次上真机前的必做项）。

**#2 接线未做（根清单 / 安装脚本 / profile 示例 / 文档计数）**（2026-10-17 登记）：**现象 / 现状** —— 本包自己的 `package.json` / `cordis.patch.yml` 齐备，但根 `package.json` 的 `check` / `build` 链、`scripts/test-parallel.sh` 的 `default_pkgs`、`scripts/install.sh` 的 `canonical_pkgs`、`profiles/example/cordis.patch.yml`、根 `README.md` / `README.zh.md`、`AGENTS.md`、`docs/BACKLOG.md` §4 都还没有本包（用户 2026-10-17 指示：其他模块并行开发中，先不碰共享清单）。**期望** —— 由项目级条目「五个新插件落地时的仓库清单与包计数统一」统一收口时一并加；`profiles/example` 里本包要排在 `session-channel` 与 `session-paths` 之后（依赖先注册）。**落点** —— 上述七处。**验收** —— `npm run check` / `build` / `test` 全绿含本包；`scripts/install.sh --dry-run` 清单含本包；`scripts/test-install.sh` 通过。**优先级** —— P2（不阻塞本包单测，阻塞安装与真机联调）。

**#3 测试已写但未运行**（2026-10-17 登记）：**现象 / 现状** —— `tests/model.test.ts`、`tests/core.test.ts`、`tests/main.test.ts` 已按验收细化 1-9 条写齐，但用户 2026-10-17 指示「编写好测试但不要运行，停下等待指令」。**期望** —— 并行开发结束后跑 `npm --prefix agent-group run check` 与 `npm --prefix agent-group run test`，按结果修。**落点** —— `agent-group/tests/**`。**验收** —— 三个测试文件全绿。**优先级** —— P0（本批收尾的第一步）。

## 2. 二期能力（设计决策项 20 的「二期」）

**#4 广播与平等连接**（2026-10-17 登记）：**现象 / 现状** —— 首期只有主从连接（单向指令 + 必须回报）；平等连接（双向、发完即走、不留状态）与广播（一条指令发多人）都没有实现，`link` 只建主从。**期望** —— 按决策项 4 / 6 / 20 落地：平等连接不记等级、不记未结指令；广播按当前成员集合展开并汇总每条送达结果；「任意两个 agent 之间每种连接至多一条」的校验。**落点** —— `src/model.ts`（连接类型与校验）、`src/core.ts`（新动作）、`src/types.ts`、测试。**验收** —— 每对 agent 两种连接各至多一条；广播的逐条送达 / 失败可区分；平等连接不产生未结指令。**优先级** —— P2。

**#5 TUI 命令或面板**（2026-10-17 登记）：**现象 / 现状** —— 只读查看只有模型侧工具 `status`；人要看组状态得让模型调工具。**期望** —— TUI 侧命令（如 `/group`）或状态列，复用服务面 / 工具结果。**落点** —— `TUI/src/app/**`（归 TUI 模块的实现）。**优先级** —— P3。

**#6 轮次与终止的三个细节**（2026-10-17 登记）：**现象 / 现状** —— 决策项 15 / 20 明确首期不建模轮次；等待上限（`timeoutMs`）目前是每条指令的参数（缺省 30 分钟），没有「全组预算」「检查间隔」「关闭组的边界语义」。**期望** —— 用户另行裁定后落地；在此之前用 `timeoutMs` + `check` 手动控制。**优先级** —— P3（等用户定）。
