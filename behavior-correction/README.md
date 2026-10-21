# @dsh-toolset/behavior-correction

DSH（DeepSeek Harness）进程内插件：在**工具执行前**拦下「该用专用工具却走 shell」的调用，并在回执里
指出该改用哪个工具。实现方式是向 `rule-engine` 注册一个 `tools/pre-execute` 的 **guard 消费者**，按
自身 `config` 的规则表（工具名 + 参数字符串）判定：命中返回 `{kind:"deny", reason}`，未命中返回
`undefined`（弃权）。

## 为什么需要

`security-guard` 只拦危险命令与敏感路径，`auto-approve` 只裁定审批，两者都不表达「该改用专用工具」。
模型仍会用 `bash` 直接跑有专用工具的命令（典型：`herdr pane list` —— herdr CLI 有 `herdr_pane` 工具，
走 bash 会绕过插件面板与状态绑定）。rule-engine 的注入面只能事后提醒，拦不住已经执行的调用。

## 行为

1. 宿主在工具执行前唤醒 `tools/pre-execute` 消费者，传入 `{ name, arguments, callId?, sessionId?, resumed? }`。
2. 判定文本 = `工具名 + " " + 参数字符串`：`bash` / `pwsh` 取 `arguments.command`（模型给的原文），
   其它工具用 `JSON.stringify(arguments)`；序列化失败（循环引用等）按空串处理。
3. 规则表按声明顺序逐条比对：`tool` 限定通过后，关键词（子串、大小写不敏感）或正则（缺省 flags
   `i`）任一命中即算命中；**第一条**命中的规则胜出。
4. 命中 → `{kind:"deny", reason}`（模型看到的工具回执带这条理由，rule-engine 另打一行
   `消费者 behavior-correction 拒绝工具 <name>`）；全部未命中 → `undefined` 弃权（不返回 `allow`，
   避免无谓否决其它消费者的 `deny`）。

缺省规则（唯一一条）：

| id | 工具 | 条件 | 理由 |
| --- | --- | --- | --- |
| `no-herdr-in-bash` | `bash` | **命令位**调用 `herdr`：行首，或 `;` `&` `|` 之后；允许前置 `VAR=值`
与绝对路径（`echo herdr` / `grep herdr` / 提交信息里提到不拦） | `bash 里不要跑 herdr 命令: 改用 herdr_pane 工具（pane / tab 操作）` |

## 配置

bundle 契约：`name` / `inject: ["ruleEngine"]` / `Config` / `apply`。`ruleEngine` 是**硬依赖**：
注册 guard 消费者必须等服务就绪（2026-10-22 真机实测——本包 insert 在 profile 里排在 rule-engine
之前，只读 `ctx.get` 会拿到 undefined，插件加载了却从未注册）。运行期仍保留存在性判断，服务在但
缺 `registerConsumer` 时告警降级。缺省**开启**（`cordis.patch.yml` 里 `enabled: true`）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时不注册消费者（不拦任何东西） |
| `rules` | 内置规则表 | 给了就**整体替换**内置规则（不做合并）；`[]` = 不拦任何东西 |

`rules` 的元素（`RuleSpec`）：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 建议 | 规则标识（告警与排查用；缺席时按序号显示） |
| `tool` | 否 | 限定的工具名（字符串或字符串数组）；省略 = 任意工具 |
| `match.keywords` | 否 | 关键词列表（子串、大小写不敏感） |
| `match.regex` | 否 | 正则源串列表（任一匹配即命中；非法正则 → 告警并跳过**整条**规则） |
| `match.flags` | 否 | 正则 flags，缺省 `i`；`g` / `y` 会被去掉（避免 `test` 的状态污染） |
| `reason` | 是 | 命中时回给模型的拒绝理由（应写明该改用哪个工具） |
| `description` | 否 | 给人看的说明，不参与判定 |

没有任何匹配条件（`match` 省略或为空）的规则**永不命中**，不会变成「全拦」。非法条目（非对象 /
缺 `reason` / `tool` 或 `match` 形态不对）逐条告警并跳过，其余规则照常。

profile 覆盖示例（用户层 patch）：

```yaml
- id: behavior-correction
  config:
    rules:
      - id: no-herdr-in-bash
        tool: bash
        match: { keywords: [herdr] }
        reason: bash 里不要跑 herdr 命令: 改用 herdr_pane 工具
      - id: no-git-in-bash
        tool: bash
        match: { regex: ['^\s*git\s+(status|log)'] }
        reason: 仓库状态请走 code_map / read，不要用 git 命令
```

## 与其它插件的关系

- **rule-engine**：只做调度与汇总（按注册顺序串行询问、任一 `deny` 胜出、异常按弃权处理）。本插件
  不 import 它的代码，`registerConsumer` 走结构化类型；节点 `tools/pre-execute` 仅消费者可用，
  规则侧（`rule_add` 等）无法表达拦截。
- **security-guard**：挂在宿主 waterfall 之后的单调守卫上，本包的 `deny` 不会绕过它，也无须经过它；
  两者可以同时拒绝同一调用。
- **auto-approve**：审批链裁定；本包在更早处拒绝，被拒的调用不会走到审批。

## 边界（明确不做）

- **不解释 shell 语义**：管道、别名、变量展开、引号、heredoc 都不解析，只对命令原文做文本判定 ——
  宁可漏拦也不误伤（缺省规则只认命令位，正文里提到该词不拦）。
- 不做审计、不落 memory-base、不提供人工命令面；规则只能由插件配置表达。
- 未挂载 rule-engine / 框架不支持该节点时不拦截（fail-open；安全兜底仍在 `security-guard`）。

## 开发

```sh
npm run check   # 类型检查（两个 program：主 tsconfig + tests/tsconfig.json）
npm run build   # 编译到 dist/
npm test        # 接线用例 + 真包契约探针
```

| 文件 | 覆盖 |
| --- | --- |
| `tests/main.test.ts` | 契约符号 / 缺省规则命中与放行 / 工具限定 / 关键词与正则（含大小写与 flags）/ 规则顺序 / 配置替换与空数组 / `enabled: false` / 非法规则与非法正则告警 / 缺服务与注册被拒降级 / dispose 注销幂等 / 判定文本抽取 |
| `tests/contract.test.ts` | 真包契约探针：`@dsh-toolset/rule-engine` 可解析时校验 `CONSUMER_SOURCES` 含 `tools/pre-execute`、且引擎接受「`sources` + `guard`、不带 `decide`」的注册；不可解析时 skip（本包刻意不依赖它） |

接线：根 `package.json` 的 check/build 链、`scripts/install.sh`（`canonical_pkgs`）、
`scripts/test-parallel.sh`（`default_pkgs`）与根 `README.md` / `README.zh.md` / `AGENTS.md` 的包清单。
