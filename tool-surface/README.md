# @dsh-toolset/tool-surface

DSH（DeepSeek Harness）进程内集成插件：把「注册定义」与「模型侧呈现」分开的工具面薄层。

## 定位

宿主的模型可见 schema 就是注册定义（`projectToolSchema` 只取 `name` / `description` / `parameters` / `deferLoading`），没有按会话切换模型侧 schema 的钩子。本包提供两件东西：

- **包装函数** `wrapToolDefinition(def)`：注册前调用，把注册定义收成「短说明 + 宽松占位」，完整说明与完整参数 schema 收进 catalog，并在派发前按完整 schema 严格校验。
- **判定函数** `isWrappedDefinition(def)`：读取定义自身的包装标记；`tool-consult` 用它核对已包装的全局定义是否都在本地 catalog 中。
- **只读服务面** `toolSurface`：`lookup(name)` / `list()` 给出完整说明与完整参数 schema，供 `tool-consult` 在揭示后按需投递。

## 机制

| 环节 | 做法 |
| --- | --- |
| 注册定义 | `description` 收为短说明（用途一句 + 指向 `tool_consult`）；`parameters` 换为 `{ type: "object", additionalProperties: true, properties: {} }` 并带一句提示 |
| 完整内容 | 深拷贝进模块级 catalog，键为工具名（同名后者覆盖前者） |
| 严格校验 | 包装后的 `execute` 先调宿主 `validateJsonSchemaValue`，有违规就抛 `ToolArgsError`（与宿主同款错误形态，管线落错误结果），校验通过才调原 `execute` |
| 透传 | `output` / `timeoutMs` / `deferLoading` 与其它字段原样保留；`summary` 只用于生成注册说明，不进注册定义 |
| 幂等 | 已包装的定义再包一次直接返回（占位不会被当成全文收进 catalog） |

## API

```ts
import { wrapToolDefinition, isWrappedDefinition } from "@dsh-toolset/tool-surface";

const registered = wrapToolDefinition({
  name: "demo_tool",
  // 完整说明：用途 / 用法 / 顺序 / 效果 / 边界 / 相关
  description: "用途: …\n用法: …\n边界: …",
  // 可选短说明；缺省取完整说明首行并补一句指向 tool_consult
  summary: "用途: …, 完整说明与参数 schema 经 tool_consult 查询。",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: { value: { type: "string" } },
  },
  output: { schema: { type: "object" }, render: () => [] },
  async execute(args) {
    return { ok: true, value: args["value"] };
  },
});

ctx.tools.register(registered);
```

服务面：`ctx.get("toolSurface")` 返回 `{ lookup(name), list() }`，两者都返回深拷贝，调用方改动不影响 catalog。`isWrappedDefinition(def)` 对包装产物返回 `true`，对原始定义返回 `false`；只看定义自身的标记，不沿原型链。

## 边界

- 不改宿主：不替换 `ctx.tools.register`，不改 `system-prompt` / `agent-loop` / `tools` 源码。

- 不注册工具、不注入上下文：本包只有库面与服务面，没有模型侧工具与注入通道。

- 揭示策略不在这里：哪个工具对哪个会话可见由 `tool-consult` 决定，本包只提供全文与校验。

- 宿主对宽松占位的校验必然放行，严格校验只此一处（取舍见追踪文档）。

- 校验器直接依赖宿主 `@deepseek-ai/dsh-tools`（精确版本 `0.2.2-rc.1`），升宿主时同步该版本号。

## 测试

```sh
cd tool-surface
pnpm run check   # tsc --noEmit（含 tests）
pnpm test        # node --test：换位 / 透传 / 校验 / catalog / 判定 / 服务面 14 例
pnpm run build   # 编译到 dist/
```
