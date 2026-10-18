# @dsh-toolset/auto-approve

DSH（DeepSeek Harness）自动审批插件：在**审批请求链**（`approval/request`）上按配置自动裁定，
免去逐次人工应答；人工面保留（未命中判据的请求照常弹审批面板），宿主审计对照常产生。

首期即含 **LLM 灰区审查**：名单是前置刀口（人类写下的权威规则，模型不得推翻），
名单覆盖不到的灰区才交给模型判断。

> **自动放行不等于沙箱放行**：本插件只回答「是否免去人工应答」；沙箱围栏仍由 `sandboxPolicy`
> 承担，自动放行后的命令继续在既有沙箱模式下执行。

## 挂载与裁定顺序

| 挂载点 | 职责 |
| --- | --- |
| `approval/request` 应答者 | 命中即 `allowed-once` / `rejected`，未命中调 `next()` 交下一位（TUI 人工面板）。覆盖**全部** ask 来源：沙箱升级、策略式 ask、任何插件直连请求 |
| `tools/pre-execute` 监听器 | 记录 `callId → 参数`（审批请求本身不带参数），并执行**不需要参数**的拒绝名单；**不提前放行**（不吞掉工具自己的 `ask` 决定） |

判定优先级（第一个命中的规则胜出）：

| 序 | 判据 | 结果 | 说明 |
| --- | --- | --- | --- |
| 0 | 未启用 / `mode: off` / bypass 工具 / 不在 `gateTools` 白名单 | 不裁定 | 结构面兜底 |
| 0.5 | 判据要求看参数而参数取不到 | 不裁定 | 落人工面板，不猜（`deny.missingArguments` 可收紧为拒绝） |
| 1 | 显式拒绝名单（`deny.tools` / `deny.escalation.to`） | `rejected` | 缺省全空；**只表达「不自动批」**；优先于一切放行与 LLM |
| 2 | 同会话指纹（已批准过的等价调用） | `allowed-once` | 仅单会话内有效；被拒绝过的等价调用不进放行集 |
| 3 | 只读类工具（`readonlyTools`） | `allowed-once` | 缺省含官方读工具与本仓读面插件工具；**不含 `bash`** |
| 4 | 路径白名单（`allow.paths`） | `allowed-once` | 归一化后匹配（展开 `~` / `$HOME`、相对路径按会话 cwd） |
| 5 | 命令白名单（`allow.commands`） | `allowed-once` | 命令原文折叠空白后匹配 |
| 6 | 沙箱升级白名单（`escalation.allow`） | `allowed-once` | **两维**：命令 / 路径命中 **且** 目标模式在 `to` 内 |
| 7 | LLM 灰区审查（`review`） | `allow` → `allowed-once`；`deny` → `rejected`；失败 → 兜底 | 仅 `mode: "rules+llm"`；名单命中时不产生模型请求 |
| 8 | 以上都未命中 | 不裁定 | 照常弹审批面板 |

裁定词表与宿主一致：`allowed-once` / `rejected`（不提供其它授权词汇）。

## 配置（profile 的 `cordis.patch.yml` 该条目下 `config`）

```yaml
- id: auto-approve
  name: '@dsh-toolset/auto-approve'
  config:
    enabled: true            # 缺省 true；显式 false 关闭
    mode: rules              # off | rules | rules+llm | all（缺省 rules：灰区落面板、零 token）
    readonlyTools: [read, read_image, grep, glob]   # 覆盖内置只读类清单；空数组即关闭该层
    bypassTools: [run_code]  # 不参与自动裁定（精确或 `*` 结尾前缀通配）
    # gateTools: [bash, write]  # 非空即只审这些工具
    fingerprintCapacity: 256 # 单会话指纹表容量（近似 LRU）
    callTableCapacity: 256   # callId → 参数 表容量
    allow:
      paths:
        read: ['^/var/log/']
        write: ['^/w/tmp/']
      commands:
        bash: ['^git (status|diff|log|show)\b']
    deny:
      tools: ['mcp__*']                 # 永不自动批的工具
      escalation:
        to: ['danger-full-access']      # 任何工具升到这些档一律拒绝（优先于 escalation.allow）
      # missingArguments: true          # 取不到命令 / 路径原文时直接拒（缺省落面板）
    escalation:
      mode: match                       # match（缺省）| any（不建议）
      # to: [workspace-write]           # 规则自身 to 的兜底
      allow:
        - id: git-ro
          match: '^git (status|diff)\b'
          to: [workspace-write]
        - id: logs
          path: '^/var/log/'
          to: [read-only]               # 目标模式必须与宿主词表一致
    review:
      enabled: true            # 缺省 true；只有 mode: rules+llm 时才真的调用
      # provider: some-provider # provider + model 同时给出才覆盖（缺省跟随当前会话模型）
      # model: some-model
      timeoutMs: 10000
      maxRiskAllow: medium     # low | medium | high（允许自动放行的最高风险档）
      onFailure: panel         # panel（缺省，交人工 / 原路径）| reject（直接拒）
    audit:
      project: true            # 项目那份（memory-base）；false 关闭跨会话留痕
      maxBytes: 16777216       # 会话那份单文件上限（16 MiB）
```

非法取值一律**回落缺省**并记一条诊断（不抛错）：本插件的保守方向是「不自动批」，
所以丢弃非法规则是安全的。

### 沙箱升级白名单

沙箱升级请求（`escalate sandbox to <mode>: <justification>`）只带 `toolName` / `callId` / `reason`，
**没有命令原文**——命令由本插件的 `callId → 参数` 表提供；表未命中时该层不生效（落面板，不猜）。

判定顺序：拒绝名单（`deny.escalation.to`）→ 命令 / 路径归一化后匹配 `match` / `path`，
**且**请求的目标模式在 `to` 内 → 放行；否则落面板。`justification` **不参与判定**（模型自陈理由，
可被话术诱导）。一次放行只对当次调用有效；想避免反复弹面板就配合指纹记忆（同命令 + 同目标模式）。

### LLM 灰区审查

- **请求形态**：固定策略段 + 四段数据 —— `ENVIRONMENT`（只有 cwd）/ `PROJECT_INSTRUCTIONS`（带来源）/
  `FILTERED_HISTORY`（按角色过滤，只含人工指令与工具调用事实）/ `PENDING_ACTION`（完整待审动作）；
  `temperature: 0`，严格 JSON。
- **合法输出**（其它一律按失败处理，不猜）：`{"risk":"low|medium","decision":"allow"}`、
  `{"risk":"medium|high","decision":"deny"}`（可带 `reason`）。`low+deny` / `high+allow` /
  allow 带 reason / 成员数不对 / 非 JSON 都算非法。
- **不可越权**：reviewer 不得推翻名单、不得把 high 降级（策略段明写）。
- **路由**：缺省跟随当前会话模型（会话日志最近一条 `request/header.header.config`）；
  `review.provider` + `review.model` 同时给出时覆盖。
- **失败语义**：reviewer 报错 / 超时 / 输出非法 / 路由不可用 → **绝不静默放行**：
  `onFailure: panel` 交人工（`pre-execute` 侧不裁定、审批层调 `next()`），
  `onFailure: reject` 直接拒绝。
- **成本**：只对灰区调用 +1 次模型请求；名单命中 0 次。审查串在审批应答之前，超时缺省 10 s。

## 审计（双落点）

| 落点 | 载体 | 不可用时 |
| --- | --- | --- |
| 会话 | `<会话目录>/auto-approve-audit.jsonl`（经 `sessionPaths.sessionDirFor(sessionId)` 推导，同步 append） | **退回人工面板 + 一次警告**（绝不静默放行）；`status().audit.sessionWritable` 为 `false` 并带 `degradedReason` |
| 项目 | memory-base `project` 层、kind `approval_audit`（经作用域句柄 `put`） | 跳过（计数 + 一次警告，**不影响裁定**） |

每行字段（两处同形）：`{t, sessionId, agentId, callId, toolName, outcome, source, ruleId?, risk?, reviewerDecision?, reviewerModel?, fallback?, mode, fingerprintHash?}`；
**不记录参数原文与命令全文**（避免把凭据 / 敏感路径写进日志）。
会话那份达上限时保留最近一半并写一条 `truncated` marker 行，保证最新记录仍在。

## 命令面 `/autoapprove`

| 子命令 | 作用 |
| --- | --- |
| `/autoapprove`（无参数） | 等价 `status` |
| `status` | 模式 / 名单条目数 / 指纹数（全部会话）/ LLM 路由 / 审计两处状态与行数 |
| `mode <rules\|rules+llm\|all\|off>` | 切当前进程的运行态模式 |
| `on` / `off` | 即时开关（`off` 后未命中请求立刻回到审批面板） |
| `log [n]` | 最近 n 条自动裁定（缺省 10）：时间 / 工具 / 结果 / 来源 / 规则 id；**不含命令原文** |
| `clear-fingerprints` | 清空本进程的会话指纹，同类调用重新判定 |

命令只改**当前进程**的运行态（重启回落配置），不写会话事件、不改 profile 文件；
只读查询面另经服务 `autoApprove`（`status()` / `recent(n)` / `fingerprints()` / `setMode(mode)`）暴露。

## 与既有件的关系

- **`security-guard`**：分工**零重合**。命令 / 路径拦截（危险命令、敏感文件）是守卫的职责，
  它是**唯一不可翻盘的最终否决者**（单调守卫，排在 `tools/pre-execute` 之后）；本插件**不调用**
  `ctx.get("guard")`，拒绝名单只表达「不自动批」。同一条命令可同时命中守卫的放行配置与本插件的白名单
  （语义不同：前者是「不做硬拒」，后者是「免人工审批」）。**危险命令与敏感路径请配 `security-guard`**。
- **宿主 `/policy never`**：宿主在服务内部、链分发之前短路，本插件根本收不到请求 ——
  「谁最终裁定」= `never` > 本插件 > TUI 面板 > fail-closed。
- **`permission-presets`**：只写沙箱 + 审批两个旋钮，不做逐次裁定；本插件挂在它写的 `ask` 策略之后，天然并存。
  不占用保留名 `auto`。
- **官方 `experimental-auto-review`**：**不挂载**。职责与本插件 LLM 段重合，同链双审属浪费；
  本插件把它的判断力接过来，并补上它没有的名单 / 指纹 / 可配开关。

## 依赖

- `session-paths`（**可选面**，仅用于会话审计落点）：经 `ctx.get("sessionPaths").sessionDirFor(sessionId)`
  推导目录（不在 `inject` 里，经 `readService` 受保护读取）；未挂载、会话目录不可得或 `sessionDirFor` 抛错 → 会话那份审计不可得 → **退回人工面板并警告**（见上表）。
- `memory-base`（**可选**）：项目那份经 `registerKind({kind: "approval_audit", writableTiers: ["project"]})`
  取句柄写入；取不到即跳过（只计数）。
- 与 `security-guard` **无接口**；`llm` / `commands` / `sessions` / `agents` 均为可选读取。

## 边界与已知限制

- 指纹只在**单会话内**有效（与宿主「一次性授权」语义一致），不做跨会话持久授权。
- `mode: all` 会放行一切未命中拒绝名单的调用（含灰区），仅建议封闭环境使用。
- 会话那份审计不可用时**整条自动裁定停用**（决策 5 第 4 条：绝不静默放行）——这是有意的降级。
- 不做 TUI 审批面板改造、不新增 `ApprovalPolicy` 取值、不新增会话事件词汇。
- 不搬「记住该命令」的跨会话授权存储（宿主亦无），不做 GUI 面板。
- 不做按会话配置：会话级旋钮由宿主 `/policy` 与 `/permission` 承担，本包跟随生效。

## 验证

```sh
npm --prefix auto-approve run check
npm --prefix auto-approve test
npm --prefix auto-approve run build
```

单测覆盖：裁定矩阵（含优先级与缺参数降级）、指纹（容量 / 会话隔离 / 拒绝不入集）、升级白名单两维
（含 `justification` 不参与）、LLM 决策矩阵与失败兜底、名单优先于模型（零请求）、审计双落点与
16 MiB 截断、命令面全部子命令、契约与三处接线、R3 反向验证（代码里没有 guard 调用）。

## 文档

- 设计与决策（优先级表、审计口径、R1–R7 裁定）：项目级 `docs/archived/2026-10-16-auto-approval-design.md`。
- 包内待办：`docs/BACKLOG.md`。
