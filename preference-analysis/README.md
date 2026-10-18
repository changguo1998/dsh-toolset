# @dsh-toolset/preference-analysis

DSH（DeepSeek Harness）进程内插件：从**会话行为**里归纳用户的持久偏好，落账簿 → 达门槛自动写入
memory-base 项目层 → 经 `rule-engine` 消费者注入后续会话。模型也能提议偏好，但**一律落候选待审**，
不自动应用；用户可随时撤销。

## 为什么需要

仓内的静态约定（`~/.dsh/AGENTS.md`、项目 `AGENTS.md`、`rule-engine` 规则表、`ponytail` 阶梯、
`symbol-normalizer` 符号表）全是**人工写定**的，没有生产者：没有任何东西从「用户反复要求同一件事」
「被打断后重新强调」「审批里连续拒绝同一类操作」里归纳出偏好。本包补上这个生产者，并保证闭环可审阅、
可撤销、可老化。

## 观测面（三条机器可判信号 + 显式通道）

| 信号 | 触发 | 产物 |
| --- | --- | --- |
| S1 重复约束 | `user/message`（排除 `source.kind = rule-engine` 的注入）含约束标记词且句长 ≤ 120 字 | 抽承载标记的**最短句**作为证据 |
| S2 纠正加权 | 上一回合 `turn/end{aborted\|interrupted}`，或本消息含纠正词 | 同消息里的约束句权重 x1.5；没有约束句只记「未成形观察」计数 |
| S3 审批拒绝 | `approval/asked` 与 `approval/decided{rejected}` 按 id 配对，参数经同回合 `tool/call` 的 `callId` 取 | 指纹 `tool:参数首段`（如 `bash:rm`）+ 机械生成的约束句 |
| 显式登记 | 用户直接写库（`/memory add <tier> --kind preference …`）或模型调 `preference_add` | 模型提议落候选待审 |

不采集：助手正文与工具结果原文、文件内容、TUI 快捷键 / `$` 本地 shell、提交信息风格、工具选择分布
（后三者或不可得，或与既有静态约定重复）。「用户对模型输出的修改」在 TUI 不可得，用打断 + 纠正性重述 +
审批拒绝代理。

## 生命周期与阈值

```text
observe --证据≥3 且 跨≥2 会话--> candidate --最近证据≤30 天且 autoApply 允许--> active
   ^                                                                              |
   +---------------- 新证据复活 <-- dormant(>90 天无证据, 不注入) <----------------+
                                        |
                                        +-- retired(>180 天, 真删库行 + 记抑制键)
```

- 加权证据 = 普通证据 1 + 纠正语境证据 1.5；`importance` 候选 3 / 高置信 4（可经服务面写入的元数据位）。
- **模型提议永不自动应用**（留在 `candidate`，由用户决定）；统计证据是用户自己的重复原话，两者不同权。
- 撤销 / 拒绝 / 退休都会写**抑制键**：同一模式（相同或 3-gram 相似 ≥ `similarity`）不再被重新归纳。

## 注入

注册**一个** `rule-engine` 消费者（不往规则表写规则）：

```ts
{ id: "preference-analysis", sources: ["session-start", "compaction", "step-end"],
  delivery: "steer", dedupeInRecord: 1, directWrite: ["session-start", "compaction"] }
```

`decide` 只读账簿快照（廉价、不同步调宿主 API），渲染 `active` 条目：缺省每次最多 5 条 / 600 字符，
超限截断并在末尾标注「另有 N 条偏好未列出。」。注入正文由 rule-engine 统一加 `[RULE] ` 前缀。

## 配置（profile 用户 patch）

```yaml
- id: preference-analysis
  name: '@dsh-toolset/preference-analysis'
  config:
    enabled: true              # 缺省 true；显式 false 全关（零观测、零写入、零注入）
    autoApply: confident       # off 只列建议 / confident 高置信才写库（缺省）/ all 达候选门槛即写
    markers: ['不要', '别', '不用', '以后', '一律', '统一', '都', '记住', '禁止', '只能', '必须', '优先']
    thresholds: { evidence: 3, sessions: 2, recentDays: 30 }
    aging: { dormantDays: 90, retireDays: 180 }
    similarity: 0.8            # 3-gram Jaccard 合并阈值
    inject: { maxItems: 5, maxChars: 600 }
    minIntervalMs: 600000      # 归纳节流（启动后一次 + compaction/end 后一次）
    # ledgerPath: <dshHome>/preference-analysis/ledger.json  # 缺省落点，一般不用改
```

## 模型侧工具

| 工具 | 作用 | 边界 |
| --- | --- | --- |
| `preference_list` | 列账簿条目（id / 正文 / 状态 / 证据数 / 跨会话数 / 重要度 / 最近证据） | 只读 |
| `preference_add` | 登记一条偏好建议 | **一律落候选待审**，不自动应用、不自动注入 |
| `preference_remove` | 撤销一条偏好 | 描述写明**仅在用户当次明确要求撤销时调用** |

## 账簿与隐私

- 落点 `<dshHome>/preference-analysis/ledger.json`（跨会话），目录 0700 / 文件 0600，临时文件 + rename
  原子写，写入前做 `revision` 版本守卫（并发写冲突 → 重载后重试）。
- 账簿是**唯一状态源**：库里的行被删 / 被压缩 / 被迁移都不影响注入正确性，库只作正文副本与检索面。
- 隐私三层：写入前 `checkPrivacy` 预检（本包自有模式：私钥 / 凭据文件 / 凭据形态 / 家目录绝对路径）+
  `registerKind.preWrite` 纵深 + 不采集助手正文与工具结果原文；含敏感片段的证据**连账簿都不落**。
- 门禁：归纳只持 `writableTiers: ["project"]` 的句柄（写 U 层会被 memory-base 抛错）；
  用户层是独立 kind `preference_user`，只由显式动作调用。

## 依赖

`inject: ["memory", "ruleEngine", "tools"]`：三个都是宿主服务，交给 cordis 按依赖排序，**服务就绪后
才激活本插件**。这一点是必须的——只在 `apply` 里读一次 `ctx.get("ruleEngine")` 会在「本插件先于
rule-engine 激活」时取不到消费者面，消费者就永久漏注册（真实重启踩过）。

## 降级

- `memory` 没有分层句柄面（`registerKind` 未返回 `put` / `forget`）：记一次明确告警，停在
  **只观察不写入 / 不注入**（不冒充 `origin: "user"`，不依赖候选队列）。
- 非 cordis 宿主忽略 `inject` 提前激活、且 `ruleEngine` / `tools` 尚未就绪：按「只记录不注入 /
  不注册工具」处理并告警一次，不抛错、不影响宿主启动。
- 账簿文件损坏：改名留档 `ledger.json.corrupt-<时间戳>` 后从空账簿开始；版本不受支持则**拒载拒写**。

## 与相邻件的分工

- `rule-engine`：**注入通道**（本包只注册消费者，规则表仍归人工与 `rule_add`）。
- `memory-base`：**分层存储面**（项目层句柄 + 隐私闸 + 检索）；提升链 / 审阅队列等管理逻辑不在本包依赖里。
- `ponytail` / `symbol-normalizer`：固定约定，不参与归纳；偏好与它们重复时**不自动抑制**，由用户撤销或退休。
- `AGENTS.md`：仍是最高的静态约定；本包**不自动改仓内文件**。

## 验证

```sh
npm --prefix preference-analysis run check
npm --prefix preference-analysis run test
npm --prefix preference-analysis run build
```

## 文档

- `docs/DESIGN.md`：状态机、跨包契约、幂等与并发的机制沉淀。
- `docs/BACKLOG.md`：模块待办与「已裁定不做」（首期不做 TUI 面板、LLM 归纳、写 `AGENTS.md` 等）。
- 追踪文档：`docs/implementation/2026-10-16-preference-analysis-design.md`（项目级，决策 D1-D20 与验收口径）。
