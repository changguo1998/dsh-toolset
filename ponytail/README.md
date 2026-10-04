# @dsh-toolset/ponytail

把上游 [ponytail](https://github.com/DietrichGebert/ponytail)（MIT，v4.10.3）的\*\*「懒资深工程师」决策阶梯\*\*做成 DSH 可装载插件：
可开关、可注入、可审计。**默认关闭**（`enabled: false`；与 `karpathy-guidelines` 的「简单优先」高度重叠，避免双份注入）。本机 profile `fff` 的用户 patch **2026-10-05 起已开启**——同日起默认注入只保留 `i-have-adhd`，`karpathy-guidelines` 不再加载，「简单优先」由本插件阶梯承担。

## 它注入什么

`session-start` 时注入一段中文阶梯（自带副本，见 `src/ladder.ts`）：

1. 这件事**要不要做**？（YAGNI）
1. 本仓**已有**可复用的实现/助手/模式？
1. **标准库**能做？
1. **平台原生特性**覆盖？
1. **已装依赖**能解决？
1. 能写成**一行**？
1. 才写**最少**能跑的代码。

外加规则：不加未请求的抽象 / 依赖 / 样板；删除优于新增；无聊优于聪明；文件越少越好；修 bug 修**根因**；最短 diff 胜出（但先理解问题）。

## 配置（profile 用户 patch）

```yaml
- id: ponytail
  name: '@dsh-toolset/ponytail'
  config:
    enabled: true              # 缺省 false
    sources: ['session-start'] # 唤醒节点，缺省 session-start
    dedupeInRecord: 1          # 投影里最多 1 条本注入
    # text: '自定义阶梯文本'   # 可选：本地试验用
```

## 契约

- `inject: ["ruleEngine"]`（硬依赖；缺席 → 告警且不注册，不影响宿主启动）
- apply 时经 `ruleEngine.registerConsumer({ id: "ponytail", sources, delivery: "inject", dedupeInRecord, decide })` 注册；
  开启 → 返回阶梯正文 + 摘要；关闭 → `decide` 返回 `null`（不注入）
- 返回 dispose：注销消费者
- **不搬**上游的 `hooks/*.js` / `commands/*.toml` / `gemini-extension.json` / `ponytail-mcp`

## 验证

```sh
npm --prefix ponytail run check && npm --prefix ponytail test && npm --prefix ponytail run build
```

## 与 `karpathy-guidelines` 的关系

重叠：简单优先、外科手术式改动、不加未请求的抽象。
差异：ponytail 的阶梯**更前置**（先问「要不要做」）且给出 7 级顺序；`karpathy-guidelines` 面向「写代码时的行为准则」。
**建议只开一个**（缺省即关闭本插件）。**现状（2026-10-05）**：用户裁定默认注入只保留 `i-have-adhd`（输出形态），编码行为由本插件阶梯承担；`karpathy-guidelines` 已从默认注入移除，故本 profile 只开本插件、不再双份。
