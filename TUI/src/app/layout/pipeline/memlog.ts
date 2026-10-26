/**
 * 诊断用内存/渲染日志器（OOM/会话重启排查）。
 *
 * 每次渲染调用 `memlogTick()` 会以节流频率(默认 1000ms)向目标文件**追加**一行:
 *   时间 ISO | heapUsed MB | rss MB | 本次渲染调用累计次数 | 最近一次 buildFrame 行数
 *
 * 目标文件取 `process.env.DSH_LAYOUT_MEMLOG`; 未设置时回退到
 * `<仓库根>/tmp/layout-mem.log`（repo 根 tmp/ 不存在则用 os.tmpdir()）。
 *
 * 关闭方式: 设 `DSH_LAYOUT_MEMLOG=off` 则完全禁用（零开销）。
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const rss = (): string => {
  try {
    return (process.memoryUsage().rss / 1048576).toFixed(1);
  } catch {
    return "?";
  }
};

const heap = (): string => {
  try {
    return (process.memoryUsage().heapUsed / 1048576).toFixed(1);
  } catch {
    return "?";
  }
};

let enabled = true;
let path = "";
try {
  const env = process.env.DSH_LAYOUT_MEMLOG;
  if (env === undefined) {
    const fallback = join(process.cwd(), "tmp", "layout-mem.log");
    path = fallback;
  } else if (env === "off") {
    enabled = false;
  } else {
    path = env;
  }
} catch {
  enabled = false;
}

let last = 0;
let calls = 0;
let lastRows = 0;

/** 进程启动标记：模块加载时落一行 START，便于同一文件区分多次运行（起点=START，
 * 终点=文件中该 START 之后的最后一行；崩溃前最后一行即上次停在哪）。 */
function memlogWritten(): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      path,
      [
        new Date(Date.now()).toISOString(),
        "START",
        `heap=${heap()}MB`,
        `rss=${rss()}MB`,
      ].join(" ") + "\n",
      "utf8",
    );
  } catch {
    // 落盘失败不阻断
  }
}
if (enabled && path !== "") {
  try {
    memlogWritten();
  } catch {
    // 忽略
  }
}

const throttleMs = (() => {
  const v = Number(process.env.DSH_LAYOUT_MEMLOG_MS);
  return Number.isFinite(v) && v > 0 ? v : 1000;
})();

/** renderPaneNew 每次渲染调用处埋点；按节流频率落盘（append）。 */
export function memlogTick(rows: number): void {
  if (!enabled || path === "") return;
  calls += 1;
  lastRows = rows;
  const now = Date.now();
  if (now - last < throttleMs) return;
  last = now;
  let text = "";
  try {
    text = [
      new Date(now).toISOString(),
      `heap=${heap()}MB`,
      `rss=${rss()}MB`,
      `calls=${calls}`,
      `rows=${lastRows}`,
    ].join(" ");
  } catch {
    return;
  }
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, text + "\n", "utf8");
  } catch {
    // 落盘失败不阻断渲染
  }
}

/** 工具段落渲染前打点（不节流，每个 tool 段落一次）：记录将渲染的工具名 + 当前内存。
 * 用于对齐「渲染哪个工具时内存爬升 / 崩溃」。 */
export function memlogTool(tools: readonly string[]): void {
  if (!enabled || path === "") return;
  let text = "";
  try {
    text = [
      new Date(Date.now()).toISOString(),
      "TOOL",
      `heap=${heap()}MB`,
      `rss=${rss()}MB`,
      "names=" + (tools.length > 0 ? tools.join(",") : "<none>"),
    ].join(" ");
  } catch {
    return;
  }
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, text + "\n", "utf8");
  } catch {
    // 落盘失败不阻断渲染
  }
}
