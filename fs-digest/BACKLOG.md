# fs-digest 待办

> 职责：fs-digest 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/DEVELOPMENT-BACKLOG.md`）、契约与边界（见 `fs-digest/README.md`）
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
- **状态**：待修复（2026-09-25 记录）。
