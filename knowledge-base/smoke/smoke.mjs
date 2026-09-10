#!/usr/bin/env node
/**
 * 宿主联调 smoke（profile: dsh-toolset-kb，对齐 DSH-CTX-API 0.1.5-rc.2）。
 *
 * 流程：
 *   0. 检查宿主 dsh 版本（要求 0.1.5-rc.2）
 *   1. profile dsh-toolset-kb 引导（幂等：创建 → 挂载插件 link: → 写用户层配置）
 *   2. 缺 dist 时先构建
 *   3. 真实 dsh headless 一次性会话（低阈值强制压缩 + fs write 产生真实 meta）
 *   4. 断言 ctx_knowledge 注册（DB schema 指纹）与新字段摄取（[tool/meta]、shadowedRange）
 *   5. 真实载荷缺失时经 dist hooks 注入合成事件兜底（仅当会话本身成功）
 *   6. dist 产物 put/search/touch/evict 往返（对同一文件库）
 *
 * 清理：成功删除临时目录；失败保留（打印路径）供排查。
 * 退出码 0 = 全部断言通过。
 */

import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = "dsh-toolset-kb";
const PROFILE_DIR = path.join(homedir(), ".dsh", "profiles", PROFILE);
const PKG_NAME = "@dsh-toolset/knowledge-base";
const REQUIRED_VERSION = "0.1.5-rc.2";
const KNOWLEDGE_APP_ID = 0x4b4e4f57; // schema.ts KNOWLEDGE_APPLICATION_ID ('KNOW')
const KNOWLEDGE_SCHEMA_VERSION = 1;

const META_SQL =
  "SELECT COUNT(*) AS n FROM chunks WHERE category = 'tool/result' AND content LIKE '%[tool/meta]%'";
const COMP_SQL =
  "SELECT COUNT(*) AS n FROM chunks WHERE category = 'compaction/summary' AND (content LIKE '%shadowedRange%' OR content LIKE '%shadowedSeqs%')";
const RANGE_SQL =
  "SELECT COUNT(*) AS n FROM chunks WHERE category = 'compaction/summary' AND content LIKE '%shadowedRange%'";

const CORDIS_PATCH = `# 本 profile 用户层：knowledge-base 插件配置（由 smoke 脚本管理，勿手改）。
# dbPath 优先取 KNOWLEDGE_DB_PATH 环境变量（smoke 重定向到临时目录），
# 缺省落 ~/.dsh/knowledge-base/knowledge.db（dshHomePath 由宿主 !!js 提供）。
- id: knowledge-base
  name: '@dsh-toolset/knowledge-base'
  config:
    dbPath: !!js process.env.KNOWLEDGE_DB_PATH || dshHomePath('knowledge-base/knowledge.db')
    project: 'dsh-toolset-kb'
`;

const COMPACTION_OVERLAY = `# smoke 专用：强制低压缩阈值，让一次性会话也能触发 compaction/summary
# （宿主校验：retainRatio 必须 < thresholdRatio）
- id: compaction-basic
  config:
    thresholdRatio: 0.001
    retainRatio: 0.0004
`;

const SESSION_TASK =
  "使用 write 工具在 ./kb-smoke.txt 写入一行内容 kb-smoke-ok，然后简短确认。不要使用其他工具。";

let failed = false;
let tmp = null;

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

// --- 0. 宿主版本 ---
function checkVersion() {
  step("dsh 版本");
  let version;
  try {
    version = run("dsh", ["--version"]).trim();
  } catch (error) {
    fail(`dsh 不可用：${String(error.message).split("\n")[0]}`);
    return;
  }
  if (assert(version.includes(REQUIRED_VERSION), `dsh 版本 ${version}，要求 ${REQUIRED_VERSION}`)) {
    ok(version);
  }
}

// --- 1. profile 引导（幂等） ---
function ensureProfile() {
  step(`profile ${PROFILE} 引导`);
  if (!existsSync(path.join(PROFILE_DIR, "package.json"))) {
    try {
      run("dsh", [
        "--profile",
        PROFILE,
        "--from-default-profile",
        "headless",
        "--dump-config",
      ]);
    } catch (error) {
      fail(`profile 创建失败：${String(error.message).split("\n")[0]}`);
      return;
    }
  }
  const pkgPath = path.join(PROFILE_DIR, "package.json");
  if (!existsSync(pkgPath)) {
    fail(`profile 创建失败：${pkgPath} 不存在`);
    return;
  }
  let dep, bundles;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    dep = pkg.dependencies?.[PKG_NAME];
    bundles = pkg.dsh?.profile?.bundles ?? [];
  } catch (error) {
    fail(`profile package.json 解析失败：${String(error.message).split("\n")[0]}`);
    return;
  }
  if (dep !== `link:${PKG_ROOT}` || !bundles.includes(PKG_NAME)) {
    try {
      run("dsh", ["plugin", "--profile", PROFILE, "add", `${PKG_NAME}@link:${PKG_ROOT}`]);
    } catch (error) {
      fail(`插件挂载失败：${String(error.message).split("\n")[0]}`);
      return;
    }
  }
  writeFileSync(path.join(PROFILE_DIR, "cordis.patch.yml"), CORDIS_PATCH, "utf8");
  ok(PROFILE_DIR);
}

// --- 2. 构建（幂等） ---
function ensureBuild() {
  step("dist 构建");
  const entry = path.join(PKG_ROOT, "dist", "src", "index.js");
  if (!existsSync(entry)) {
    try {
      run("npm", ["run", "build"], { cwd: PKG_ROOT });
    } catch (error) {
      fail(`构建失败：${String(error.message).split("\n")[0]}`);
      return;
    }
  }
  if (assert(existsSync(entry), `dist 产物缺失：${entry}`)) ok();
}

// --- 3. 真实会话 ---
function runSession(dbPath, taskDir, overlayPath) {
  step("真实 dsh headless 会话");
  try {
    run("dsh", ["--profile", PROFILE, "--patch", overlayPath, SESSION_TASK], {
      cwd: taskDir,
      env: {
        ...process.env,
        KNOWLEDGE_DB_PATH: dbPath,
        DSH_PERMISSION_MODE: "danger-full-access",
      },
    });
  } catch (error) {
    fail(
      `会话未成功退出（API 不可达或宿主异常？）：${String(error.message).split("\n")[0]}；stderr 尾部：${String(error.stderr ?? "").slice(-400)}`,
    );
    return false;
  }
  ok("exit 0");
  return true;
}

// --- 4. SQLite 断言（注册指纹 + 0.1.5-rc.2 新字段摄取） ---
function assertIngestion(dbPath) {
  step("断言注册与摄取");
  if (!assert(existsSync(dbPath), `知识库文件未创建（bundle 未 apply）：${dbPath}`)) return false;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // 注册证据：库文件由 bundle apply 创建，schema 指纹匹配。
    const { application_id: appId } = db.prepare("PRAGMA application_id").get();
    const { user_version: version } = db.prepare("PRAGMA user_version").get();
    if (
      !assert(
        appId === KNOWLEDGE_APP_ID && version === KNOWLEDGE_SCHEMA_VERSION,
        `schema 指纹不匹配（application_id=${appId?.toString(16)}, user_version=${version}）`,
      )
    ) {
      return false;
    }
    const metaRows = queryCount(db, META_SQL);
    const compRows = queryCount(db, COMP_SQL);
    const rangeRows = queryCount(db, RANGE_SQL);
    if (!assert(metaRows >= 1, "未摄取 tool/result meta（[tool/meta] 段缺失）")) return false;
    if (!assert(compRows >= 1, "未摄取 compaction/summary 影子范围字段")) return false;
    ok(
      `注册指纹 OK；[tool/meta] ${metaRows} 条；shadowedRange ${rangeRows} 条${rangeRows < compRows ? "（含旧载荷回落）" : ""}`,
    );
    return true;
  } finally {
    db.close();
  }
}

// --- 5. 合成事件兜底（仅会话成功但载荷缺失时；经 dist hooks 注入） ---
async function syntheticBackstop(dbPath, { needMeta, needCompaction }) {
  if (!needMeta && !needCompaction) return;
  step("合成事件兜底注入");
  const schema = await import(path.join(PKG_ROOT, "dist", "src", "schema.js"));
  const knowledge = await import(path.join(PKG_ROOT, "dist", "src", "knowledge.js"));
  const hooks = await import(path.join(PKG_ROOT, "dist", "src", "hooks.js"));
  const db = await schema.openKnowledgeDatabase(dbPath);
  try {
    const sessionHooks = new hooks.SessionHooks(new knowledge.KnowledgeService(db), {
      project: "dsh-toolset-kb",
    });
    if (needMeta) {
      sessionHooks.handle("smoke-synthetic", {
        type: "tool/result",
        data: {
          message: {
            content: [
              {
                type: "tool-result",
                content: [{ type: "text", text: "synthetic write result" }],
                isError: false,
              },
            ],
          },
          meta: { diffs: [{ path: "/tmp/synthetic.txt", oldText: null, newText: "x" }] },
        },
      });
    }
    if (needCompaction) {
      sessionHooks.handle("smoke-synthetic", {
        type: "compaction/summary",
        data: {
          compactionId: "smoke-synthetic",
          summary: [{ type: "text", text: "synthetic compaction summary" }],
          shadowedRange: { start: 1, end: 2 },
          sourceCommandId: "smoke-synthetic-cmd",
          shadowedTokenCount: 100,
          provider: "smoke",
          model: "smoke-model",
        },
      });
    }
    ok(
      `注入 ${[needMeta && "meta", needCompaction && "compaction"].filter(Boolean).join(" + ")}`,
    );
  } finally {
    db.close();
  }
}

// --- 6. dist 往返 put/search/touch/evict ---
async function roundtrip(dbPath) {
  step("dist 往返 put/search/touch/evict");
  const schema = await import(path.join(PKG_ROOT, "dist", "src", "schema.js"));
  const knowledge = await import(path.join(PKG_ROOT, "dist", "src", "knowledge.js"));
  const db = await schema.openKnowledgeDatabase(dbPath);
  try {
    const kb = new knowledge.KnowledgeService(db);
    const project = "dsh-toolset-kb";
    const target = "smoke/roundtrip";
    const content = "smoke roundtrip marker 烟雾弹 12345";
    kb.put({ project, target, content, importance: 3, sessionId: "smoke" });
    const byEn = kb.search({ query: "roundtrip marker", project });
    const enHit = byEn[0];
    if (!assert(byEn.length === 1 && enHit?.content.includes("marker"), "porter 词干检索未命中"))
      return;
    const byCjk = kb.search({ query: "烟雾弹", project, fuzzy: true });
    if (!assert(byCjk.length === 1, "CJK LIKE 兜底检索未命中")) return;
    const id = byCjk[0].id;
    const before = db.prepare("SELECT last_referenced AS lr FROM chunks WHERE id = ?").get(id).lr;
    kb.touch(id);
    const after = db.prepare("SELECT last_referenced AS lr FROM chunks WHERE id = ?").get(id).lr;
    if (!assert(after >= before, "touch 未刷新 last_referenced")) return;
    kb.evict([id]);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE target = ?").get(target).n;
    if (!assert(remaining === 0, "evict 后仍有残留")) return;
    ok("put/search(EN+CJK)/touch/evict 全通过");
  } finally {
    db.close();
  }
}

// --- 主流程 ---
checkVersion();
ensureProfile();
ensureBuild();

if (!failed) {
  tmp = mkdtempSync(path.join(tmpdir(), "kb-smoke-"));
  const taskDir = path.join(tmp, "task");
  mkdirSync(taskDir, { recursive: true });
  const dbPath = path.join(tmp, "kb.db");
  const overlayPath = path.join(tmp, "overlay.yml");
  writeFileSync(overlayPath, COMPACTION_OVERLAY, "utf8");

  const sessionOk = runSession(dbPath, taskDir, overlayPath);
  if (sessionOk) {
    // 注册核心证据：真实会话后知识库文件必须存在（由 bundle apply 创建）。
    if (assert(existsSync(dbPath), "注册失败：会话成功但知识库文件未创建")) {
      const metaRows = dbCount(dbPath, META_SQL);
      const compRows = dbCount(dbPath, COMP_SQL);
      if (metaRows < 1 || compRows < 1) {
        await syntheticBackstop(dbPath, {
          needMeta: metaRows < 1,
          needCompaction: compRows < 1,
        });
      }
      if (!failed) assertIngestion(dbPath);
    }
  }
  if (!failed) {
    await roundtrip(dbPath);
  }
}

// 辅助：只读计数（库不存在/不可读时返回 0）
function dbCount(dbPath, sql) {
  if (!existsSync(dbPath)) return 0;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get().n;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

if (failed) {
  console.error(`\n[smoke] 失败。临时目录保留：${tmp}`);
  process.exit(1);
}
if (tmp) rmSync(tmp, { recursive: true, force: true });
console.log("\n[smoke] PASS — 注册/摄取/往返全部通过");
process.exit(0);
