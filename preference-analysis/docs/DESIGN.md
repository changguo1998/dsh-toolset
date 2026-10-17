# preference-analysis 设计

> 职责：本包的架构与机制沉淀（状态机、跨包契约、幂等与并发口径）
> 不负责：能力清单与配置表（见 `README.md`）、待办（见本目录 `BACKLOG.md`）、决策过程（见项目级
> `docs/implementation/2026-10-16-preference-analysis-design.md` 与本仓 git 历史）
> 过期条件：无（机制变化即更新）

## 1. 定位

`preference-analysis` 是**静态约定的生产者**：把会话行为里的重复约束、纠正性重述、审批拒绝归纳成用户
偏好，落一条可审阅、可撤销、会老化的账簿，再把生效的偏好注入后续会话。它不发明新的注入通道、不新开
存储层——注入走 `rule-engine` 消费者面，存储走 `memory-base` 分层句柄面。

三条边界：

- **不做 LLM 归纳**（宿主无公开 `ctx.llm`；首期只做统计判定，文案润色留同形注入口）。
- **不自动改仓内文件**（`AGENTS.md` 追加路径首期不做）。
- **不把审阅权交给模型**（模型只能提议与查看，撤销要用户当次明确要求）。

## 2. 状态机与不变量

```text
observe --> candidate --> active --> dormant --> retired
   |            |            |          |           |
   |            |            |          |           +-- 真删库行 + 抑制键（终态）
   |            |            |          +-- 90 天无新证据：不注入，条目保留
   |            |            +-- 自动应用成功（高置信 + autoApply 允许）
   |            +-- 证据 >= 3 且跨 >= 2 会话（或模型显式提议，留待审）
   +-- 证据不足：只计数
```

不变量：

1. **账簿是唯一状态源**：`active` 是注入的唯一依据；库里的行只是正文副本与检索面，被删 / 被迁移都不
   影响注入正确性。副本引用（`memory.kind/tier/id`）只用于撤销与退休时真删。
2. **置信只升不降（在证据不消失的前提下）**：`evaluate()` 是纯函数，同一份证据重复跑给同一档位；
   时间只影响「最近证据窗口」这一维。
3. **退休即抑制**：任何退出（拒绝 / 撤销 / 老化）都写 `suppressed` 键，同一模式不再被归纳出来。
4. **休眠可复活**：休眠条目收到新证据后重新走分档（可能直接回 `active`）；没有新证据时保持休眠，
   不会被分档循环改写成 `candidate`。
5. **模型提议与统计证据不同权**：`origin = "model"` 的条目跳过自动应用，停在 `candidate`。

## 3. 数据流

```text
session/event ──observe.ts──> Observation[]（证据 / 未成形观察）
                                   │  缓冲（上限 2000，防长会话）
                                   ▼
      启动后一次 + compaction/end 后一次（进程内节流 minIntervalMs）
                                   │
                          main.consolidate()
                                   │
        ┌──────────────────────────┼───────────────────────────┐
        ▼                          ▼                           ▼
  隐私闸（敏感片段丢弃）   induce.mergeEvidence（相似合并）   老化 planAging
        │                          │                           │
        │                          ▼                           ▼
        │                  evaluate（分档 + importance）   dormant / retired(+forget)
        ▼                          │
   ledger.json（原子写 + revision 守卫） ◀── apply.applyEntry（项目层句柄 put）
                                   │
                                   ▼
                    ruleEngine 消费者 decide（只读快照 → 注入正文）
```

- 观测是**纯同步翻译**：`Observer.handle()` 不发 IO、不看配置以外的状态，便于按「固定埋点序列」写断言。
- 归纳**串行**：`consolidate()` 复用同一 promise；一轮处理期间新到的证据连续补跑（上限 3 轮），
  避免「归纳跑完才知道又来了一条」的丢失窗口。
- `decide` 只读内存快照：`session/event` 是同步派发窗口，消费者必须廉价（不 await、不调宿主 API）。

## 4. 跨包契约（冻结值）

**memory-base（硬依赖，`inject: ["memory"]`）**——只依赖四项纯存储面：

| 面 | 用法 |
| --- | --- |
| `registerKind({kind, writableTiers, preWrite})` | 归纳路径 `preference`（`["project"]`）；显式动作 `preference_user`（`["user"]`）。返回作用域句柄 |
| 句柄 `put({content, tier, project, title, importance, source, sessionId})` | P 层写入带最近证据的 `sessionId` 留痕；U 层不带 |
| 句柄 `forget([{tier, ids}])` | 撤销 / 退休真删，返回删条数 |
| 全局 `list({kind, tier, project, limit})` | 重试幂等：同内容副本复用其 id，不重复写行 |

**rule-engine（软依赖）**——注册值见 `README.md` 的注入一节，代码里是
`CONSUMER_REGISTRATION`（常量导出，测试直接比对，防漂移）。

**门禁落在能力上而不是自律上**：`preWrite` 的入参不含 `tier`，同一 kind 声明多层无法按层拦，
故拆两个 kind，让**句柄本身当闸门**；越权层由 memory-base 抛错。

## 5. 隐私与三层防线

1. **不采集**：只存用户原话片段（≤ 120 字），不存助手正文、工具结果原文、文件内容。
2. **写入前预检**（`port.checkPrivacy`）：本包自有模式（`.ssh` / `id_rsa` / 凭据文件 / `sk-`、`ghp_`、
   `AKIA` 形态 / 家目录绝对路径）+ memory-base 内置闸。
3. **纵深**：`registerKind.preWrite` 再拒一次；含敏感片段的**证据连账簿都不落**（账簿不经过库闸门，
   这一步不能省）。

## 6. 幂等、并发与降级

- **账簿写**：临时文件 + `rename`；目录 0700、文件 0600；写前比对磁盘 `revision` 与内存，不一致抛
  `LedgerConflictError`。冲突由调用方**重载后重试**（证据回缓冲，不丢）。
- **坏文件**：解析失败 → 改名 `ledger.json.corrupt-<时间戳>` 后从空账簿开始（保留原始数据）。
- **版本不符**：`version != 1` → 拒载拒写（只告警），避免旧代码覆盖新格式。
- **库侧幂等**：应用前用 `list` 找同内容副本，命中则复用 id（重试不产生重复行）。
- **降级**：memory 没有句柄面 → 只观察（不产候选、不写库、不注入），记一次明确告警；
  ruleEngine 缺席 → 只记录不注入；`enabled: false` → 连实例都不建。

## 7. 关键取舍与已知边界

- **相似阈值 0.8 偏严**：3-gram Jaccard 只对「近乎同一句」（标点 / 空白 / 尾缀差异）合并；措辞差别较大
  的同一意图不会合并，会各记一条。阈值可配，改小会提高召回但增加误合并，首期按设计取 0.8。
- **一条消息最多一条证据**：取承载标记的**最短句**；同消息里的多条约束靠后续重复出现自然分列。
- **审批指纹粒度粗**：只到 `tool:参数首段`（`bash:rm` / `write:凭据文件`），不区分完整参数；
  归因不明（缺 `callId` 或缺 `tool/call`）时**不造弱偏好**。
- **无冲突检测**：两条偏好语义冲突时不做自动判定（需要 LLM），由用户在列表里撤销。
- **零 TUI 改动**：审阅靠 `preference_list`，撤销靠 `preference_remove`（首期口径，见模块 BACKLOG）。
