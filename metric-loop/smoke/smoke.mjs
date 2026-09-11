#!/usr/bin/env node
/**
 * 宿主联调 smoke（profile: dsh-metric-loop，对齐 DSH-CTX-API 0.1.5-rc.2）。
 *
 * 流程：
 *   0. 检查宿主 dsh 版本（要求 0.1.5-rc.2）
 *   1. profile dsh-metric-loop 引导（幂等：创建 → 挂载插件 link: → 写用户层配置）
 *   2. 缺 dist 时先构建
 *   3. 真实 dsh headless 连跑三次，每次恰好推进一轮：
 *        R1 start（常量指标 echo 42，window=2）→ 第 1 轮（基线，running）
 *        R2 tick(explicit) → 第 2 轮（无改进 streak=1，running）
 *        R3 tick(explicit) → 第 3 轮（无改进 streak=2 → plateau 停止）
 *   4. 断言状态文件（跨进程持久化 + 一轮循环 + plateau 停止语义）：
 *        每次运行后 rounds 递增；终态 status=stopped / stopReason=plateau /
 *        rounds=3 / best=42 / streak=2，history 三条且首条 improved、后续无改进
 *   5. 断言宿主 stderr 含注册行（bundle apply 真实执行证据）
 *
 * 清理：成功删除临时目录；失败保留（打印路径）供排查。profile 保留（幂等复用）。
 * 退出码 0 = 全部断言通过（PASS）。
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PROFILE = "dsh-metric-loop";
const PROFILE_DIR = path.join(homedir(), ".dsh", "profiles", PROFILE);
const PKG_NAME = "@dsh-toolset/dsh-metric-loop";
const REQUIRED_VERSION = "0.1.5-rc.2";
const LOOP_ID = "smoke";

// profile 用户层配置：stateDir 优先取环境变量（smoke 重定向到临时目录），
// 缺省落 ~/.dsh/metric-loop（dshHomePath 由宿主 !!js 提供）。
const CORDIS_PATCH = `# 本 profile 用户层：metric-loop 插件配置（由 smoke 脚本管理，勿手改）。
# stateDir 优先取 METRIC_LOOP_STATE_DIR 环境变量（smoke 重定向到临时目录），
# 缺省落 ~/.dsh/metric-loop（dshHomePath 由宿主 !!js 提供）。
- id: dsh-metric-loop
  name: '@dsh-toolset/dsh-metric-loop'
  config:
    stateDir: !!js process.env.METRIC_LOOP_STATE_DIR || dshHomePath('metric-loop')
`;

// 三次连跑的 headless 任务：每次恰好调用一次 metric_loop（一轮）。
const START_TASK =
  '只调用一次 metric_loop 工具，参数必须是：{"action":"start","id":"smoke","measureCmd":"echo 42","direction":"min","window":2,"maxRounds":10}。' +
  "禁止调用任何其他工具，禁止修改参数。工具返回后只输出 DONE 结束。";
const TICK_TASK =
  '只调用一次 metric_loop 工具，参数必须是：{"action":"tick","id":"smoke","wake":"explicit"}。' +
  "禁止调用任何其他工具，禁止修改参数。工具返回后只输出 DONE 结束。";

let failed = false;
let tmp = null;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        encoding: "utf8",
        timeout: 300_000,
        maxBuffer: 32 * 1024 * 1024,
        ...opts,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
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

function readState(stateDir) {
  const file = path.join(stateDir, `metric-loop-${LOOP_ID}.json`);
  if (!existsSync(file)) return { file, payload: null, error: "文件缺失" };
  try {
    return {
      file,
      payload: JSON.parse(readFileSync(file, "utf8")),
      error: null,
    };
  } catch (error) {
    return { file, payload: null, error: String(error.message) };
  }
}

// --- 0. 宿主版本 ---
async function checkVersion() {
  step("dsh 版本");
  let version;
  try {
    version = (await run("dsh", ["--version"])).stdout.trim();
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
async function ensureProfile() {
  step(`profile ${PROFILE} 引导`);
  if (!existsSync(path.join(PROFILE_DIR, "package.json"))) {
    try {
      await run("dsh", [
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
      await run("dsh", [
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
async function ensureBuild() {
  step("dist 构建");
  const entry = path.join(PKG_ROOT, "dist", "src", "index.js");
  if (!existsSync(entry)) {
    try {
      await run("npm", ["run", "build"], { cwd: PKG_ROOT });
    } catch (error) {
      fail(`构建失败：${String(error.message).split("\n")[0]}`);
      return;
    }
  }
  if (assert(existsSync(entry), `dist 产物缺失：${entry}`)) ok();
}

// --- 3. 一次 headless 会话（一轮） ---
async function runSession(stateDir, task, tag) {
  step(`headless ${tag}`);
  let result;
  try {
    result = await run("dsh", ["--profile", PROFILE, task], {
      cwd: path.join(tmp, "task"),
      env: {
        ...process.env,
        METRIC_LOOP_STATE_DIR: stateDir,
        DSH_PERMISSION_MODE: "danger-full-access",
      },
    });
  } catch (error) {
    fail(
      `会话未成功退出（API 不可达或宿主异常？）：${String(error.message).split("\n")[0]}；stderr 尾部：${String(error.stderr ?? "").slice(-400)}`,
    );
    return null;
  }
  // 断言宿主 stderr 含注册行（bundle apply 真实执行证据，每次启动均须出现）
  if (
    !assert(
      result.stderr.includes("[dsh-metric-loop] 已注册 metric_loop 工具"),
      `stderr 缺少注册行（bundle apply 未执行？）stderr 尾部：${result.stderr.slice(-300)}`,
    )
  ) {
    return null;
  }
  ok("exit 0 + 注册行");
  return result;
}

// --- 4. 状态文件断言 ---
function assertState(stateDir, tag, expect) {
  step(`断言状态文件 ${tag}`);
  const st = readState(stateDir);
  if (
    !assert(
      st.payload !== null,
      `状态文件不可用：${st.error}（bundle 未 apply 或工具未调用）`,
    )
  )
    return;
  const s = st.payload.state;
  if (
    !assert(st.payload.version === 1, `version=${st.payload.version}，要求 1`)
  )
    return;
  for (const [label, want] of Object.entries(expect)) {
    const parts = label.split(".");
    let got = st.payload; // label 以 "state." 开头
    for (const p of parts) got = got?.[p];
    if (
      !assert(
        got === want,
        `${label}=${JSON.stringify(got)}，要求 ${JSON.stringify(want)}`,
      )
    )
      return;
  }
  if (tag === "R3") {
    const hist = s.history ?? [];
    const values = hist.map((h) => h.value);
    const improved = hist.map((h) => h.improved);
    if (
      !assert(
        hist.length === 3 &&
          values.every((v) => v === 42) &&
          improved[0] === true &&
          improved[1] === false &&
          improved[2] === false,
        `history 异常：${JSON.stringify({ values, improved })}`,
      )
    )
      return;
  }
  ok(tag);
}

// --- 主流程 ---
await checkVersion();
await ensureProfile();
await ensureBuild();

if (!failed) {
  tmp = mkdtempSync(path.join(tmpdir(), "metric-loop-smoke-"));
  const stateDir = path.join(tmp, "state");
  const taskDir = path.join(tmp, "task");
  // 预建目录（task 目录为 headless cwd；state 目录由插件首次落盘时创建）
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  await runSession(stateDir, START_TASK, "R1 start");
  if (!failed) {
    // R1 后：第 1 轮基线，循环 running
    assertState(stateDir, "R1", {
      "state.id": LOOP_ID,
      "state.status": "running",
      "state.rounds": 1,
      "state.best": 42,
      "state.streak": 0,
      "state.stopReason": null,
      "state.history.0.value": 42,
      "state.history.0.improved": true,
    });
  }
  if (!failed) {
    await runSession(stateDir, TICK_TASK, "R2 tick");
    // R2 后：第 2 轮无改进（42 不优于 42），streak=1，仍 running
    assertState(stateDir, "R2", {
      "state.status": "running",
      "state.rounds": 2,
      "state.best": 42,
      "state.streak": 1,
    });
  }
  if (!failed) {
    await runSession(stateDir, TICK_TASK, "R3 tick");
    // R3 后：streak=2 达到 window → plateau 停止
    assertState(stateDir, "R3", {
      "state.status": "stopped",
      "state.stopReason": "plateau",
      "state.rounds": 3,
      "state.best": 42,
      "state.streak": 2,
    });
  }
}

if (failed) {
  console.error(`\n[smoke] 失败。临时目录保留：${tmp}`);
  process.exit(1);
}
if (tmp) rmSync(tmp, { recursive: true, force: true });
console.log("\n[smoke] PASS — headless 连跑一轮循环 + plateau 停止全部通过");
process.exit(0);
