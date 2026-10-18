#!/usr/bin/env node
/**
 * output-compress 宿主联调 smoke（profile: dsh-toolset-output-compress，对齐 DSH 0.2.0-rc.2）。
 *
 * 流程：
 *   0. 环境自检：宿主 dsh 版本、`DEEPSEEK_API_KEY`（headless 会话需要模型凭据）
 *   1. 临时 `DSH_HOME` 引导 profile：session-paths / memory-base / output-compress 三包
 *      `link:` 挂载（node_modules 直连仓库符号链接，不经 pnpm store）
 *   2. 缺 dist 时先构建（output-compress + memory-base 双包）
 *   3. 真实 dsh headless 一次性会话：bash cat 大文件（>50KB → 宿主 spill → 触发本插件）
 *   4. 断言（**每会话自持 digest.db** 口径，2026-10-17 重定）：
 *      - `<会话目录>/digest.db` 存在、指纹对、`digests` 有 bash 记录；
 *      - 记录带真实 spill locator，切片索引定位回原始字节（marker 行）；
 *      - `digests_fts` 能召回 marker 词；
 *      - `<会话目录>/session.db`（memory-base S 层）有 `kind_digest` 行（`is_error` 推送路径）。
 *   5. 模型偶发未调用工具时（会话内无 tool/result 事件）有限重试一次；断言只针对真实会话载荷。
 *
 * 清理：成功删除临时目录；失败保留（打印路径）供排查。
 * 退出码 0 = 全部断言通过。
 */

import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const KB_ROOT = path.resolve(PKG_ROOT, "..", "memory-base");
const SP_ROOT = path.resolve(PKG_ROOT, "..", "session-paths");
const PROFILE = "dsh-toolset-output-compress";
const PKG_NAME_OC = "@dsh-toolset/output-compress";
const PKG_NAME_KB = "@dsh-toolset/memory-base";
const PKG_NAME_SP = "@dsh-toolset/session-paths";
const REQUIRED_VERSION = "0.2.0-rc.2";
const DIGEST_APP_ID = 0x44494745; // output-compress digest-db.ts 'DIGE'
const MARKER = "ERROR output-compress-smoke-marker unique-token-42";
const MARKER_LINE = 1402;

// 三包都插自身；两台存储插件都不配路径——`digest.db` 与 memory-base 的 S 层都由
// `sessionPaths.sessionDirFor(sessionId)` 推导（2026-10-17 口径）。
const CORDIS_PATCH = `# 本 profile 用户层：session-paths + memory-base + output-compress（由 smoke 脚本管理，勿手改）。
# 不配 dbPath / sessionDir：两包都从 session-paths 服务推导会话目录。
- id: session-paths
  name: '@dsh-toolset/session-paths'

- id: memory-base
  name: '@dsh-toolset/memory-base'
  config:
    project: 'dsh-toolset-output-compress'

- id: output-compress
  name: '@dsh-toolset/output-compress'
`;

// 大文件任务提示词：强制模型用 bash cat 完整输出预置大文件（确定性 >50KB → 宿主 spill）
const SESSION_TASK =
  "使用 bash 工具执行命令：cat big-output.txt（必须完整输出该文件内容，不要截断、不要摘要、不要换用其他命令），完成后简短回复 done。不要使用其他工具。";

// 预置大文件：2000 行 × ~33 字符 ≈ 66KB（超宿主 50KB spill 阈值，留裕量）；
// 第 1 行为 markdown 标题（供 headings 断言），第 MARKER_LINE 行为错误标记（供 keyLines/FTS 断言）
function makeBigFileLines() {
  const lines = [];
  lines.push("# BUILD REPORT — output-compress smoke fixture");
  for (let n = 2; n < MARKER_LINE; n++) {
    lines.push(`pad line ${String(n).padStart(4, "0")} aaaa bbbb cccc dddd`);
  }
  lines.push(MARKER);
  for (let n = MARKER_LINE + 1; n <= 2000; n++) {
    lines.push(`pad line ${String(n).padStart(4, "0")} eeee ffff gggg hhhh`);
  }
  return lines;
}

/** 完整大文件文本（行尾换行）。 */
function makeBigFileText() {
  return `${makeBigFileLines().join("\n")}\n`;
}

let failed = false;
let tmp = null;
let home = null;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function step(label) {
  process.stdout.write(`[smoke] ${label} ... `);
}

function ok(detail = "") {
  process.stdout.write(`OK${detail ? ` — ${detail}` : ""}\n`);
}

function fail(msg) {
  failed = true;
  process.stdout.write(`FAIL — ${msg}\n`);
}

function assert(cond, msg) {
  if (cond) return true;
  fail(msg);
  return false;
}

function queryCount(db, sql) {
  return db.prepare(sql).get().n;
}

// 大文件体积自检（构造错误不该混入会话环节）
function assertFixtureSize() {
  const bytes = Buffer.byteLength(makeBigFileText(), "utf8");
  if (
    assert(
      bytes > 55 * 1024,
      `大文件构造异常：仅 ${bytes} 字节（需 >55KB 留裕量触发 50KB spill）`,
    )
  ) {
    return bytes;
  }
  return 0;
}

// --- 0. 环境自检 ---
function checkVersion() {
  step("dsh 版本");
  let version;
  try {
    version = run("dsh", ["--version"]).trim();
  } catch (error) {
    fail(`dsh 不可用：${String(error.message).split("\n")[0]}`);
    return;
  }
  if (
    assert(
      version.includes(REQUIRED_VERSION),
      `dsh 版本 ${version}，要求 ${REQUIRED_VERSION}`,
    )
  ) {
    ok(version);
  }
}

function checkCredentials() {
  step("模型凭据");
  if (
    assert(
      typeof process.env.DEEPSEEK_API_KEY === "string" &&
        process.env.DEEPSEEK_API_KEY !== "",
      "缺 DEEPSEEK_API_KEY（headless 会话需要模型凭据；在启动环境导出后重跑）",
    )
  ) {
    ok("DEEPSEEK_API_KEY 已设置");
  }
}

// --- 1. 临时 DSH_HOME + profile 引导（幂等） ---
function ensureProfile() {
  step(`profile ${PROFILE} 引导（临时 DSH_HOME）`);
  home = mkdtempSync(path.join(tmp, "home-"));
  const env = { ...process.env, DSH_HOME: home };
  // 凭据文件（若存在）软链进临时 home，避免复制密钥
  const credSrc = path.join(homedir(), ".dsh", ".credentials.yaml");
  if (existsSync(credSrc)) {
    try {
      symlinkSync(credSrc, path.join(home, ".credentials.yaml"));
    } catch {
      // 凭据软链失败不阻塞：headless 用 env key
    }
  }
  const profileDir = path.join(home, "profiles", PROFILE);
  try {
    run(
      "dsh",
      [
        "--profile",
        PROFILE,
        "--from-default-profile",
        "headless",
        "--dump-config",
      ],
      { env },
    );
  } catch (error) {
    fail(`profile 创建失败：${String(error.message).split("\n")[0]}`);
    return;
  }
  const pkgPath = path.join(profileDir, "package.json");
  if (!assert(existsSync(pkgPath), `profile 创建失败：${pkgPath} 不存在`))
    return;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const wanted = [
    [PKG_NAME_SP, SP_ROOT],
    [PKG_NAME_KB, KB_ROOT],
    [PKG_NAME_OC, PKG_ROOT],
  ];
  pkg.dependencies = pkg.dependencies ?? {};
  const bundles = new Set(pkg.dsh?.profile?.bundles ?? []);
  for (const [name, root] of wanted) {
    pkg.dependencies[name] = `link:${root}`;
    bundles.add(name);
  }
  pkg.dsh = {
    ...(pkg.dsh ?? {}),
    profile: { ...(pkg.dsh?.profile ?? {}), bundles: [...bundles] },
  };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  writeFileSync(path.join(profileDir, "cordis.patch.yml"), CORDIS_PATCH, "utf8");
  // link: 依赖直连仓库（不经 pnpm store：沙箱 / CI 里 store 可能不可写）
  const scopeDir = path.join(profileDir, "node_modules", "@dsh-toolset");
  mkdirSync(scopeDir, { recursive: true });
  for (const [name, root] of wanted) {
    const linkPath = path.join(scopeDir, name.split("/")[1]);
    if (!existsSync(linkPath)) symlinkSync(root, linkPath);
  }
  ok(profileDir);
}

// --- 2. 构建（幂等；双包 dist 均需就绪） ---
function ensureBuild() {
  step("dist 构建");
  for (const [name, root] of [
    [PKG_NAME_OC, PKG_ROOT],
    [PKG_NAME_KB, KB_ROOT],
  ]) {
    const entry = path.join(root, "dist", "src", "index.js");
    if (!existsSync(entry)) {
      try {
        run("npm", ["run", "build"], { cwd: root });
      } catch (error) {
        fail(`构建失败（${name}）：${String(error.message).split("\n")[0]}`);
        return;
      }
    }
    if (!assert(existsSync(entry), `dist 产物缺失（${name}）：${entry}`))
      return;
  }
  ok();
}

// --- 3. 真实会话 ---
function runSession(taskDir) {
  step("真实 dsh headless 会话（bash 大输出 → spill）");
  const bytes = assertFixtureSize();
  if (failed) return false;
  writeFileSync(
    path.join(taskDir, "big-output.txt"),
    makeBigFileText(),
    "utf8",
  );
  try {
    run("dsh", ["--profile", PROFILE, SESSION_TASK], {
      cwd: taskDir,
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_PERMISSION_MODE: "danger-full-access",
      },
    });
  } catch (error) {
    fail(
      `会话未成功退出（API 不可达或宿主异常？）：${String(error.message).split("\n")[0]}；stderr 尾部：${String(error.stderr ?? "").slice(-400)}`,
    );
    return false;
  }
  ok(`exit 0（fixture ${bytes} 字节）`);
  return true;
}

/** 在临时 home 的 sessions 下找本次会话目录（含 digest.db 或 session.db 的目录）。 */
function findSessionDir() {
  const root = path.join(home, "sessions");
  if (!existsSync(root)) return null;
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(dir, entry.name);
      if (
        existsSync(path.join(p, "digest.db")) ||
        existsSync(path.join(p, "session.db"))
      ) {
        hits.push(p);
      }
      walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return hits.sort().at(-1) ?? null;
}

// --- 4. SQLite 断言（digest.db 指纹 / bash 记录 / 切片定位 / FTS / memory-base digest 行） ---
function assertStorage(sessionDir) {
  step("断言 digest.db 与 memory-base S 层");
  const digestPath = path.join(sessionDir, "digest.db");
  if (!assert(existsSync(digestPath), `会话目录无 digest.db：${digestPath}`))
    return false;
  const db = new DatabaseSync(digestPath, { readOnly: true });
  try {
    const { application_id: appId } = db.prepare("PRAGMA application_id").get();
    if (
      !assert(
        appId === DIGEST_APP_ID,
        `digest.db 指纹不匹配（application_id=${appId?.toString(16)}）`,
      )
    ) {
      return false;
    }
    const rows = queryCount(db, "SELECT COUNT(*) AS n FROM digests");
    if (!assert(rows >= 1, "digests 表为空（未入库）")) return false;
    const records = db
      .prepare(
        "SELECT id, tool, locator, slices FROM digests ORDER BY id",
      )
      .all();
    const sliceRe =
      /- #\d+ L(\d+)-(\d+) C(\d+)-(\d+) fnv=[0-9a-f]+ "[^"]*"/g;
    let picked = null;
    for (const rec of records) {
      if (String(rec.tool) !== "bash") continue;
      const locator = rec.locator === null ? "" : String(rec.locator);
      if (locator === "" || !existsSync(locator)) continue;
      const spillLines = readFileSync(locator, "utf8").split("\n");
      const markerLine = spillLines.findIndex((l) => l.trim() === MARKER) + 1;
      if (markerLine === 0) continue;
      let slice = null;
      for (const m of String(rec.slices).matchAll(sliceRe)) {
        const start = Number(m[1]);
        const end = Number(m[2]);
        if (start <= markerLine && markerLine <= end) slice = { start, end };
      }
      if (slice !== null) {
        picked = { rec, slice, markerLine, spillLines };
        break;
      }
    }
    if (
      !assert(
        picked !== null,
        `无满足断言的 digest 记录（共 ${records.length} 条）：tool=bash、spill locator 存在、切片覆盖 marker 行需同时成立`,
      )
    ) {
      return false;
    }
    const { rec, slice, markerLine, spillLines } = picked;
    const ftsHits = queryCount(
      db,
      `SELECT COUNT(*) AS n FROM digests_fts WHERE digests_fts MATCH '"unique-token-42"'`,
    );
    if (!assert(ftsHits >= 1, "FTS 召回失败：marker 词未命中 digests_fts"))
      return false;
    const rawLine = spillLines[markerLine - 1];
    if (
      !assert(
        rawLine === MARKER,
        `切片 L${slice.start}-${slice.end} 定位的 spill 第 ${markerLine} 行与 marker 不符：${JSON.stringify(rawLine)}`,
      )
    ) {
      return false;
    }
    ok(
      `digest.db 指纹 OK；digests ${rows} 条（id=${rec.id}）；切片 L${slice.start}-${slice.end} 定位 marker 成功；FTS 命中 ${ftsHits}`,
    );
  } finally {
    db.close();
  }

  // memory-base S 层：is_error 摘要经作用域句柄推送（kind: digest）
  step("断言 memory-base S 层 kind_digest 行");
  const sessionDb = path.join(sessionDir, "session.db");
  if (
    !assert(
      existsSync(sessionDb),
      `会话目录无 memory-base session.db：${sessionDb}（S 层未落盘）`,
    )
  ) {
    return false;
  }
  const kb = new DatabaseSync(sessionDb, { readOnly: true });
  try {
    const pushRows = queryCount(kb, "SELECT COUNT(*) AS n FROM kind_digest");
    if (
      !assert(
        pushRows >= 1,
        "memory-base S 层无 kind_digest 行（is_error 推送未生效）",
      )
    ) {
      return false;
    }
    ok(`kind_digest ${pushRows} 行`);
  } finally {
    kb.close();
  }
  return true;
}

// --- 主流程 ---
checkVersion();
checkCredentials();
if (!failed) {
  tmp = mkdtempSync(path.join(tmpdir(), "oc-smoke-"));
  ensureProfile();
}
if (!failed) ensureBuild();

if (!failed) {
  const taskDir = path.join(tmp, "task");
  mkdirSync(taskDir, { recursive: true });
  const digestRows = () => {
    const sessionDir = findSessionDir();
    const digestPath =
      sessionDir === null ? null : path.join(sessionDir, "digest.db");
    if (digestPath === null || !existsSync(digestPath)) return 0;
    const db = new DatabaseSync(digestPath, { readOnly: true });
    try {
      return queryCount(db, "SELECT COUNT(*) AS n FROM digests");
    } finally {
      db.close();
    }
  };
  let sessionOk = runSession(taskDir);
  // 模型偶发不调用工具（会话内无 tool/result 事件）：有限重试一次。
  // 不掩盖插件失败——插件有问题则每次会话都不入库，断言依然会失败。
  for (let attempt = 0; sessionOk && !failed && attempt < 2; attempt++) {
    if (digestRows() >= 1) break;
    step("真实 dsh headless 会话重试（模型未调用工具）");
    sessionOk = runSession(taskDir);
  }
  if (sessionOk && !failed) {
    const sessionDir = findSessionDir();
    if (assert(sessionDir !== null, "会话成功后未找到会话目录")) {
      assertStorage(sessionDir);
    }
  }
}

if (failed) {
  console.error(`\n[smoke] 失败。临时目录保留：${tmp}`);
  process.exit(1);
}
if (tmp) rmSync(tmp, { recursive: true, force: true });
console.log(
  "\n[smoke] PASS — digest.db 指纹 / 入库 / 切片定位 / FTS / memory-base 推送全部通过",
);
process.exit(0);
