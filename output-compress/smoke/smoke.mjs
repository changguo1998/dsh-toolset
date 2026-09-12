#!/usr/bin/env node
/**
 * output-compress 宿主联调 smoke（profile: dsh-output-compress，对齐 DSH 0.1.5-rc.2）。
 *
 * 流程：
 *   0. 检查宿主 dsh 版本（要求 0.1.5-rc.2）
 *   1. profile dsh-output-compress 引导（幂等：创建 → 双插件 link: → 写用户层配置）
 *   2. 缺 dist 时先构建（output-compress + knowledge-base 双包）
 *   3. 真实 dsh headless 一次性会话：bash cat 大文件（>50KB → 宿主 spill → 触发本插件）
 *   4. 断言：DB 指纹、category='output-compress' chunk、FTS 召回、切片索引定位回原始字节、
 *      chunk 体积上限（≤6000 字符）
 *   5. 真实载荷缺失时经 dist hooks 注入合成事件兜底（仅当会话本身成功）
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
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const KB_ROOT = path.resolve(PKG_ROOT, "..", "knowledge-base");
const PROFILE = "dsh-output-compress";
const PROFILE_DIR = path.join(homedir(), ".dsh", "profiles", PROFILE);
const PKG_NAME_OC = "@dsh-toolset/output-compress";
const PKG_NAME_KB = "@dsh-toolset/knowledge-base";
const REQUIRED_VERSION = "0.1.5-rc.2";
const KNOWLEDGE_APP_ID = 0x4b4e4f57; // knowledge-base schema.ts 'KNOW'
const KNOWLEDGE_SCHEMA_VERSION = 1;
const MARKER = "ERROR output-compress-smoke-marker unique-token-42";
const MARKER_LINE = 1402;

const CORDIS_PATCH = `# 本 profile 用户层：knowledge-base + output-compress 双插件配置（由 smoke 脚本管理，勿手改）。
# 两 bundle 共享同一 dbPath 表达式（!!js 由宿主求值）：
#   优先 KNOWLEDGE_DB_PATH 环境变量（smoke 重定向到临时目录），
#   缺省落 ~/.dsh/knowledge-base/knowledge.db（dshHomePath 由宿主提供）。
- id: knowledge-base
  name: '@dsh-toolset/knowledge-base'
  config:
    dbPath: !!js process.env.KNOWLEDGE_DB_PATH || dshHomePath('knowledge-base/knowledge.db')
    project: 'dsh-output-compress'

- id: output-compress
  name: '@dsh-toolset/output-compress'
  config:
    dbPath: !!js process.env.KNOWLEDGE_DB_PATH || dshHomePath('knowledge-base/knowledge.db')
    project: 'dsh-output-compress'
`;

// 大文件任务提示词：强制模型用 bash cat 完整输出预置大文件（确定性 >50KB → 宿主 spill）
const SESSION_TASK =
  "使用 bash 工具执行命令：cat big-output.txt（必须完整输出该文件内容，不要截断、不要摘要、不要换用其他命令），完成后简短回复 done。不要使用其他工具。";

// 预置大文件：2000 行 × ~33 字符 ≈ 66KB（超宿主 50KB spill 阈值，留裕量）；
// 第 1 行为 markdown 标题（供 sections 断言），第 MARKER_LINE 行为错误标记（供 keyLines/FTS 断言）
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

/** 按 dbPath 打开只读连接并计数（会话后断言用）。 */
function countRows(dbPath, sql) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return queryCount(db, sql);
  } finally {
    db.close();
  }
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
  if (
    assert(
      version.includes(REQUIRED_VERSION),
      `dsh 版本 ${version}，要求 ${REQUIRED_VERSION}`,
    )
  ) {
    ok(version);
  }
}

// --- 1. profile 引导（幂等；双插件 link: 依赖） ---
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
  // 逐个校验并补齐两个 link: 依赖 + bundles 条目
  const wanted = [
    [PKG_NAME_KB, KB_ROOT],
    [PKG_NAME_OC, PKG_ROOT],
  ];
  for (const [name, root] of wanted) {
    let dep, bundles;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      dep = pkg.dependencies?.[name];
      bundles = pkg.dsh?.profile?.bundles ?? [];
    } catch (error) {
      fail(
        `profile package.json 解析失败：${String(error.message).split("\n")[0]}`,
      );
      return;
    }
    if (dep !== `link:${root}` || !bundles.includes(name)) {
      try {
        run("dsh", [
          "plugin",
          "--profile",
          PROFILE,
          "add",
          `${name}@link:${root}`,
        ]);
      } catch (error) {
        fail(
          `插件挂载失败（${name}）：${String(error.message).split("\n")[0]}`,
        );
        return;
      }
    }
  }
  writeFileSync(
    path.join(PROFILE_DIR, "cordis.patch.yml"),
    CORDIS_PATCH,
    "utf8",
  );
  // link: 依赖需安装为 profile node_modules 符号链接（幂等）
  const nmDir = path.join(PROFILE_DIR, "node_modules", "@dsh-toolset");
  if (!existsSync(nmDir)) {
    try {
      run("dsh", ["plugin", "--profile", PROFILE, "install"]);
    } catch (error) {
      fail(`profile 依赖安装失败：${String(error.message).split("\n")[0]}`);
      return;
    }
  }
  ok(PROFILE_DIR);
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
      // 依赖未安装时（link: 包无独立 node_modules）先按 lock 安装（不改动 lock）
      if (!existsSync(path.join(root, "node_modules", ".bin", "tsc"))) {
        try {
          run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: root });
        } catch (error) {
          fail(
            `依赖安装失败（${name}）：${String(error.message).split("\n")[0]}`,
          );
          return;
        }
      }
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
function runSession(dbPath, taskDir) {
  step("真实 dsh headless 会话（bash 大输出 → spill）");
  const bytes = assertFixtureSize();
  if (!failed) {
    writeFileSync(
      path.join(taskDir, "big-output.txt"),
      makeBigFileText(),
      "utf8",
    );
  }
  if (failed) return false;
  try {
    run("dsh", ["--profile", PROFILE, SESSION_TASK], {
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
  ok(`exit 0（fixture ${bytes} 字节）`);
  return true;
}

// --- 4. SQLite 断言（指纹 + oc chunk + FTS 召回 + 切片定位 + 体积上限） ---
function assertIngestion(dbPath) {
  step("断言注册与入库");
  if (
    !assert(
      existsSync(dbPath),
      `知识库文件未创建（bundle 未 apply）：${dbPath}`,
    )
  ) {
    return false;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
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
    const ocRows = queryCount(
      db,
      "SELECT COUNT(*) AS n FROM chunks WHERE category = 'output-compress'",
    );
    if (
      !assert(ocRows >= 1, "未找到 category='output-compress' 的摘要 chunk")
    ) {
      return false;
    }
    // 记录可能被切成多条 chunk 行（按 6000 字符切分），逐 source 重组后选一条满足全部断言的记录
    const slices = db
      .prepare(
        "SELECT source_id, content FROM chunks WHERE category = 'output-compress' ORDER BY source_id, id",
      )
      .all();
    const records = [];
    for (const r of slices) {
      const last = records[records.length - 1];
      if (last !== undefined && last.sourceId === r.source_id)
        last.content += String(r.content);
      else records.push({ sourceId: r.source_id, content: String(r.content) });
    }
    const sliceRe = /- #\d+ L(\d+)-(\d+) C(\d+)-(\d+) fnv=[0-9a-f]+ "[^"]*"/g;
    // 选记录：工具名 bash + 有真实 spill locator + 切片覆盖 marker 行。
    // marker 行号以 spill 文件实测为准：spill 是「完整格式化结果」，但子进程 stdout 捕获上限
    // 会截掉头部，其行号与 fixture 不保证一致（此前按 fixture 行号断言导致误判）。
    let picked = null;
    for (const rec of records) {
      const toolLine = rec.content
        .split("\n")
        .find((l) => l.startsWith("- tool: "));
      if (!(toolLine?.includes("bash") ?? false)) continue;
      const sourceLine = rec.content
        .split("\n")
        .find((l) => l.startsWith("- source: "));
      const locator = sourceLine
        ? sourceLine.slice("- source: ".length).trim()
        : "";
      if (locator === "" || locator.startsWith("inline-event-text")) continue;
      if (!existsSync(locator)) continue;
      const spillLines = readFileSync(locator, "utf8").split("\n");
      const markerLine = spillLines.findIndex((l) => l.trim() === MARKER) + 1;
      if (markerLine === 0) continue;
      let slice = null;
      for (const m of rec.content.matchAll(sliceRe)) {
        const start = Number(m[1]);
        const end = Number(m[2]);
        if (start <= markerLine && markerLine <= end) slice = { start, end };
      }
      if (slice !== null) {
        picked = {
          content: rec.content,
          locator,
          slice,
          markerLine,
          spillLines,
        };
        break;
      }
    }
    if (
      !assert(
        picked !== null,
        `无满足断言的摘要记录（共 ${records.length} 条 oc 记录）；` +
          `工具名/bash 关联、spill locator、覆盖 marker 行的切片需同时成立`,
      )
    ) {
      return false;
    }
    const covering = picked.slice;
    const markerLine = picked.markerLine;
    const spillLines = picked.spillLines;
    // FTS 召回：marker 词必须可检索（porter 短语）
    const ftsHits = queryCount(
      db,
      `SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH '"unique-token-42"'`,
    );
    if (!assert(ftsHits >= 1, "FTS 召回失败：marker 词未命中 chunks_fts"))
      return false;
    // 切片索引定位回原始字节：按已选切片的行区间读 spill 文件（marker 行号实测）
    const rawLine = spillLines[markerLine - 1];
    if (
      !assert(
        rawLine === MARKER,
        `切片行区间 L${covering.start}-${covering.end} 定位的原始行（spill 第 ${markerLine} 行）与 marker 不符：${JSON.stringify(rawLine)}`,
      )
    ) {
      return false;
    }
    // 体积上限：oc chunk 不得超 6000 字符（原始字节不入库）
    const maxLen = db
      .prepare(
        "SELECT MAX(LENGTH(content)) AS n FROM chunks WHERE category = 'output-compress'",
      )
      .get().n;
    if (!assert(maxLen <= 6000, `oc chunk 超体积上限：${maxLen} > 6000`))
      return false;
    ok(
      `指纹 OK；oc chunk ${ocRows} 条（max ${maxLen} 字符）；FTS 命中 ${ftsHits}；切片 L${covering.start}-${covering.end} 定位 marker 成功`,
    );
    return true;
  } finally {
    db.close();
  }
}

// --- 主流程 ---
checkVersion();
ensureProfile();
ensureBuild();

if (!failed) {
  tmp = mkdtempSync(path.join(tmpdir(), "oc-smoke-"));
  const taskDir = path.join(tmp, "task");
  mkdirSync(taskDir, { recursive: true });
  const dbPath = path.join(tmp, "kb.db");

  let sessionOk = runSession(dbPath, taskDir);
  // 模型偶发不调用工具（会话内无 tool/result 事件）：有限重试一次。
  // 不掩盖插件失败——插件有问题则每次会话都不入库，断言依然会失败。
  for (let attempt = 0; sessionOk && !failed && attempt < 2; attempt++) {
    const kbRows = existsSync(dbPath)
      ? countRows(
          dbPath,
          "SELECT COUNT(*) AS n FROM chunks WHERE category = 'tool/result'",
        )
      : 0;
    if (kbRows >= 1) break;
    step("真实 dsh headless 会话重试（模型未调用工具）");
    sessionOk = runSession(dbPath, taskDir);
  }
  if (sessionOk && !failed) {
    // 注册核心证据：真实会话后知识库文件必须存在（由 knowledge-base apply 创建）
    if (assert(existsSync(dbPath), "注册失败：会话成功但知识库文件未创建")) {
      if (!failed) assertIngestion(dbPath);
    }
  }
}

if (failed) {
  console.error(`\n[smoke] 失败。临时目录保留：${tmp}`);
  process.exit(1);
}
if (tmp) rmSync(tmp, { recursive: true, force: true });
console.log("\n[smoke] PASS — 注册/入库/FTS 召回/切片定位全部通过");
process.exit(0);
