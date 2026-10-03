# @dsh-toolset/session-title-cutoff

DSH 进程内插件：接管 `ctx.sessionTitle` 的唯一标题 provider —— **触发策略保持 `all-prompts`**（每条真实用户消息触发一次自动标题，手动 `/rename` 的 pin 语义不变），但**参考窗口**改为「最近一次会话内提交动作（`git commit`）之后的人类消息」；会话内从未提交过则等同全量（现状）。

## 行为

- **窗口**：`selected = request.messages.filter(m => m.seq > cutoffSeq)`；`cutoffSeq` = 本会话最近一次 `git commit` 工具调用事件的 `seq`。
- **回退**：无提交记录 / 过滤后为空 / 事件不可读 → 用全量消息（保证标题仍可生成）。
- **提交判定**：当前只认命令文本匹配 `\bgit\s+commit\b` 的工具调用（含 `--amend` / `-a`）。
- **记账**：`session/event` 监听（`tool/call`）维护每会话 `cutoffSeq` 缓存；进程重启后缓存为空 → 首次触发按「无提交」处理（回退全量），后续提交再次推进。缓存按会话记账（容量上限见实现，FIFO 淘汰）。

## 配置（`cordis.patch.yml` 的 `config`）

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `targetWords` | `5` | 非 CJK 标题目标词数（透传官方 helper） |
| `targetCjkCharacters` | `15` | CJK 标题目标字数 |
| `maxInputBytes` | `32768` | 入模提示体积上限（UTF-8 字节；超出即失败并保留旧标题） |
| `maxOutputTokens` | `512` | 标题生成输出 token 上限 |
| `timeoutMs` | `60000` | 标题请求超时 |
| `provider` / `model` | 空 | **留空 = 复用会话当前记录的路由**（推荐）；成对提供时显式指定 |

## 宿主依赖姿态（零依赖）

宿主包不在本仓库的可解析路径内。本包**不声明 `@deepseek-ai/*` 依赖**，而是在运行时经
`createRequire($DSH_HOME/profiles/node_modules/x.js)` 解析并动态 `import()` 官方 helper
（`@deepseek-ai/dsh-session-title-llm`）——该路径是宿主官方兜底解析路径（见 profile 模板注释），
解析到的是与宿主同版的副本。解析失败 → 告警且**不注册 provider**（宿主回落确定性 fallback，不崩）。

## 接入前提

宿主只允许注册一个标题 provider，故需在 profile 用户层**禁用官方 `session-title-all-prompts-llm`**：

```yaml
- id: session-title-all-prompts-llm
  disabled: true
```

`scripts/install.sh --sync --take-over-title` 可一条命令完成该步与包挂载（普通 `--sync`
**不改写**用户 patch 的标题配置，只在检测到冲突时提示）；手工接入见
`session-title-cutoff/docs/archived/2026-09-29-title-cutoff-provider.md` 的收尾记录。

profile 挂载（bundle 层已自带 insert 与缺省配置）：

```yaml
# 通常无需手写：本包 package.json 的 dsh.bundle.patch 已插入自身
```

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # tsc → dist/
npm run test    # node --test（纯函数 + 假 ctx 装配；不依赖宿主与真实 LLM）
```
