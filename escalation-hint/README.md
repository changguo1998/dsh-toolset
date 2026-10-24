# @dsh-toolset/escalation-hint

DSH（DeepSeek Harness）进程内集成插件：在「工具调用被沙箱拒绝、但宿主没有给出升级提示」时，向模型补一条重试指引 —— 告诉它可以对**同一个调用**加 `sandbox_permissions` + `justification` 重试一次，从而让 `auto-approve` 的升级白名单真正有机会命中。

**只提示，不拦截**：本包不否决任何工具调用，升级与否仍由宿主 `approveEscalation` 与 `auto-approve` 决定。

## 为什么需要它

宿主的升级提示只在 `result.sandbox.denied === true` 时渲染（`tool-bash/src/render.ts`），而 `denied` 靠**英文** stderr 签名判定（`dsh-sandbox` 的 `matchesSignature`）。本地化报错（git 的「只读文件系统」）匹配不上 → `denied=false` → 模型看不到升级提示，白名单永远等不到请求。

## 怎么接

订阅宿主 `tools/post-execute`（waterfall）：拿到 `exec`（工具名 + 参数）与 `result`（含 `value` 的结构化结果），命中判据时把一条 user-role 消息追加到 `decision.additionalContexts` —— 提示随工具结果**同回合**进入下一次请求，不需要 `steer`，也不需要改宿主。

之所以不用 `rule-engine` 的 `tool-result` 节点：`tool/result` 会话事件只带 `message` / `error` / `meta`，工具返回值（`{exitCode, sandbox}`）不进事件流。

## 判据（三层）

| 层 | 条件 | 动作 |
| --- | --- | --- |
| 1 | 结果里已有 `[sandbox: escalation available …`（宿主 `escalationHintMarker`） | 跳过，不重复提示 |
| 2 | 结果里出现 `[sandbox: file access denied under <mode> mode]`（宿主 `sandboxDenialMarker`）或错误码 `FS_SANDBOX_DENIED` | 补提示（判据稳定，与文案本地化无关） |
| 3 | 无 marker：结构化结果显示沙箱模式内非零退出 / 信号终止，且命令形状像越界写（`git add\|commit\|tag`、重定向、`tee` / `cp` / `mv` / `ln` / `mkdir` / `touch` / `rm` / `dd` / `sed -i`） | 补提示（首批形态，逐步扩） |

`sandbox.denied` **不作判据**：对本地化报错它恒为 `false`，用它等于回到文案依赖。

## 覆盖的工具

| 族 | 缺省工具 | 提示措辞 |
| --- | --- | --- |
| 命令类 | `bash` / `pwsh` | 「刚才这条命令被沙箱拒绝…」 |
| 文件操作类 | `write` / `edit` / `str_replace_editor` | 「刚才这次文件操作被沙箱拒绝…」 |

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 显式 `false` 关闭（不订阅任何钩子） |
| `commandTools` | `["bash", "pwsh"]` | 命令类工具名清单 |
| `fileTools` | `["write", "edit", "str_replace_editor"]` | 文件操作类工具名清单 |
| `maxHints` | `64` | 去重表上限：同一 `callId` 只提示一次，超出按插入序淘汰最旧 |

## 已知限制

- 第 3 层依赖「命令形状表」与「沙箱内非零退出」两个前提；不在表内的写形态不会提示（宁漏不误伤）。
- 只对配置名单内的工具生效；其它插件工具（`herdr_run` / `script_run` 等）当前不覆盖。
- 提示文案固定为中文；宿主若改成结构化升级入口，本包的文案需同步。
- 不监听 `fs` 写工具的 `value`（其拒绝已由第 2 层的错误码覆盖）。

## 验证

```sh
cd escalation-hint
npm run check   # tsc --noEmit（含 tests）
npm test        # node --test：判据 10 例 + 挂载 11 例
npm run build
```

真机验证（人工）：worktree 会话里 `git add` + `git commit` → 失败后应看到附加上下文提示 → 带 `sandbox_permissions: 'danger-full-access'` + `justification` 重试 → `auto-approve` 审计出现 `outcome=allowed-once` / `ruleId=git-worktree-commit`，commit 成功且无审批面板。
