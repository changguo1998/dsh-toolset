#!/usr/bin/env node
/**
 * 宿主联调 smoke（独立 profile: dsh-goal-contract，对齐 DSH-CTX-API 0.1.5-rc.2）。
 *
 * 验证「draft → goal drop → clause readback」链路：
 *   0. 检查宿主 dsh 版本（要求 0.1.5-rc.2）
 *   1. profile dsh-goal-contract 引导（幂等：headless 默认 profile 创建 →
 *      挂载本插件 link: → 同挂 task-engine link:）
 *   2. 缺 dist 时先构建（本包 + task-engine，含 task-engine 依赖安装）
 *   3. 真实 dsh headless 一次性会话：模型全量预填调用 goal_contract_draft
 *      （非交互路径），工具经 ctx.goals.create 落 dsh-goal 事件源（goal/change）
 *   4. 断言：goal 创建（SMOKE_GOAL_ID=goal-*）+ 条款回读往返一致（SMOKE_MATCH=true）
 *
 * 断言证据源 = 会话 stdout + 本次运行产生的会话日志（zstd 解压后全文匹配）。
 * 模型把标记行放在中途消息还是最终消息不确定，会话日志覆盖全部消息，保证确定性；
 * 仅采信 runStartMs 之后写入的日志，避免重跑时被历史会话掩盖。
 *
 * 说明：headless 无 UI answerer，ctx.userQuestions.ask 会 NO_PROVIDER，
 * 故 smoke 走「objective+clauses 全量预填」非交互路径（访谈路径由单测覆盖）。
 * goal 回合经 max_goal_rounds=2 有界，且要求模型创建后立即 complete。
 *
 * 清理：成功删除临时目录；失败保留（打印路径）供排查。
 * 退出码 0 = 全部断言通过。
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TASK_ENGINE_ROOT = path.resolve(PKG_ROOT, "..", "task-engine");
const PKG_NAME = "@dsh-toolset/dsh-goal-contract";
const TASK_ENGINE_NAME = "@dsh-toolset/dsh-task-engine";
const PROFILE = "dsh-goal-contract";
const PROFILE_PKG = path.join(
  homedir(),
  ".dsh",
  "profiles",
  PROFILE,
  "package.json",
);
const REQUIRED_VERSION = "0.1.5-rc.2";

// 一次性会话任务：全量预填（非交互）→ 落 goal → 输出回读标记 → complete 收尾
const SESSION_TASK = [
  "请使用 goal_contract_draft 工具创建 goal 契约，参数必须完整预填（不要发起访谈提问）：",
  'objective 为 "goal-contract smoke 验证"；',
  'clauses 为 [{"id":"c1","check":"package.json 存在","level":"mechanical","command":"test -f package.json"},{"id":"c2","check":"人工确认","level":"human"}]；',
  "max_goal_rounds 为 2。",
  "工具返回后，先输出一行 SMOKE_GOAL_ID=<goal.id> SMOKE_MATCH=<readback.match>",
  "（<goal.id> 与 <readback.match> 逐字取自工具结果），",
  "然后调用 update_goal 工具以 action=complete 结束该 goal。除上述工具外不要做其他事。",
].join("\n");

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

function fail(message) {
  console.error(`SMOKE_FAIL: ${message}`);
  if (tmp !== null && existsSync(tmp)) {
    console.error(`临时目录保留: ${tmp}`);
  }
  process.exit(1);
}

// 0) 宿主版本检查
const version = run("dsh", ["--version"]).trim();
if (!version.includes(REQUIRED_VERSION)) {
  fail(`dsh 版本不符（需要 ${REQUIRED_VERSION}，实际 ${version}）`);
}

// 1) 独立 profile 引导（幂等）：headless 默认 profile 创建 + 双插件挂载
if (!existsSync(PROFILE_PKG)) {
  run("dsh", [
    "--profile",
    PROFILE,
    "--from-default-profile",
    "headless",
    "--dump-config",
  ]);
}
run("dsh", [
  "plugin",
  "--profile",
  PROFILE,
  "add",
  `${PKG_NAME}@link:${PKG_ROOT}`,
]);
run("dsh", [
  "plugin",
  "--profile",
  PROFILE,
  "add",
  `${TASK_ENGINE_NAME}@link:${TASK_ENGINE_ROOT}`,
]);

// 2) 缺 dist 时先构建（task-engine 需先装依赖：worktree 初始无 node_modules）
if (!existsSync(path.join(TASK_ENGINE_ROOT, "node_modules"))) {
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: TASK_ENGINE_ROOT,
  });
}
if (!existsSync(path.join(TASK_ENGINE_ROOT, "dist", "index.js"))) {
  run("npm", ["run", "build"], { cwd: TASK_ENGINE_ROOT });
}
if (!existsSync(path.join(PKG_ROOT, "dist", "src", "index.js"))) {
  run("npm", ["run", "build"], { cwd: PKG_ROOT });
}

// 3) 真实 headless 一次性会话（草稿 → 落 goal → 条款回读）
tmp = mkdtempSync(path.join(tmpdir(), "goal-contract-smoke-"));
const runStartMs = Date.now();
let out;
try {
  out = run("dsh", ["--profile", PROFILE, SESSION_TASK], { cwd: tmp });
} catch (err) {
  const detail = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}\n${String(err)}`;
  fail(`dsh 会话执行失败:\n${detail.slice(-4000)}`);
}

// 4) 断言：goal 已创建（官方事件源落盘后回读视图可取 id）且条款往返一致
//    证据 = stdout + 本次运行产生的会话日志（~/.dsh/sessions/--<cwd 去首斜杠、
//    斜杠转中划线>--/session-*.v3.jsonl.zstd；zstd -dc 解压）
let evidence = out;
const sessionDir = path.join(
  homedir(),
  ".dsh",
  "sessions",
  `--${tmp.replace(/^\//, "").replace(/\//g, "-")}`,
  `--`,
);
if (existsSync(sessionDir)) {
  // 会话日志实际位于 sessionDir/session-<uuid>/session.v3.jsonl.zstd（嵌套一层）
  const scan = [
    sessionDir,
    ...readdirSync(sessionDir).map((entry) => path.join(sessionDir, entry)),
  ];
  for (const dir of scan) {
    let entries = [];
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".zstd")) continue;
      const file = path.join(dir, entry);
      // 仅采信本次运行之后写入的日志，避免重跑时被历史会话掩盖
      try {
        if (statSync(file).mtimeMs < runStartMs) continue;
        evidence += "\n" + run("zstd", ["-dc", file]);
      } catch {
        // 日志读取/解压失败不阻断：stdout 证据仍参与断言
      }
    }
  }
}
if (!/SMOKE_GOAL_ID=goal-[A-Za-z0-9-]+/.test(evidence)) {
  fail(`证据中缺少 SMOKE_GOAL_ID=goal-*（goal 未创建）：\n${out.slice(-4000)}`);
}
if (!/SMOKE_MATCH=true/.test(evidence)) {
  fail(`条款回读不一致（SMOKE_MATCH 非 true）：\n${out.slice(-4000)}`);
}

// 清理
rmSync(tmp, { recursive: true, force: true });
tmp = null;
console.log("SMOKE_PASS: goal-contract draft → goal drop → clause readback");
