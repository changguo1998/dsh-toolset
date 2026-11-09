# 示例 profile 对齐当前 fff（接取条目：docs/BACKLOG.md「示例 profile 资产与当前 fff 对齐（个人项除外）」）

状态：关闭　　开启：2026-11-09　　关闭：2026-11-09
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

`profiles/example/cordis.patch.yml`（install.sh 复制给新 profile 的初始资产）与当前 `~/.dsh/profiles/fff/cordis.patch.yml` 的**通用挂载形态**一致；个人配置不进仓库资产。

## 调研

### 对比方法

`diff -u profiles/example/cordis.patch.yml ~/.dsh/profiles/fff/cordis.patch.yml`（255 行 vs 426 行），再按 `- id:` 逐条核对条目清单。

### 差异分类

通用能力项（模板缺，应同步）：

| 差异 | 当前 profile 位置 |
| --- | --- |
| `coagent` `maxLive: 8`（插件缺省 4） | `~/.dsh/profiles/fff/cordis.patch.yml:61-66` |
| `task-engine` `commandTimeoutMs: 300000` + `maxRetries: 10` | `:419-426` |
| `output-compress` 的 digest.db 存放位置说明（sessionDirFor 推导；过渡覆盖已删） | `:50-53` |
| `memory-base` 模板仍写 `config.project: 'my-project'`，当前 profile 只有 id + name | `:44-45` |
| 会话标题段实测依据：`maxInputBytes: 32768` 的理由（聚合输入体积）、`maxOutputTokens: 512` 的理由（thinking 预算） | `:124-137` 注释 |

个人项（**不搬**）：`tg` provider 与 20 个模型条目（含 `contextWindow` / `maxTokens` / `reasoningEfforts`）、`baseURL: http://127.0.0.1:8787/v1`、`apiKeyEnv: TOLLGATE_API_KEY`、标题路由 `ustc` / `deepseek-flash`、`session-title-cutoff` 实配、`hmr.base` 的仓库绝对路径、`rule-engine` 的 `skill-autoload` 规则正文与全部 `description` 长文。

偏好项（本次只跟一半）：`memory-base` 去 `project` 与 `ponytail` 停挂同步；`tui.theme` 保持模板的 `dark`（当前 profile 是 `light`，属个人偏好，不跟）。

安装脚本生成区（`# install.sh generated: hmr-root-begin/end`、标题接管生成区）由 `scripts/install.sh` 追加，模板里不写。

## 决策

1. **同步范围**：a 仅通用能力项 / **b 通用能力项 + 偏好项，但 `tui.theme` 保持 dark（选定）**。
   选 b：用户 2026-11-09 明确「1+2 除了 theme」。
2. **个人项处理**：a 整段删除 / **b 保留注释骨架与占位（选定）**。
   选 b：与既有隐私口径一致（`profiles/example` 头注释已写明不含私有 provider / 模型名 / 端点 / `apiKeyEnv`），新机器仍能照着填。
3. **生成区**：a 抄进模板 / **b 不抄（选定）**。选 b：脚本追加，抄了会与生成逻辑冲突。

## 规划

计划改动文件清单（本任务只碰这些）：

- `profiles/example/cordis.patch.yml`（主改：补 `coagent` / `task-engine` 行、`memory-base` 去 `project`、`output-compress` 与会话标题段注释、`tui.theme` 保持 `dark`）
- `docs/BACKLOG.md`（条目状态）
- 本追踪文档

实施步骤：

1. 按上表逐项改模板；个人项一律保留占位或注释骨架。
2. 校验：`yq` 解析、`scripts/install.sh --dry-run`、`pnpm run check:docs`、`format`（该文件属带注释 YAML，按约定**不**格式化）。
3. 反向核对：模板里搜不到 `tg` / `ds41f` / `TOLLGATE_API_KEY` / `127.0.0.1` / `ustc` / `/home/guochang`。

明确不做：

- 不改当前 profile（`~/.dsh/profiles/fff/cordis.patch.yml`）。
- 不改 `scripts/install.sh`、`profiles/example/package.json`、`profiles/example/pnpm-workspace.yaml`。
- 不动 `tui.theme`（保持 `dark`）、`STATUS.md`。

## 实现记录

- `profiles/example/cordis.patch.yml`：
  - `code-map` 之后新增 `coagent`（`maxLive: 8`）块，含「插件缺省 4 / 超限不排队 / 只重述要改字段」说明。
  - `output-compress` 补 digest.db 存放位置说明（`sessionDirFor` 推导；2026-10-17 过渡覆盖已于 2026-10-22 删除）。
  - `memory-base` 去掉 `config.project: 'my-project'`，注释改为「取 `process.cwd()`（`memory-base/src/index.ts:122-123`），要固定归属时按 id 覆盖」并给注释示例。
  - 会话标题段 2a 补两条实测依据：`maxInputBytes` 校验的是聚合输入体积（4096 只够单轮，故 32768）、`maxOutputTokens` 要留 thinking 预算（取 64 会 `finish: max-tokens` 截断，实测 thinking 约 300+，故 512）。
  - `behavior-correction` 注释从「缺省只拦 herdr」更新为四条规则（herdr / 解释器 / 查看文本 / 纯 grep 检索段）。
  - 文件末尾新增 `task-engine` 块（`commandTimeoutMs: 300000`、`maxRetries: 10`），含 30s 缺省会被 54s 根链路 SIGKILL、重试缺省 8（2026-11-09 由 3 放宽）的说明。
  - 未动：`tui.theme: dark`、`ponytail` 停挂块、`rule-engine` 只留 `resumed-notice`、个人模型占位骨架与生成区注释。

## 偏差

- 无（范围与决策一致）。实现期修正一处措辞：初版注释把 `memory-base` 的 `project` 写成「已废弃」，核对 `memory-base/src/index.ts:118-123` 后确认它仍有效（缺省 `process.cwd()`），已改为「资产里不写死、需要时按 id 覆盖」。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `yq -e '.' profiles/example/cordis.patch.yml` | 解析通过 |
| `yq '.[] \| select(.id == "task-engine" or .id == "coagent" or .id == "memory-base")'` | 三块内容与当前 profile 一致（`maxLive: 8`；`commandTimeoutMs: 300000` + `maxRetries: 10`；`memory-base` 只剩 id + name） |
| `yq -r '.. \| scalars' … \| grep -E 'tg$\|ds41f\|TOLLGATE\|127\.0\.0\.1\|ustc\|/home/guochang\|deepseek-flash'` | 无命中（个人串不进资产） |
| `sh scripts/install.sh --dry-run` | 退出码 0，无新增告警 |
| `pnpm run check:docs` | 119 篇现行 Markdown / 960 个 `.ts`，错误 0 / 警告 0（首轮曾因新条目里用旧称「落点」报错 1 处，已改「存放位置」） |

未验证：`--sync`/`--force` 实际安装路径未跑（会改当前 profile，本任务明确不做）；新机器用模板起 profile 的实际挂载效果留待下一次安装时抽查。

## 收尾

- 条目「示例 profile 资产与当前 fff 对齐（个人项除外）」已关闭，并从 `docs/BACKLOG.md` §2 清理移除（该节只剩暂停中的「回合预算调整」）。
- 本追踪文档移入 `docs/archived/2026-11-09-example-profile-align.md`。
- 回写判断：`profiles/README.md` 只讲复制模板的用法，未列条目清单，不需要改；根 `README.md` / `README.zh.md` 的选项说明也未涉及本次新增的插件条目，同样不改。`STATUS.md` 按约定由用户择时更新。
- 遗留：`tui.theme` 仍是模板的 `dark`（当前 profile 为 `light`，属个人偏好，本次按用户裁定不跟）；下一次 profile 侧再改配置时，仍按本文件的「通用项 vs 个人项」分类口径同步。
