#!/usr/bin/env node
/**
 * 本包自检 smoke（新接口口径，2026-10-17 接口重设后重写）。
 *
 * 覆盖面（确定性、不依赖模型凭据）：
 *   0. Node 版本与 dist 构建产物
 *   1. 分层落点：S 层经 `sessionPaths.sessionDirFor(sessionId)` 解析、P / U 层按配置，
 *      **open 不落盘**（惰性建库）
 *   2. 经作用域句柄写入（S / P / U 三层各一条）→ 断言三个库文件与 schema 指纹
 *      （`application_id` 按层、`user_version` 为当前版本）
 *   3. 全局读面：`search` 跨层加权、`list` 按 kind、`usage` 只报已创建的库
 *   4. 内容级闸门：隐私形态与 `preWrite` 拒写走 `skipped`；越权层抛错
 *   5. 真删：句柄 `forget` 返回条数
 *   6. 模型侧工具：`memory_query` 两种 action 的返回值与渲染
 *   7. 可选宿主面：`dsh --version` 可得时报告版本（宿主联调留人工确认，不阻塞）
 *
 * 清理：成功删除临时目录；失败保留（打印路径）供排查。退出码 0 = 全部断言通过。
 * 用法：npm run smoke（`-- --keep` 保留临时目录）。
 */

import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const KEEP = process.argv.includes("--keep");

/** 各层库指纹（与 `src/schema.ts` 的 `TIER_APPLICATION_IDS` 对齐）。 */
const APP_IDS = { session: 0x53455353, project: 0x50524f4a, user: 0x55534552 };
/** 当前 schema 版本（与 `src/schema.ts` 的 `KNOWLEDGE_SCHEMA_VERSION` 对齐）。 */
const SCHEMA_VERSION = 2;

let failed = false;
let tmp = null;
const result = { steps: 0, ok: 0 };

function step(label) {
  result.steps += 1;
  process.stdout.write(`[smoke] ${label} ... `);
}

function ok(detail = "") {
  result.ok += 1;
  process.stdout.write(`OK${detail ? ` — ${detail}` : ""}\n`);
}

function fail(message) {
  failed = true;
  process.stdout.write(`FAIL — ${message}\n`);
}

function assert(condition, message) {
  if (condition) return true;
  fail(message);
  return false;
}

/** 读库的指纹（只读打开；库不存在返回 undefined）。 */
function fingerprint(dbPath) {
  if (!existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const { application_id: appId } = db.prepare("PRAGMA application_id").get();
    const { user_version: version } = db.prepare("PRAGMA user_version").get();
    return { appId, version };
  } finally {
    db.close();
  }
}

/** 只读计数（库 / 表不存在返回 0）。 */
function count(dbPath, sql) {
  if (!existsSync(dbPath)) return 0;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(db.prepare(sql).get().n);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

async function main() {
  // --- 0. 运行时与构建产物 ---
  step("Node 版本与 dist 产物");
  const major = Number(process.versions.node.split(".")[0]);
  if (
    !assert(
      major >= 22,
      `Node ${process.versions.node}，要求 >= 22（node:sqlite）`,
    )
  ) {
    return;
  }
  const entry = path.join(PKG_ROOT, "dist", "src", "index.js");
  if (!existsSync(entry)) {
    try {
      execFileSync("npm", ["run", "build"], { cwd: PKG_ROOT, stdio: "ignore" });
    } catch (error) {
      fail(`构建失败：${String(error.message).split("\n")[0]}`);
      return;
    }
  }
  if (!assert(existsSync(entry), `dist 产物缺失：${entry}`)) return;
  ok(process.versions.node);

  // --- 1. 惰性建库与分层落点 ---
  step("分层落点（惰性建库）");
  tmp = mkdtempSync(path.join(tmpdir(), "kb-smoke-"));
  const dshHome = path.join(tmp, "dsh");
  const projectRoot = path.join(tmp, "repo");
  const sessionRoot = path.join(tmp, "sessions");
  const userPath = path.join(dshHome, "memory-base", "user.db");
  const projectPath = path.join(projectRoot, ".dsh", "project.db");
  const sessionPath = path.join(sessionRoot, "s1", "session.db");

  const index = await import(entry);
  const bundle = index.createMemoryBundle({
    config: { dshHome, projectRoot, project: "smoke" },
    sessionPaths: { sessionDirFor: (id) => path.join(sessionRoot, id) },
  });
  const memory = index.createGlobalService(bundle, {
    dshHome,
    projectRoot,
    project: "smoke",
  });
  try {
    const summary = bundle.summary();
    if (
      !assert(
        summary.tiers.length === 2 &&
          summary.tiers.every((tier) => tier.created === false),
        `摘要落点不符（期望 P / U 两层且均未创建）：${JSON.stringify(summary.tiers)}`,
      )
    ) {
      return;
    }
    if (!assert(!existsSync(userPath), "open 阶段不应创建用户库（惰性建库）"))
      return;
    if (
      !assert(!existsSync(projectPath), "open 阶段不应创建项目库（惰性建库）")
    )
      return;
    ok("P / U 落点已解析且未落盘");

    // --- 2. 句柄写入三层 ---
    step("作用域句柄写入（S / P / U）");
    const note = memory.registerKind({
      kind: "note",
      writableTiers: ["session", "project", "user"],
    });
    const pref = memory.registerKind({
      kind: "pref",
      writableTiers: ["user"],
      preWrite: (input) =>
        input.content.startsWith("deny")
          ? { accept: false, reason: "smoke 钩子拒写" }
          : { accept: true, importance: 4 },
    });
    const s = await note.put({ content: "smoke 会话层条目", sessionId: "s1" });
    const p = await note.put({ content: "smoke 项目层条目", tier: "project" });
    const u = await pref.put({ content: "smoke 用户层条目", tier: "user" });
    if (
      !assert(
        s.created === 1 && p.created === 1 && u.created === 1,
        `三层写入未全部成功：S=${s.created} P=${p.created} U=${u.created}`,
      )
    ) {
      return;
    }
    if (!assert(existsSync(sessionPath), `会话库未创建：${sessionPath}`))
      return;
    if (!assert(existsSync(projectPath), `项目库未创建：${projectPath}`))
      return;
    if (!assert(existsSync(userPath), `用户库未创建：${userPath}`)) return;

    for (const [tier, dbPath] of [
      ["session", sessionPath],
      ["project", projectPath],
      ["user", userPath],
    ]) {
      const fp = fingerprint(dbPath);
      if (
        !assert(
          fp?.appId === APP_IDS[tier] && fp?.version === SCHEMA_VERSION,
          `${tier} 库指纹不符（application_id=${fp?.appId?.toString(16)} user_version=${fp?.version}）`,
        )
      ) {
        return;
      }
    }
    if (
      !assert(
        count(sessionPath, "SELECT COUNT(*) AS n FROM kind_note") === 1,
        "会话库未落 kind_note 行",
      )
    ) {
      return;
    }
    ok("三层库文件与指纹一致");

    // --- 3. 全局读面 ---
    step("全局读面（search / list / usage）");
    // 三层行都含 "smoke"：FTS5 命中后按层权重排序（U > P > S），跨层合并结果恒为 3 条。
    const hits = await memory.search({ query: "smoke" });
    if (
      !assert(
        hits.length === 3 &&
          hits[0]?.tier === "user" &&
          hits[1]?.tier === "project" &&
          hits[2]?.tier === "session",
        `跨层检索排序不符：${JSON.stringify(hits.map((hit) => hit.tier))}`,
      )
    ) {
      return;
    }
    const listed = await memory.list({ kind: "note" });
    if (
      !assert(
        listed.length === 2,
        `list(note) 期望 2 条，实得 ${listed.length}`,
      )
    ) {
      return;
    }
    const usage = await memory.usage();
    if (
      !assert(
        usage.length === 3 && usage.every((item) => item.bytes > 0),
        `usage 期望 3 个已创建库：${JSON.stringify(usage.map((item) => item.tier))}`,
      )
    ) {
      return;
    }
    ok(
      `命中 ${hits.length} 条；列举 ${listed.length} 条；用量 ${usage.length} 个库`,
    );

    // --- 4. 闸门 ---
    step("内容闸门与越权层");
    const privacy = await pref.put({
      content: "password: supersecretvalue",
      tier: "user",
    });
    const denied = await pref.put({ content: "deny 这条", tier: "user" });
    if (
      !assert(
        privacy.skipped === "pattern" && denied.skipped === "hook",
        `闸门原因不符：privacy=${privacy.skipped} hook=${denied.skipped}`,
      )
    ) {
      return;
    }
    let threw = false;
    try {
      await pref.put({ content: "越权写会话层" });
    } catch {
      threw = true;
    }
    if (!assert(threw, "越权层写入未抛错（应显式抛错）")) return;
    ok("隐私闸 / preWrite / 越权层均按约定");

    // --- 5. 真删 ---
    step("真删（forget 返回条数）");
    const removed = await pref.forget([{ tier: "user", ids: u.ids }]);
    if (!assert(removed === 1, `forget 期望删除 1 条，实得 ${removed}`)) return;
    if (
      !assert(
        (await memory.search({ query: "smoke", tier: "user" })).length === 0,
        "forget 后仍可检索到被删行",
      )
    ) {
      return;
    }
    ok("删除计数与可见性一致");

    // --- 6. 模型侧工具 ---
    step("memory_query 两种 action");
    const tool = index.memoryQueryTool({
      list: (opts) => memory.list(opts),
      search: (opts) => memory.search(opts),
    });
    const searchValue = await tool.execute({ query: "smoke" });
    const listValue = await tool.execute({
      action: "list",
      kind: "note",
      limit: 1,
    });
    if (
      !assert(
        searchValue.action === "search" && searchValue.count === 2,
        `search 返回不符：${JSON.stringify({ action: searchValue.action, count: searchValue.count })}`,
      )
    ) {
      return;
    }
    if (
      !assert(
        listValue.action === "list" &&
          listValue.count === 1 &&
          listValue.truncated === true,
        `list 返回不符：${JSON.stringify(listValue)}`,
      )
    ) {
      return;
    }
    const rendered = tool.output.render({}, listValue);
    if (
      !assert(
        typeof rendered[0]?.text === "string" &&
          rendered[0].text.includes("[note@") &&
          rendered[0].text.includes("已截断"),
        `渲染文本不符：${rendered[0]?.text ?? "(空)"}`,
      )
    ) {
      return;
    }
    ok("返回值与渲染一致");
  } finally {
    bundle.dispose();
  }

  // --- 7. 可选宿主面 ---
  step("宿主 dsh 版本（可选）");
  try {
    const version = execFileSync("dsh", ["--version"], {
      encoding: "utf8",
      timeout: 60_000,
    }).trim();
    ok(version);
  } catch {
    ok("未安装 dsh，跳过（宿主联调留人工确认）");
  }
}

try {
  await main();
} catch (error) {
  fail(`未捕获异常：${String(error?.stack ?? error)}`);
}

if (failed) {
  console.error(
    `\n[smoke] 失败（${result.ok}/${result.steps} 步通过）。临时目录：${tmp ?? "(未创建)"}`,
  );
  if (tmp !== null && !KEEP) {
    console.error("[smoke] 保留临时目录供排查；确认后手动删除。");
  }
  process.exit(1);
}
if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
console.log(`\n[smoke] PASS — ${result.ok}/${result.steps} 步全部通过`);
process.exit(0);
