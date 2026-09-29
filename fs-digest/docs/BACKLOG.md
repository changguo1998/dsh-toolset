# fs-digest 待办

> 职责：fs-digest 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与边界（见 `fs-digest/README.md`）
> 过期条件：无

## 1. 缺陷

### D1. `ctx.cwd` 未注入，导致 `fs_digest` 调用必失败

- **现象**：任何 `fs_digest` 调用直接报 `Error: cannot get property "cwd" without inject`（`outline` / `signatures` / `pruned` 三模式均如此）。
- **影响**：工具完全不可用。已在 0.1.5-rc.3 与 0.1.7-rc.2 两个宿主版本上复现，**与宿主升级无关**（复核 0.1.7-rc.2 升级时发现）。
- **定位**：`src/main.ts:129` —— `resolvePath: (input) => resolve(ctx.cwd ?? process.cwd(), input)`。`ctx` 是 cordis 上下文代理，`cwd` 既非注册服务、也不在其属性面上，未 `inject` 的属性访问即抛错，故 `?? process.cwd()` 兜底永远走不到；`src/main.ts:39` 声明的 `cwd?: string` 目前无人赋值。
- **修法（择一）**：
  1. **从会话取 cwd（语义正确）**：经会话 / agent 面取当前会话的 cwd，注入给 `resolvePath`；
  1. `process.cwd()`（一行改完）：工具能跑，但相对路径基准退化为进程工作目录。
- **验收**：修复后 `fs_digest` 三模式对相对路径输入可用；补一条回归用例（假 ctx 下断言不抛错且 cwd 生效），并在 `fs-digest/README.md` 记一条边界。
- **状态**：完成（2026-09-27 修复并验收：单测 + 插件边界取证 + 真机 `/tools` 确认注册；追踪文档已归档）。

### D2. `fs_digest` 三模式全部失败：`Error: content.some is not a function`

- **现象**：本机实际调用 `fs_digest`（`outline` / `signatures` / `pruned` 三模式，TS 与 Markdown 文件均试）一律返回 `Error: content.some is not a function`（2026-09-29 实测，宿主为当前 profile 版本）。同会话内其它插件工具（如 `code_map summary`）正常返回，故非宿主整体故障。
- **根因（已定位）**：工具注册的 `output.render` 返回**字符串**（`fs-digest/src/main.ts:218-221` → `renderResult()` 返回 `string`），而宿主期望**内容块数组**——对照可用实现 `session-channel/src/index.ts:545-550`：`render: (args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]`。宿主对 `content` 调 `.some` 即抛 `content.some is not a function`。
- **影响**：`fs_digest` 工具在本机完全不可用（插件单测 47 例全绿，故单测未覆盖工具注册的返回形态）。
- **修法**：`output.render: (_args, result) => [{ type: "text", text: renderResult(result as DigestResult) }]`（同时对齐宿主 render 的 `(args, value)` 形参签名）。
- **验收**：本机 `fs_digest` 三模式均可用（返回文本而非报错）；补一条针对 `output.render` 返回形态的用例（断言返回数组且元素含 `type: "text"`），避免单测继续漏检。
- **状态**：待接取（2026-09-29 建 `docs/ROADMAP.md` 时实测发现）。优先级 P1。
