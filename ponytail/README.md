# @dsh-toolset/ponytail

把上游 [ponytail](https://github.com/DietrichGebert/ponytail)（MIT，v4.10.3）的\*\*「懒资深工程师」决策阶梯\*\*做成 DSH 可装载插件：
可开关、可注入、可审计。**默认开启**（2026-10-05 起；显式 `enabled: false` 关闭）——「简单优先」由本插件阶梯承担（`karpathy-guidelines` 已从默认注入取消，不再双份）。

## 它注入什么

`session-start` 时注入一段中文阶梯（另挂 `step-end` 兜底；自带副本，见 `src/ladder.ts`）：

1. 这件事**要不要做**？（YAGNI）
2. 本仓**已有**可复用的实现/助手/模式？
3. **标准库**能做？
4. **平台原生特性**覆盖？
5. **已装依赖**能解决？
6. 能写成**一行**？
7. 才写**最少**能跑的代码。

外加规则：不加未请求的抽象 / 依赖 / 样板；删除优于新增；无聊优于聪明；文件越少越好；修 bug 修**根因**；最短 diff 胜出（但先理解问题）。

## 配置（profile 用户 patch）

```yaml
- id: ponytail
  name: '@dsh-toolset/ponytail'
  config:
    enabled: true            # 缺省 true；仅显式 false 关闭（其它取值按开启）
    dedupeInRecord: 1        # 会话记录里最多 1 条本注入（可见投影 + 未消费 inbox）
    # 唤醒节点，缺省 session-start + step-end（后者兜底）：
    sources: ['session-start', 'step-end']
    # 投递方式，缺省 steer（挂到最近 pre-step 并唤醒；inject 不唤醒、真机 agent 非 live 时会被丢弃）：
    # delivery: steer
    # text: '自定义阶梯文本' # 可选：本地试验用
```

## 契约

- `inject: ["ruleEngine"]` 硬依赖：cordis 下 rule-engine 未挂载时本插件不加载、阶梯不注入（不阻塞宿主启动）；代码面的服务守卫（缺 `registerConsumer` → 告警一次 + 不注册）见 `docs/DESIGN.md` 的「关键设计取舍」。
- apply 时经 `ruleEngine.registerConsumer({ id: "ponytail", sources, delivery, dedupeInRecord, decide })` 注册（五项缺省见 `src/main.ts` 的 `resolveConfig`：`enabled` true、`sources` `["session-start", "step-end"]`、`delivery` `"steer"`、`dedupeInRecord` 1、`text` 为内置阶梯）；
  开启 → 返回阶梯正文 + 摘要；关闭 → `decide` 返回 `null`（不注入）
- 返回 dispose：注销消费者
- **不搬**上游的 `hooks/*.js` / `commands/*.toml` / `gemini-extension.json` / `ponytail-mcp`

## 验证

```sh
npm --prefix ponytail run check && npm --prefix ponytail run test && npm --prefix ponytail run build
```

## 与 `karpathy-guidelines` 的关系

重叠「简单优先 / 外科手术式改动 / 不加未请求的抽象」；差异是 ponytail 的阶梯**更前置**（先问「要不要做」）且给出 7 级顺序，`karpathy-guidelines` 面向「写代码时的行为准则」——故**建议只开一个**（无需双开）。

## 文档

- `docs/DESIGN.md`：本包分层、命令面降级说明与关键设计取舍。
- `docs/ponytail-investigation.md`（项目级）：上游调研结论与方案取舍。
- `cordis.patch.yml`：bundle 层挂载行（`enabled: true` + `sources` + `dedupeInRecord: 1`，显式 `false` 可关闭）。
