/**
 * `scripts/tool-surface-check.mjs` 单测：fixture 假宿主树 + 退出码纪律。
 *
 * 覆盖（决策 D5）：
 * - 逐工具解析 `parameters`（顶层键即参数名；数组元素键在 `items.properties`）→
 *   三分类（已覆盖 / 需关注 / 未覆盖但无路径·命令·代码参数）+「名称未解析」行；
 * - `name:` 为计算值的包单列「名称未解析」，其参数键命中 watched 键时同时计入门禁；
 * - 退出码：0（干净宿主）/ 1（有需关注）/ 2（缺 root、`--root` 指到 scope 层、root 下无工具包、
 *   口径来源缺失）；
 * - 键集/登记集来自引擎单一来源（`TOOL_SURFACE`），输出标注来源：发布形态（只有 `dist` + `scripts`）
 *   读 `dist`，仓库形态回退 `src`；两者都不可用 → 提示先 build 并 exit 2。
 * - 覆盖边界（2026-10-02 条目）：摘要**固定一行**边界（只扫 `dsh-tool-*` 包；其它官方包 / MCP /
 *   第三方运行时注册的工具均不在面内；`exit 0` 不等于全覆盖），`--json` 的 `boundary` 同文案且另有
 *   稳定布尔字段 `coversMcpTools` / `exitZeroMeansFullCoverage`（均 false）；USAGE 里「0」的限定同口径。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "tool-surface-check.mjs");
/** 已构建产物（键集来源之一）；未 build 时为 undefined（相应用例跳过）。 */
const DIST_INDEX = join(HERE, "..", "dist", "src", "index.js");

/** 跑脚本并收集输出与退出码（非零退出不抛，统一返回 status）。 */
function runScript(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; script?: string } = {},
): { status: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [opts.script ?? SCRIPT, ...args],
      {
        encoding: "utf8",
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { status: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? -1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

/** 拷脚本到「假安装包」目录（模拟 `files: [dist, scripts, ...]` 的发布形态）。 */
function makeInstalledLayout(
  base: string,
  name: string,
  withDist: boolean,
): string {
  const dir = join(base, name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(SCRIPT, join(dir, "scripts", "tool-surface-check.mjs"));
  if (withDist && existsSync(DIST_INDEX)) {
    cpSync(join(HERE, "..", "dist"), join(dir, "dist"), { recursive: true });
  }
  return join(dir, "scripts", "tool-surface-check.mjs");
}

/** fixture 工具包源码（形态对齐官方编译产物：`defineTool({ name, parameters })`）。 */
const SOURCES = {
  /** 已登记工具（read 在 FILE_TOOLS）→「已覆盖」。 */
  read: `
ctx.tools.register(defineTool({
    name: "read",
    description: "fixture 已登记工具",
    parameters: { file_path: { type: "string", required: true } },
}));
`,
  /** 未登记 + 顶层 `path` 参数 →「需关注」（path）。 */
  future: `
ctx.tools.register(defineTool({
    name: "future_tool",
    description: "fixture 未登记工具（顶层 path）",
    parameters: { path: { type: "string", required: true } },
}));
`,
  /** 未登记 + 数组元素键（`items.properties.path`，present 的真实形态）→「需关注」（path）。 */
  nested: `
ctx.tools.register(defineTool({
    name: "nested_tool",
    description: "fixture 未登记工具（数组元素 path）",
    parameters: { files: { type: "array", required: true, items: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string", required: true }, description: { type: "string" } }
    } } },
}));
`,
  /** `name:` 为计算值 →「名称未解析」；`script` 属代码键 → 同时计入门禁。 */
  computed: `
const toolName = pick(params);
ctx.tools.register(defineTool({
    name: toolName,
    description: "fixture 计算名工具（script）",
    parameters: { script: { type: "string", required: true } },
}));
`,
  /** 未登记且无路径/命令/代码参数 →「未覆盖但无路径/命令参数」。 */
  plain: `
ctx.tools.register(defineTool({
    name: "plain_tool",
    description: "fixture 无相关参数工具",
    parameters: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" } } } } },
}));
`,
  /** 未登记 + 命令键在**第 3 层**（数组元素键 → 其对象成员键）→「需关注」（command）。 */
  level3: `
ctx.tools.register(defineTool({
    name: "level3_tool",
    description: "fixture 未登记工具（第 3 层 command）",
    parameters: { children: { type: "array", required: true, items: { type: "object", properties: {
        executor: { type: "object", properties: { command: { type: "string" } } }
    } } } },
}));
`,
  /** 未登记 + 命令键要到**第 4 层**才出现（再深一层对象成员）→ 不计入「需关注」（锁 3 层上限）。 */
  level4: `
ctx.tools.register(defineTool({
    name: "level4_tool",
    description: "fixture 未登记工具（命令键在第 4 层）",
    parameters: { children: { type: "array", required: true, items: { type: "object", properties: {
        acceptance: { type: "array", items: { type: "object", properties: {
            executor: { type: "object", properties: { command: { type: "string" } } }
        } } }
    } } } },
}));
`,
};

/**
 * 假宿主树（对齐真实布局）：
 * `<base>/node_modules/@deepseek-ai/dsh-fixture/`（= dsh 包目录，--root 正确指法）
 * 　└ `<base>/node_modules/@deepseek-ai/dsh-fixture/node_modules/@deepseek-ai/dsh-tool-<x>/lib/index.js`
 * 另建一个 scope 层目录（其下直接是 dsh-tool-<x> 包目录，--root 指到它应 exit 2）。
 */
function makeFixture(sources: readonly string[]): {
  /** dsh 包目录（正确指法）。 */
  root: string;
  /** 安装树 `node_modules` 层。 */
  nodeModules: string;
  /** scope 层（`@deepseek-ai` 本身）。 */
  scopeLayer: string;
  /** 直接含 dsh-tool-* 的目录（scope 形态之二）。 */
  orphanScope: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), "sg-surface-"));
  const nodeModules = join(base, "node_modules");
  const scopeLayer = join(nodeModules, "@deepseek-ai");
  const pkgDir = join(scopeLayer, "dsh-fixture");
  sources.forEach((source, index) => {
    const dir = join(
      pkgDir,
      "node_modules",
      "@deepseek-ai",
      `dsh-tool-fixture-${index}`,
      "lib",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.js"), source);
  });
  const orphanScope = join(base, "orphan-scope");
  const orphanDir = join(orphanScope, "dsh-tool-orphan", "lib");
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(join(orphanDir, "index.js"), SOURCES.read);
  return {
    root: pkgDir,
    nodeModules,
    scopeLayer,
    orphanScope,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

test("tool-surface-check：逐工具三分类 + 名称未解析，有「需关注」→ exit 1", () => {
  const fixture = makeFixture([
    SOURCES.read,
    SOURCES.future,
    SOURCES.nested,
    SOURCES.computed,
    SOURCES.plain,
  ]);
  try {
    const run = runScript(["--root", fixture.root]);
    assert.equal(run.status, 1, run.output);
    // 已覆盖：按工具名去重（不做包级文本 grep，故 plain / future 不会混进来）
    assert.match(run.output, /已覆盖 1：read/);
    // 需关注：顶层 path + 数组元素 path + 名称未解析但 script 命中
    assert.match(run.output, /需关注 3：/);
    assert.match(run.output, /future_tool（path，dsh-tool-fixture-1：path）/);
    assert.match(run.output, /nested_tool（path，dsh-tool-fixture-2：path）/);
    assert.match(
      run.output,
      /（名称未解析）（code，dsh-tool-fixture-3：script）/,
    );
    // 名称未解析单列一行（含包名与 name 表达式）
    assert.match(
      run.output,
      /名称未解析 1：dsh-tool-fixture-3（name: toolName；参数键 script）/,
    );
    assert.match(run.output, /未覆盖但无路径\/命令参数 1：plain_tool/);
    // 键集单一来源标注（dist 优先 / src 仓库内回退）
    assert.match(run.output, /键集\/登记集来源：(src|dist)（/);
    assert.doesNotMatch(run.output, /未找到 dsh-tool/);
  } finally {
    fixture.cleanup();
  }
});

test("tool-surface-check：摘要固定输出覆盖边界行（MCP / 第三方 / 非 dsh-tool-* 官方包均不在面内）", () => {
  const fixture = makeFixture([SOURCES.read, SOURCES.plain]);
  try {
    const run = runScript(["--root", fixture.root]);
    assert.equal(run.status, 0, run.output);
    // 固定一行且只一行（与结果无关）：面 = dsh-tool-*，MCP / 第三方 / 非该命名的官方包都不在面内
    const lines = run.output
      .split("\n")
      .filter((line) => line.includes("覆盖边界："));
    assert.equal(lines.length, 1, run.output);
    const boundary = lines[0] ?? "";
    assert.match(boundary, /只扫 dsh-tool-\* 包/);
    assert.match(
      boundary,
      /其它官方包（如 dsh-plan-mode \/ dsh-schedule \/ dsh-experimental-tool-agent-team）/,
    );
    assert.match(boundary, /MCP 与第三方运行时注册的工具均不在面内/);
    assert.match(boundary, /unknownToolAllowlist（如 mcp__\*）/);
    assert.match(boundary, /exit 0 不等于全覆盖/);
  } finally {
    fixture.cleanup();
  }
});

test("tool-surface-check：--json 输出 boundary 文案 + 稳定布尔字段（coversMcpTools / exitZeroMeansFullCoverage）", () => {
  const fixture = makeFixture([SOURCES.read, SOURCES.plain]);
  try {
    const run = runScript(["--root", fixture.root, "--json"]);
    assert.equal(run.status, 0, run.output);
    const parsed = JSON.parse(run.output) as {
      boundary?: string;
      coversMcpTools?: boolean;
      exitZeroMeansFullCoverage?: boolean;
    };
    // 稳定语义：布尔字段一眼可读，机器消费不该整串比对 boundary 文案
    assert.equal(parsed.coversMcpTools, false);
    assert.equal(parsed.exitZeroMeansFullCoverage, false);
    assert.equal(typeof parsed.boundary, "string");
    const boundary = parsed.boundary ?? "";
    assert.match(boundary, /mcp/i);
    assert.match(boundary, /只扫 dsh-tool-\* 包/);
    assert.match(boundary, /dsh-plan-mode/);
    assert.match(boundary, /exit 0 不等于全覆盖/);
    // 摘要行 = 固定前缀 + 该字段内容（同一份文案，不分叉）
    const human = runScript(["--root", fixture.root]);
    assert.ok(human.output.includes(`覆盖边界：${boundary}`), human.output);
  } finally {
    fixture.cleanup();
  }
});

test("tool-surface-check：--json 结构化输出（三分类 + 未解析名 + 包/工具计数）", () => {
  const fixture = makeFixture([
    SOURCES.read,
    SOURCES.future,
    SOURCES.nested,
    SOURCES.computed,
    SOURCES.plain,
  ]);
  try {
    const run = runScript(["--root", fixture.root, "--json"]);
    assert.equal(run.status, 1);
    const parsed = JSON.parse(run.output) as {
      packages: number;
      tools: number;
      covered: string[];
      needAttention: Array<{
        name: string | null;
        pkg: string;
        kind: string;
        keys: string[];
      }>;
      unresolvedNames: Array<{ pkg: string; nameExpr: string; keys: string[] }>;
      uncoveredPlain: Array<{ name: string; pkg: string }>;
      surfaceOrigin: string;
      surfacePath: string;
    };
    assert.equal(parsed.packages, 5);
    assert.equal(parsed.tools, 5);
    assert.deepEqual(parsed.covered, ["read"]);
    assert.deepEqual(
      parsed.needAttention.map((item) => item.name),
      ["future_tool", "nested_tool", null],
    );
    assert.deepEqual(parsed.needAttention[2]?.keys, ["script"]);
    assert.deepEqual(parsed.unresolvedNames, [
      {
        pkg: "dsh-tool-fixture-3",
        nameExpr: "toolName",
        keys: ["script"],
        watched: ["script"],
      },
    ]);
    assert.deepEqual(
      parsed.uncoveredPlain.map((item) => item.name),
      ["plain_tool"],
    );
    assert.ok(["src", "dist"].includes(parsed.surfaceOrigin));
    assert.match(
      parsed.surfacePath,
      /(?:src[/\\]index\.ts|dist[/\\]src[/\\]index\.js)$/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("tool-surface-check：无 --root 且无 DSH_INSTALL → 用法提示（含 0 的限定）+ exit 2（不回退 cwd）", () => {
  const fixture = makeFixture([SOURCES.read, SOURCES.future]);
  try {
    // cwd 特意指到「有工具包的宿主树」，证明不再按 cwd 回退
    const run = runScript([], {
      cwd: fixture.root,
      env: { DSH_INSTALL: "" },
    });
    assert.equal(run.status, 2, run.output);
    assert.match(run.output, /缺少宿主目录/);
    assert.match(run.output, /用法：/);
    assert.doesNotMatch(run.output, /已覆盖/);
    // 用法文案里 0 的限定：0 只覆盖 dsh-tool-* 面（P5）
    assert.match(run.output, /0 仅指 dsh-tool-\* 面内/);
    assert.match(
      run.output,
      /不覆盖 MCP \/ 第三方运行时注册的工具，\s*也不覆盖宿主内非 dsh-tool-\* 的其它官方包/,
    );
    // --help 走同一份 USAGE（同一条限定）
    const help = runScript(["--help"]);
    assert.equal(help.status, 0, help.output);
    assert.match(help.output, /0 仅指 dsh-tool-\* 面内/);
    assert.match(help.output, /不覆盖 MCP \/ 第三方运行时注册的工具/);
  } finally {
    fixture.cleanup();
  }
});

test("tool-surface-check：--root 指到 scope 层 → 纠正提示 + exit 2（不静默绿）", () => {
  const fixture = makeFixture([SOURCES.read, SOURCES.future]);
  try {
    for (const scope of [fixture.scopeLayer, fixture.orphanScope]) {
      const run = runScript(["--root", scope]);
      assert.equal(run.status, 2, `${scope}\n${run.output}`);
      assert.match(run.output, /scope 层/);
      assert.match(run.output, /改指 \*\*dsh 包目录\*\*/);
      assert.doesNotMatch(run.output, /已覆盖/);
    }
  } finally {
    fixture.cleanup();
  }
});

test("tool-surface-check：--root 指到安装树 node_modules 层 / --root 缺值 / 未知参数", () => {
  const fixture = makeFixture([SOURCES.read, SOURCES.future]);
  try {
    // 安装树 node_modules 层也能扫到（等价指法）
    const viaNodeModules = runScript(["--root", fixture.nodeModules, "--json"]);
    assert.equal(viaNodeModules.status, 1, viaNodeModules.output);
    const parsed = JSON.parse(viaNodeModules.output) as { packages: number };
    assert.equal(parsed.packages, 2);
    // DSH_INSTALL 作为 --root 的等价来源
    const viaEnv = runScript([], { env: { DSH_INSTALL: fixture.root } });
    assert.equal(viaEnv.status, 1, viaEnv.output);
    assert.match(viaEnv.output, /已覆盖 1：read/);
    // --root 缺值 / 未知参数 / root 下无工具包 → 一律 exit 2
    const missingValue = runScript(["--root"]);
    assert.equal(missingValue.status, 2);
    assert.match(missingValue.output, /--root 缺值/);
    const unknownArg = runScript(["--nope"]);
    assert.equal(unknownArg.status, 2);
    assert.match(unknownArg.output, /未知参数/);
    const emptyDir = mkdtempSync(join(tmpdir(), "sg-surface-empty-"));
    try {
      const noPackages = runScript(["--root", emptyDir]);
      assert.equal(noPackages.status, 2);
      assert.match(noPackages.output, /未找到 dsh-tool-\* 工具包/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  } finally {
    fixture.cleanup();
  }
});

test("tool-surface-check：干净宿主（无「需关注」）→ exit 0（门禁通过）", () => {
  const fixture = makeFixture([SOURCES.read, SOURCES.plain]);
  try {
    const run = runScript(["--root", fixture.root]);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /需关注 0：无/);
    assert.match(run.output, /名称未解析 0：无/);
    assert.match(run.output, /已覆盖 1：read/);
  } finally {
    fixture.cleanup();
  }
});

test("tool-surface-check 参数发现深度：第 3 层形态（children[].executor.command）计入「需关注」", () => {
  const fixture = makeFixture([SOURCES.level3]);
  try {
    const run = runScript(["--root", fixture.root]);
    assert.equal(run.status, 1, run.output);
    assert.match(
      run.output,
      /level3_tool（command，dsh-tool-fixture-0：command）/,
    );
    // 深度来自引擎单一来源（TOOL_SURFACE.keyDepth），脚本不自维护深度数字
    assert.match(
      run.output,
      /参数发现深度上限 3 层（引擎 TOOL_SURFACE\.keyDepth 单一来源/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("tool-surface-check 参数发现深度：第 4 层形态不计入「需关注」（锁引擎 3 层上限）", () => {
  const fixture = makeFixture([SOURCES.level4]);
  try {
    const run = runScript(["--root", fixture.root]);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /需关注 0：无/);
    assert.match(run.output, /未覆盖但无路径\/命令参数 1：level4_tool/);
  } finally {
    fixture.cleanup();
  }
});

test("tool-surface-check：参数面含顶层展开（`...`）的未登记工具 → 保守计入「需关注」", () => {
  const fixture = makeFixture([
    SOURCES.read,
    `
ctx.tools.register(defineTool({
    name: "spread_tool",
    description: "fixture 参数面含展开",
    parameters: {
        description: { type: "string" },
        ...extra ? { when: { type: "string" } } : {}
    },
}));
`,
  ]);
  try {
    const run = runScript(["--root", fixture.root]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /spread_tool（参数面含展开，dsh-tool-fixture-1）/);
  } finally {
    fixture.cleanup();
  }
});

test("tool-surface-check：损坏安装（只有 scripts，无 dist 无 src）→ exit 2 + 先 build 提示", () => {
  const fixture = makeFixture([SOURCES.read, SOURCES.future]);
  const layouts = mkdtempSync(join(tmpdir(), "sg-surface-pkg-"));
  try {
    const script = makeInstalledLayout(layouts, "broken", false);
    const run = runScript(["--root", fixture.root], { script });
    // 不静默当作「无规则」：口径来源缺失即 exit 2 并提示先构建
    assert.equal(run.status, 2, run.output);
    assert.match(run.output, /键集\/登记集单一来源解析失败/);
    assert.match(run.output, /npm --prefix security-guard run build/);
    assert.doesNotMatch(run.output, /已覆盖/);
  } finally {
    rmSync(layouts, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test(
  "tool-surface-check：发布形态（只有 dist + scripts）→ 键集来源 dist",
  { skip: existsSync(DIST_INDEX) ? false : "dist 未构建（先 npm run build）" },
  () => {
    const fixture = makeFixture([SOURCES.read, SOURCES.future]);
    const layouts = mkdtempSync(join(tmpdir(), "sg-surface-pkg-"));
    try {
      const script = makeInstalledLayout(layouts, "published", true);
      const run = runScript(["--root", fixture.root], { script });
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /键集\/登记集来源：dist（/);
      assert.match(run.output, /已覆盖 1：read/);
      assert.match(run.output, /future_tool（path，dsh-tool-fixture-1：path）/);
    } finally {
      rmSync(layouts, { recursive: true, force: true });
      fixture.cleanup();
    }
  },
);
