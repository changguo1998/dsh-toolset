# 模型请求路由与速度控制 `llm-router`（接取条目：`docs/BACKLOG.md`「模型请求路由与速度控制（意向）」）

状态：关闭　　开启：2026-10-11　　关闭：2026-10-11
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

条目为**意向**（2026-10-10 用户提出，仅登记防遗忘），开工动作即"先讨论四件事"：路由范围、速度含义、与既有能力（宿主路由 / `command-template` 模板级模型选择 / 官方 `llm-retry`，尤其与已取消的 `rate-guard`）的分工、集成面。

本任务目标 = **走完这轮讨论并把结论落定**，据此决定：自研插件、采用现成网关、或退回观察项。

## 调研

- 宿主侧接口已核（详见「宿主侧依据」）：路由的唯一决定点是 `agent/request` waterfall，重试决定点是 `agent/request-error`（`llm-retry` 所在），传输层是 `llm/stream`；**在 `llm/stream` 改 provider 对主链路无效**（上游已解析成具体适配器）。
- 本机现状已核：`~/.kimi-code/config.toml` 已把 5 个上游指向与 dsh 相同的地址（USTC `api.llm.ustc.edu.cn`、`GeoLLM`、ARK `api/plan/v3` 与 `api/coding/v3`），即 kimi 与 dsh 当前共享同一 USTC 网关与同一份 ARK 配额池；本机另有 `arkcli`、`pi`、`codex`。
- 现成方案调研（2026-10-11，网络）：自托管开源网关横向对比与各项目官方文档。结论见「决策」。
- 完整调研与设计记录：`~/temporary/2026-10-11-model-router-proxy-design.md`（**工作区外**，非本仓文档；含需求清单、硬约束、现成方案对照表、选型决定与六步验证顺序）。本文件只记决策与收尾，不重复其内容。

## 决策

- **D1 形态：不做仓内插件，采用现成开源网关。** 决定性理由 = 需求方明确「限速要覆盖机器上所有 agent」，进程内插件只能限住 dsh 一条链，管不到 kimi / codex / arkcli / pi。网关成为本机唯一模型出口。排除项：Higress / Envoy AI Gateway（需 K8s）、CrossLink（过新）、CLIProxyAPI / sub2api / OmniRoute 一类账号池（厂商 ToS 与封号风险）。
- **D2 主选 Bifrost，先试。** 单个 Go 静态二进制或一条 docker 命令，无数据库 / 无 Redis；自带 Web 界面配置与监控；独立实测开销最低（+0.62 ms/请求）；维护活跃、安全记录最干净（1 个高危已修）。**钉住版本**：`/v1/messages` 传输层跨版本变过。
- **D3 备选 LiteLLM，仅当 Bifrost 实测不过关时启用。** 功能最全、社区最大（资料多）；但部署重（Python + 数据库，生产形态常需 Redis）、开销约为 Bifrost 的 9 倍；安全记录差（2026 年 12 个公告、3 个严重），**必须 ≥ 1.84.0 且管理面板绝不暴露公网**；升级快、配置项偶有改名。
- **D4 排除 new-api**：其价值在多用户 key 分发与计费面板，本场景不需要。
- **D5 决定性判据**：网关最常见的故障不是路由，而是工具调用 / 思考块 / 流式翻译被破坏；实测必须把 dsh 的真实会话（带工具调用、推理内容、长流）过一遍网关，只发 hello world 无效。
- **明确不做**：本任务不新增任何包、不改 profile、不写代理代码、不改各 agent 的 base URL（属后续开工动作）；不因本次结论修改 `docs/ROADMAP.md`（该文件记未来开发方向，本决策不产生仓内开发项）。

## 规划

计划改动文件清单（按顺序）：

1. `docs/BACKLOG.md` —— 所接取条目（意向 → 完成后按规范清理移除；§1 补一条「已关闭 / 不再立项」记录）
1. `docs/archived/2026-10-11-llm-router-decision.md` —— 本追踪文档（本任务唯一过程记录）

明确不做：见「决策」末条。

## 收尾

- 条目：`docs/BACKLOG.md`「模型请求路由与速度控制（意向）」已标「完成」，并按规范从 §4 清理移除（该节只留未完成项）；§1「已取消 / 不再立项」索引补记本决策，指向本文件。
- 回写：**无需回写** `docs/ROADMAP.md` / 各包 `README.md` / `DESIGN.md` —— 本次结论不产生仓内开发项，也未改变任何既有模块的契约或边界。宿主面知识（`docs/host/`）不参与本流程，未改。
- 遗留项：自研或配置落地均未开始，属**后续任务**（按「建议顺序」推进）；届时若采用网关，接口与配置约定应落在新任务的追踪文档，不回填本文件。工作区外的设计记录 `~/temporary/2026-10-11-model-router-proxy-design.md` 不在仓内，若后续要长期保留，建议在新任务中把结论摘进本仓文档（不自动搬运）。
- 归档：本文件移入 `docs/archived/`（`docs/implementation/` 随之为空，不预建）。

## 建议顺序（后续，不在本任务内）

起 Bifrost 容器 → 配 ustc + arkcp 两上游 → 验证同一逻辑名映射两个真实 ID → 检查 `/v1/models` 只暴露自定义名 → 故意配错一个 key 验 fallback → 配一次 provider 级限流验超限排除 → 挑一个 agent（dsh 或 kimi）指过去跑真实会话。半天量级。

## 宿主侧依据（本次核对，供后续任务复用）

- `agent/request`（`dsh-agent-loop/lib/index.js:1179`）：唯一决定用哪个 provider 的地方，每次尝试前都会跑一次；重试会重跑它。
- `agent/request-error`（同文件 `:1124`）：决定是否重试；`llm-retry` 挂此，策略按 provider 配置（退避 + 抖动，支持 `Retry-After`），且**只重试同一步骤、本身不换 provider**。
- `llm/stream`（`dsh-llm/lib/index.js:2371`）：传输层；在此改写 provider 对主链路无效。
- Cordis waterfall（`cordis/lib/index.js:305-322`）：监听器最外层先跑，不调 `next()` 即否决整条链（含内建行为）。
- 默认可重试错误码仅 `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` 五个；`QUOTA` 与 `AUTH` 不在其中，宿主侧不会重试。
- 宿主对"两块之间的间隔"有 5 分钟 idle watchdog（`streamIdleTimeoutMs`，默认 300000，可配）。
