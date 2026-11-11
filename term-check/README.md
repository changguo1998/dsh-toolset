# @dsh-toolset/term-check

DSH（DeepSeek Harness）进程内集成插件：检查每回合的助手回复正文里是否用了 `docs/GLOSSARY.md`「禁止术语」表里的旧称，命中时注入一条更正提示，要求模型按表里的「应当使用」更正后完整重发。

**只报不改**：不改回复正文，也不改任何文件。

## 定位

术语的一致口径由 `dev/standard`（`pnpm run check:docs`）守着，但那只覆盖仓库内的 Markdown，**模型回帖正文**不在其管辖内；正文里的旧称此前只在人工阅读时暴露。本包把同一张表接到 `rule-engine` 的 `assistant-text` 节点上，让不合口径的说法在回合结束时立刻得到一次提醒。

## 判据

逐行扫描整回合助手正文，命中「禁止术语」表的旧称即报。豁免与跳过口径与 `dev/standard` 一致：

| 情形 | 处理 |
| --- | --- |
| 条件型术语（模块 / 工具集 / 收口） | 整行跳过，不自动判定（指层次时保留） |
| 行内含豁免标记（原名 / 旧称 / 历史对照 / 不再使用） | 该行跳过（首次出现写「原名」的对照句属合规） |
| 已知误配（「夺回归属」里的「回归」） | 同句含该片段即跳过 |
| 同一旧称多处出现 | 每回合每词只报首次出现那一行 |
| 代码块 / 行内代码里的旧称 | **照判**（不做掩码，见「边界」） |
| 命中数超过 `maxHits` | 列前 N 条，末尾写「另有 K 处未列出」 |

旧称「落点」这一行的「应当使用」写作「见『推荐术语』」，不是具体词，注入文案改为「按语境改用具体说法（存储 / 审计 / 实现 / 投递 / 文档 / 条目）」。

## 配置

`cordis.patch.yml` 的 `config`：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 显式 `false` 关闭（仍注册消费者，`decide` 恒返回 `null`） |
| `sources` | `["assistant-text"]` | 唤醒节点 |
| `delivery` | `"followup"` | 作为新回合注入，模型据此重发修正后的回复 |
| `dedupeInRecord` | `1` | 同一条提醒每会话只注入一次（按 `summary` 计数） |
| `maxHits` | `8` | 每条反馈最多列出几处（`0` = 不限） |

## 术语表来源

术语表以**构建期快照**随包发布（`src/glossary.generated.ts`），运行时不读工作区文件，故非本仓项目也能审查：

```sh
cd term-check
pnpm run gen:glossary     # 从 ../docs/GLOSSARY.md 重新生成快照
pnpm run check:glossary   # 只校验快照与当前 GLOSSARY 是否一致
```

生成脚本复用 `dev/standard/rules.mjs` 的 `loadGlossary`（与 `check:docs` 同一份解析，不另写一套）。改了 `docs/GLOSSARY.md` 忘重跑生成时，`tests/glossary.test.ts` 会报红。

## 边界

- **不做代码段掩码**（2026-11-05 用户裁定）：回复里引用旧称做示例、或在代码 / 引文里出现旧称时也会被提示一次。缓解靠 `dedupeInRecord: 1`（每会话一次）与文案里写明「若某条属引用示例或历史对照，可忽略本条」。
- 只做**子串命中**，不做分词与上下文语义判断；因此旧称「评审」「决策点」「回归」这类日常词会被报（正是表里的口径），条件型术语与已知误配已按上表豁免。
- 依赖 `rule-engine`：服务缺席时只向 stderr 写一条告警，不注册、不让宿主启动失败。
- 注入是提示而非强制：模型可以忽略；本包不重写回复，也不阻断回合。
- 快照随包发布，故升级术语表后需要重新构建并重装 profile 才生效。

## 注入通道

- 静态保持：术语表（推荐术语 + 禁止术语两段）—— `ctx.systemPrompt.section`，name `term-check/glossary`、order 4200、`interpolate: false`，内容随快照只重启生效。
- 一次性注入：旧称更正 —— rule-engine 消费者（`assistant-text`，`followup`，`dedupeInRecord` 1）。
- 动态保持：无。

## 测试

```sh
cd term-check
pnpm run check            # tsc --noEmit（含 tests）
pnpm test                 # node --test：判定 16 例 + 挂载 8 例 + 快照守成 4 例
pnpm run check:glossary   # 快照与 GLOSSARY 一致性
pnpm run build            # 编译到 dist/
```

真机验证（人工）：回帖故意写旧称「活动区」→ 下一回合应收到 `[term-check]` 开头的注入；同一会话再次触发时因 `dedupeInRecord: 1` 不再注入。
