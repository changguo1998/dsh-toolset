# session-channel 待办

> 职责：session-channel 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与边界（见 `session-channel/README.md` 与 `session-channel/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，本文件内唯一，**仅供阅读**；与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 过期条件：无

## 1. 功能

### F1. 会话别名（可读寻址）

- **目标**：给每个会话起人类可读别名（如 `build` / `docs`），`send` 的 `to` 支持别名寻址，免在会话间互发时抄 UUID。
- **要点**：
  1. 管理面：`alias set <名称>` / `alias list` / `alias clear`（工具 action + 服务面方法各一份）。
  1. 寻址解析优先级：`sessionId` 精确匹配 → 别名 → `cwd:<绝对路径>`；别名歧义时报 `target_ambiguous` 并列候选。
  1. 存储：独立键 `dsh:session-channel:alias:<alias>` → sessionId（便于列举与清理；是否随在线键 TTL 过期见开放问题）。
  1. 展示（可选，属 TUI 模块变更）：标题栏 / 状态列显示别名，需 TUI 侧只读桥。
- **开放问题**：唯一性冲突（后设覆盖 vs 拒绝）；别名生命周期（会话退出后保留多久、是否随会话持久化）；字符集（建议 `[A-Za-z0-9_-]{1,32}`；是否允许中文取决于 TUI 显示宽度）；与 `sessionId` 撞名的保护。
- **落点**：`src/keys.ts`（别名键）+ `src/broker.ts`（解析与冲突分支）+ `src/index.ts`（action 与服务面）。
- **验收**：设别名后 `send` 用别名可达（`delivered: true`）；重复/未知别名的错误码明确；重启后别名行为符合所选生命周期；单测覆盖解析优先级与冲突分支。
- **状态**：待办（2026-09-29 用户提出）。

> 同一模块的后续扩展（跨会话委托/协调、扩展状态同步）登记在项目级 `docs/BACKLOG.md` 的 #54 / #55。

## 2. 缺陷

### D2. 改名遗漏：`connectIntercom` 等大写 `Intercom` 标识符未跟随更名

- **现象**：`intercom` → `session-channel` 更名时，替换表覆盖了小写 `intercom` 与一批已知 PascalCase 名（`IntercomService` / `IntercomConfig` / …），但漏掉 `connectIntercom`（含「Intercom」大写而未被小写规则命中）——现 `src/client.ts:64` 导出 `connectIntercom`，被 `src/index.ts` 与 4 个测试文件引用（共 17 处）。
- **影响**：命名不一致；对外可见的函数名仍是旧名（`ctx.get("sessionChannel")` 的服务面不受影响，因为服务面方法名与它无关）。功能无缺陷。
- **修法**：`connectIntercom` → `connectSessionChannel`（`src/client.ts` 定义 + `src/index.ts` 2 处 + 4 个测试文件全部引用）。
- **验收**：`grep -rn "Intercom" session-channel/src session-channel/tests` 无结果（历史文档除外）；`check` / `build` / `test` 全绿。
- **状态**：待接取（2026-09-29 修 D1 时发现）。优先级 P3。
