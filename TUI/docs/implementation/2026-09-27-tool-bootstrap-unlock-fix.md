# 工具引导解锁判定修复（rc.2 无 `session.events`；BACKLOG: TUI#13）

状态：测试　　开启：2026-09-27　　关闭：（未关闭）
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

接取范围 = `TUI/docs/BACKLOG.md` #13（2026-09-27 用户裁定「先修复」；由「不需要交互」批次的面板测试复核引出）。

## 目标

- 修复 #13：`tool-bootstrap.ts` 的 promotion（解锁）与 `sessionMode` 兜底不再依赖宿主不存在的 `session.events`（rc.2 无公开属性）；恢复参照实现的 fail-open，绝不把会话锁死。
- 补单测覆盖 rc.2 实况（无 events、经消息投影）；`npm run check` / 测试 / `npm run build` 通过后交用户重启真机复验（面板测试随解锁恢复；#11 解锁半程一并由真机复核）。
- 不在范围：门控谓词 / persona / `coreFor`（#11 已定稿）、面板渲染、其余 BACKLOG 条目。

## 调研

（2026-09-27；来源：宿主源码 `dsh-session` / `dsh-agent-loop`、本项目研读笔记、参照实现、真机会话日志）

- **rc.2 的 Session 无公开 `events` 属性**（`docs/host/DSH-CTX-API.md` §1：内部为私有 `eventsSnapshot`；同步读 `eventAt` / `snapshotEvents` / `ownEvents` 自 rc.2 起标 deprecated、禁新调用）。
- **移植对照**：参照 `dsh-anchored-standard/preset/tool-bootstrap.mjs` 的 `isPromoted` 在 `!Array.isArray(session.events)` 时 **return true（fail-open → 直接全量，绝不锁死）**；本包移植为 `isPromotedFromEvents` 的 `return false`（fail-closed）→ live 永不解锁。`sessionMode` 兜底同样读 `session.events`（live 恒 weak）。
- **真机实证**：0.1.7-rc.2 + 全 `deepseek-*` 门控下，会话 59 次工具调用、43 步后 `request/header` 全日志仅 1 条 `initial`（tools=2）、目录零变化（该记录仅在头部（含 tools）变化时追加，见宿主 `dsh-agent-loop` `buildRequest`）。
- **可用替身**：宿主公开 `Session.deriveMessages()`（增量缓存、返回冻结快照；消息投影保留 `source.kind` 与 assistant 消息的 `tool-call` 内容块）→ 可作 live 与 resume 的统一判据。
- **测试盲区成因**：单测 mock 了 `.events` 数组（假 runtime 自造了宿主不存在的属性），故 1150 条全绿未暴露缺陷。

## 决策

- **读取顺序**（`isPromoted`）：进程内 Set 记忆 → 宿主提供 `events` 数组时以其为准（保留参照宿主形态）→ 否则经 `session.deriveMessages()` 消息投影判定（rc.2 主路径）→ 两者不可读一律 **fail-open 降级全量**。
- **判据**：promotion = 消息投影含 `tool-call` 内容块；模式 = 首个 `source.kind === "user"` 消息文本分类（跳过 agent-instructions / skill-catalog 等注入消息）。
- **范围**：解锁与模式兜底一并修（同一缺陷的两处 `session.events` 读取）；不新增运行时依赖、不调用 deprecated 同步读。

## 规划

### 任务拆分

1. `tool-bootstrap.ts`：`isPromoted` 改造（events → 消息投影 → fail-open）；`sessionMode` 兜底接消息投影；新增 `sessionMessages` / `hasToolCallInMessages` / `sessionModeFromMessages` 纯函数与注释、文件头「健壮性」段更新。
1. `dsh.ts`：重导新纯函数（测试经适配器导入）。
1. `tests/tool-bootstrap.test.ts`：新增 rc.2 用例——投影出现 `tool-call` 后解锁（含 spec 模式经投影推导）/ 投影不可读 fail-open / 恢复旧会话首请求全量 / `sessionMode` 两条路径；同步文件头覆盖说明与一处失实用例名。
1. 自检：`npm run check` → 定向测试 → 全量 `./scripts/test.sh` → `npm run build`。
1. 收尾：回写 `README.md` / `docs/DESIGN.md` 机制描述；#13 标「完成」；本文件移入 `docs/archived/`。

### 计划改动文件清单

- `src/app/adapter/tool-bootstrap.ts`
- `src/app/adapter/dsh.ts`（重导列表）
- `tests/tool-bootstrap.test.ts`
- `TUI/docs/BACKLOG.md`（#13 状态）
- `TUI/docs/implementation/2026-09-27-noninteractive-backlog-batch.md`（仅追加「途中发现」记录行，指注本任务）
- `README.md` / `docs/DESIGN.md`（收尾按需，机制描述）
- 本追踪文档

### 明确不做

- 不回头改 #11 的门控谓词、persona、`coreFor`；不引入 deprecated 同步事件读；不处理 #8 与其余条目；不手改 `STATUS.md`。

## 实现记录

- 2026-09-27：按流程完成开工——BACKLOG #13 标「进行中」；本追踪文档建立（含调研 / 决策 / 规划与计划改动文件清单）。

- 2026-09-27：完成实现（代码 + 单测 + 文档回写）：

  - `tool-bootstrap.ts`：`isPromoted` 读序改为「进程内 Set → 宿主 `events` 数组（存在时以其为准）→ `session.deriveMessages()` 消息投影 → 不可读 fail-open」；`sessionMode` 兜底接消息投影；新增 `sessionMessages` / `hasToolCallInMessages` / `sessionModeFromMessages` 纯函数；文件头「健壮性」段与相关注释同步（引用 TUI#13）；修 1 处 `noImplicitAny` 收窄问题（`Array.isArray` 对 readonly 数组收窄退化为 `any[]`，内容块显式标注参数类型）。
  - `dsh.ts`：重导名单补 3 个新纯函数（测试经适配器导入，与原导出路径一致）。
  - `tests/tool-bootstrap.test.ts`：新增 5 条用例（2 单测 + 3 端到端，见「测试与证据」）；文件头覆盖说明同步；一条失实用例名修正（「无需 events」→「进程内记忆」）。
  - 文档回写（随本次交付、非收尾后置）：`README.md` 机制段、`docs/DESIGN.md` 状态机行与健壮性行——均改「经宿主消息投影判定（rc.2 无公开 `session.events`）」口径。

- 2026-09-27：真机验证（dsh 层）通过——恢复会话后 `request/header` 出现 `reason=resume`、tools=36 全量；`system/message` 409 → 2886 字符（persona 恒定 + sections 回归）；`developer/message`（tool-addition）出现。**途中发现（待验证）**：已恢复会话的模型表面只能发出 bash/read（12 次尝试发 `ask_user_question` / `glob` 均被 agent 侧降级、dsh 日志零痕迹）→「对话面工具表在会话开始固定」推论，#11 锁定首请求或对模型整会话生效；待用户在新会话做决定性测试后定 #11 走向。交接：`tmp/HANDOFF-2026-09-27-tui-bootstrap-unlock.md`；提交询问已发出待用户裁定。

## 测试与证据

（2026-09-27，本机 `TUI/` 下执行）

- `npm run check`（`tsc --noEmit`）：**通过**。
- `./scripts/test.sh tests/tool-bootstrap.test.ts`：**27 通过 / 0 失败**（原 22 + 新增 5）。
- `./scripts/test.sh` 全量：**1155 通过 / 0 失败**（修复前 1150；+5 为新用例）。
- `npm run build`：**通过**（产物已刷新；profile 以 `link:` 指向本包，重启 `dsh` 即生效）。
- 关键用例（#13 的双向安全性）：
  - 无 events + 投影无 `tool-call` → 首请求保持锁定（两阶段不失效）；
  - 投影出现 `tool-call` → 后续组装解锁全量（**真机此前永不发生的行为**）；
  - 投影不可读 / 抛错 → fail-open 直接全量（**绝不锁死**，与参照实现一致）；
  - 恢复旧会话（投影已有 `tool-call`）→ 首请求即全量（resume-safe）。
- 未验证（待用户真机）：重启 `dsh --profile fff` 后——① 恢复本会话应首请求即全量、可直接拉面板；② 新会话两阶段锁定 → 首工具调用后解锁（#11 解锁半程复核）；③ 随后返回批次完成 #4/#6 面板目视。

## 收尾

（待真机复验通过后补齐：#13 标「完成」、本文件移入 `docs/archived/`、批次文档的后续指引、`tmp/` 调试产物清理。）
