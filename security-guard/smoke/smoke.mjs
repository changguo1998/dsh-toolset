#!/usr/bin/env node
/**
 * 宿主联调 smoke（profile: dsh-security-guard，对齐 DSH-CTX-API 0.1.5-rc.2）。
 *
 * 流程：
 *   0. 检查宿主 dsh 版本（要求 0.1.5-rc.2）
 *   1. profile dsh-security-guard 引导（幂等：创建 → 挂载插件 link: → 写用户层配置，
 *      用户层不写 config，验证默认保守策略）
 *   2. 缺 dist 时先构建
 *   3. 真实 dsh headless 一次性会话（danger-full-access 权限模式：权限层放行，
 *      由本插件独立拦截）依次执行 echo sg-smoke-ok 与 sudo ls /
 *   4. 解压 session.jsonl.zstd（多帧 zstd，用 zstd CLI）断言：
 *      sudo ls / 的工具结果 isError 且回执含 [security-guard]/原因/放行方式；
 *      echo 的结果 isError=false
 *   5. 模型未照原执行 sudo 时兜底：对 dist 引擎直调断言（保守策略仍生效）
 *
 * 清理：成功删除临时目录；失败保留（打印路径）供排查。
 * 退出码 0 = 全部断言通过。
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PROFILE = "dsh-security-guard";
const PROFILE_DIR = path.join(homedir(), ".dsh", "profiles", PROFILE);
const PKG_NAME = "@dsh-toolset/security-guard";
const REQUIRED_VERSION = "0.1.5-rc.2";

// 用户层只声明挂载，不写 config —— 验证默认保守策略（无用户层放行）。
const CORDIS_PATCH = `# 本 profile 用户层：security-guard 插件挂载（由 smoke 脚本管理，勿手改）。
- id: security-guard
  name: '@dsh-toolset/security-guard'
`;

// 会话任务：原样执行两条命令（先安全后危险），失败只记录不改写。
const SESSION_TASK =
  "请使用 bash 工具依次执行以下两条命令，每条单独调用一次 bash，必须原样执行、不要改写、不要解释、不要自行判断安全性：\n" +
  "1. echo sg-smoke-ok\n" +
  "2. sudo ls /\n" +
  "如果某条命令执行失败（包括被安全策略拦截），只需简短记录其错误信息，然后继续执行下一条。最后用一句话总结两条命令的执行结果。";

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
    fail(
      `profile package.json 解析失败：${String(error.message).split("\n")[0]}`,
    );
    return;
  }
  if (dep !== `link:${PKG_ROOT}` || !bundles.includes(PKG_NAME)) {
    try {
      run("dsh", [
        "plugin",
        "--profile",
        PROFILE,
        "add",
        `${PKG_NAME}@link:${PKG_ROOT}`,
      ]);
    } catch (error) {
      fail(`插件挂载失败：${String(error.message).split("\n")[0]}`);
      return;
    }
  }
  writeFileSync(
    path.join(PROFILE_DIR, "cordis.patch.yml"),
    CORDIS_PATCH,
    "utf8",
  );
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
function runSession(taskDir) {
  step("真实 dsh headless 会话");
  try {
    run("dsh", ["--profile", PROFILE, SESSION_TASK], {
      cwd: taskDir,
      env: { ...process.env, DSH_PERMISSION_MODE: "danger-full-access" },
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

/** 收集 ~/.dsh/sessions 下最近的 session.jsonl.zstd（mtime 倒序）。 */
function recentSessionFiles(limit) {
  const root = path.join(homedir(), ".dsh", "sessions");
  if (!existsSync(root)) return [];
  const out = [];
  for (const cwdDir of readdirSync(root)) {
    const dir = path.join(root, cwdDir);
    let sessions;
    try {
      sessions = readdirSync(dir);
    } catch {
      continue;
    }
    for (const sid of sessions) {
      // 会话文件名随版本变化（0.1.5-rc.2 为 session.v3.jsonl.zstd），按通配收集
      let files;
      try {
        files = readdirSync(path.join(dir, sid)).filter((n) =>
          /^session.*\.jsonl\.zstd$/.test(n),
        );
      } catch {
        continue;
      }
      for (const n of files) {
        const f = path.join(dir, sid, n);
        out.push({ file: f, mtime: statSync(f).mtimeMs });
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** zstd CLI 解压（会话文件为多帧 append 式 zstd，Node zlib 无法处理）。 */
function decompress(file) {
  return execFileSync("zstd", ["-dc", file], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 从 jsonl 行中提取 tool/result 载荷（文本 + isError）。 */
function collectToolResults(line) {
  const results = [];
  if (line?.type !== "tool/result") return results;
  const content = line.data?.message?.content;
  if (!Array.isArray(content)) return results;
  for (const entry of content) {
    if (entry?.type !== "tool-result") continue;
    const text = (entry.content ?? []).map((x) => x?.text ?? "").join("\n");
    results.push({ text, isError: Boolean(entry.isError) });
  }
  return results;
}

function parseResults(raw) {
  const results = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      results.push(...collectToolResults(JSON.parse(line)));
    } catch {
      // 非 JSON 行忽略
    }
  }
  return results;
}

// --- 4. 会话断言（真实拦截证据） ---
function assertSession() {
  step("会话拦截断言");
  const candidates = recentSessionFiles(10);
  if (!assert(candidates.length > 0, "未找到任何 session.jsonl.zstd"))
    return false;
  for (const { file } of candidates) {
    let raw;
    try {
      raw = decompress(file);
    } catch {
      continue;
    }
    if (!raw.includes("sg-smoke-ok")) continue; // 非本次 smoke 会话
    const results = parseResults(raw);
    const safe = results.find(
      (r) => r.text.includes("sg-smoke-ok") && r.isError === false,
    );
    if (!assert(Boolean(safe), "echo sg-smoke-ok 未以 isError=false 执行成功"))
      return false;
    const denied = results.find(
      (r) =>
        r.text.includes("[security-guard]") && r.text.includes("sudo ls /"),
    );
    if (!denied) return null; // 模型未照原执行 sudo → 走兜底
    if (
      !assert(
        denied.isError === true,
        "sudo ls / 的工具结果未标记 isError（未拦截？）",
      )
    )
      return false;
    for (const marker of ["原因：", "放行方式", "allowPatterns", "sudo"]) {
      if (!assert(denied.text.includes(marker), `回执缺少「${marker}」`))
        return false;
    }
    ok(`${file}（isError 拦截 + 回执齐备）`);
    return true;
  }
  return null;
}

// --- 5. 引擎直调兜底（模型未照原执行危险命令时） ---
async function engineBackstop() {
  step("引擎直调兜底断言");
  const mod = await import(path.join(PKG_ROOT, "dist", "src", "index.js"));
  const engine = new mod.GuardEngine({ homeDir: homedir() });
  const receipt = engine.inspect("bash", { command: "sudo ls /" });
  if (
    !assert(
      typeof receipt === "string" && receipt.length > 0,
      "引擎对 sudo ls / 未拦截",
    )
  )
    return;
  for (const marker of [
    "[security-guard]",
    "原因：",
    "放行方式",
    "allowPatterns",
  ]) {
    if (!assert(receipt.includes(marker), `回执缺少「${marker}」`)) return;
  }
  const safe = engine.inspect("bash", { command: "echo sg-smoke-ok" });
  if (!assert(safe === null, "引擎误拦安全命令 echo")) return;
  ok("dist 引擎直调：sudo ls / 拦截 + 安全命令放行");
}

// --- 主流程 ---
checkVersion();
ensureProfile();
ensureBuild();

if (!failed) {
  tmp = mkdtempSync(path.join(tmpdir(), "sg-smoke-"));
  const taskDir = path.join(tmp, "task");
  mkdirSync(taskDir, { recursive: true });
  const sessionOk = runSession(taskDir);
  if (sessionOk) {
    const sessionResult = assertSession();
    if (sessionResult === null) await engineBackstop();
  }
}

if (failed) {
  console.error(`\n[smoke] 失败。临时目录保留：${tmp}`);
  process.exit(1);
}
if (tmp) rmSync(tmp, { recursive: true, force: true });
console.log("\n[smoke] PASS — 真实会话拦截验证通过");
process.exit(0);
