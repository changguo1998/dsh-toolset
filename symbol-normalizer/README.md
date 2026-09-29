# @dsh-toolset/symbol-normalizer

DSH（DeepSeek Harness）插件：**模型正文符号规范**——展示层归一（别名替换）+ 回合审查（人类 notice + 模型反馈），以 **rule-engine 消费者**形式接入（消费者框架的第一个验证插件）。

## 能力

### 1. 展示层归一（服务 `normalize`）

`normalize(text)` 返回 `{ text, replacedCount, remaps, emojiRemaps, unrecommended }`：治理区内的不推荐符号按别名表替换为推荐符号（如 `✔→✓`、`❌→✗`、`➔→→`）；无替代的符号原样保留并记入 `unrecommended`。纯函数、无副作用；dsh-toolset TUI 在 `/symbol-unify` 开启时对每个流式段调用。

### 符号规则表（内置默认）

推荐白名单：`✓ ✗ △ → ← ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙ ▶ ◀ ▲ ▼ ▷ ◁ ▽ ⟸ ⟹ ⟺ • ◦ ○ ● ◯ ■ □ ◇ ◆ ⓘ 〜 …`。

| 域 | 推荐（代表） | 归一到代表 |
|---|---|---|
| 状态 | `✓ ✗ △` | `✔ ✅ ☑ 🗹 → ✓`；`✕ ✖ ✘ ❌ 🗙 ☒ 🗷 → ✗`；`⚠ → △` |
| 方向箭头 | `→ ← ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙` | `➔ ➜ ➡ ➠ ➢ ➣（→）`；`⬅ ⬆ ⬇（← ↑ ↓）` |
| 三角箭头 | 实心 `▶ ◀ ▲ ▼`；空心 `▷ ◁ △ ▽` | 实心 `▸ ► ⏵ ⏩ ➤`（→ 同向代表）、`🔺 🔼（→ ▲）`、`🔻 🔽（→ ▼）`；空心 `▹ ▻（→ ▷）`、`◃ ◅（→ ◁）`、`▵（→ △）`、`▿（→ ▽）` |
| 几何 | `■ □ ◇ ◆` | `▫ ◻ 🔳 🔲 → □`；`◽ ▪ ◼ ⬛ ⬜ 🟥 🟦 🟧 🟨 🟩 🟪 🟫 → ■`；`🔷 🔹 🔶 🔸 ⬥ ⬧ → ◆`；`⬦ ⬨ → ◇` |
| 圆域 | `• ◦ ○ ● ◯` | `⭕ → ○`；`⚪ ⚫ 🔴 🔵 🟠 🟡 🟢 🟣 🟤 ⬤ → ●` |
| 双线推导 | `⟸ ⟹ ⟺` | `⇐ → ⟸`；`⇒ → ⟹`；`⇔ → ⟺` |
| 加减 / 金额 / 波浪 | ASCII `+ -`；`¥ ¢ £ ₩`；`~`（1 列）/ `〜`（2 列） | `➕ ➖ → + -`；全角 `￥ ￠ ￡ ￦ → ¥ ¢ £ ₩`；`～ → 〜` |
| 信息 / 感叹 / 问号 | `ⓘ`；ASCII `!` `?` | `ℹ → ⓘ`；`❗ ❕ → !`；`❓ ❔ → ?` |

不纳入（使用即提醒）：星标域 `★ ☆ ✦ ✧` 与 `⭐`（无推荐代表）、双线/特殊笔触 `⇢ ⇝`、图形族 `💡`、带圈数字 `❶` 等。

### 2. 回合审查（消费者 `decide`）

rule-engine 在 turn-end 询问本插件（消费者 id `symbol-normalizer`）：

- **豁免代码段**：审查前掩码行内代码与围栏代码块（其中的符号是引用示例，不判违规；见 F1）；掩码只影响审查，展示层归一仍作用于全文；
- 对**整回合正文**做符号审查，逐符号冷却过滤（默认 10 分钟 / 3 run，双维度任一未过期即冷却；`0` 关闭对应维度；**按会话记账**）；
- 有内容时：① 一行 notice 经服务 `onReview` 推给展示层（TUI 显示）；② 返回模型反馈文案（按回合合并一条：emoji 罗列 / 变体计数 / 警示复述规则），由 **rule-engine 统一注入**（`source.form:'notice'`，送达路径见 rule-engine 配置）；
- 无新内容（全冷却 / 无违规）→ 返回 null（不注入、不提示）。

`warnModel: false` 时只提示人、不提醒模型。

### 3. 服务（`provide("symbolNormalizer")`）

| 方法 | 说明 |
| --- | --- |
| `normalize(text)` | 展示层归一（见上） |
| `onReview(listener)` | 订阅审查事件 `{ sessionId, notice, feedback }`，返回注销函数 |
| `status()` | 推荐 / 别名条数、`warnModel`、冷却参数、记账会话数 |

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `recommended` | `[]` | 追加推荐字符（治理区放行白名单） |
| `aliases` | `{}` | 别名映射追加（覆盖同键内置） |
| `warnModel` | `true` | 是否向模型发提醒（false = 只提示人） |
| `cooldownMs` | `600000` | 同符号冷却时间窗（ms；`0` 关闭） |
| `cooldownRuns` | `3` | 同符号冷却 run 次数（`0` 关闭） |

## 配置示例（profile `cordis.patch.yml`）

```yaml
- insert:
    - id: symbol-normalizer
      name: '@dsh-toolset/symbol-normalizer'
      config:
        warnModel: true
        cooldownMs: 600000
        cooldownRuns: 3
```

`config` 段是**整行替换、非深合并**（宿主 patch 语义），多层叠加需自行写全。

## 依赖与时序

- `inject: ["ruleEngine"]` 硬依赖：rule-engine 未挂载时本插件不加载（TUI 回退原文透传、无提醒）。
- `decide` 运行在 `session/event` 的同步派发窗口内：纯计算、不得调用宿主 API；注入由 rule-engine 推迟宏任务。
- 消费者面依据（宿主 rc.2）：`registerConsumer` 由 rule-engine 提供（见 `rule-engine/README.md`）。

## 已知限制

- 反馈按回合合并为一条，不逐符号多条。
- 冷却记账在进程内（`dsh` 重启清零），按会话隔离。
- 展示层归一依赖客户端主动调用 `normalize`（dsh-toolset TUI 已接入）；未接入的客户端只有模型侧提醒。

## 开发

```sh
npm run check   # tsc --noEmit
npm run build   # 编译到 dist/
npm test        # node --test
npm run demo    # mock 正文跑「审查 → notice + 反馈」，不依赖 DSH
```

架构与设计取舍见 `docs/DESIGN.md`。
