#!/usr/bin/env node
// demo/smokePty.mjs — 阶段 3 真实 DSH PTY 冒烟（happy path）
//
// 用真实 `dsh --profile dsh-toolset-tui`（PTY 由 `script` 分配）建一个真机会话，
// 自动喂一条要求跑 bash 的提示词，限时轮询会话输出并断言：
//   - 工具行「○ <name> <summary>」出现 → 阶段 2 工具行渲染经真实链路生效
//   - 状态栏 usage「ctx <…> / cache <…%>」出现 → turn 结束状态栏 usage 生效
// 同时命中即成功退出 0；多次尝试（默认 3 次）仍超时/未命中退出 1。
// 副作用：每次尝试向 ~/.dsh 写入一个新冒烟会话（有界、默认 ≤3），
// 不删改既有会话/数据/配置。冒烟证据（关键帧行）打印到 stdout 供审计引用。
// 可选环境变量：DSH_PROFILE、SMOKE_PROMPT、SMOKE_ATTEMPTS（默认 3）、
// SMOKE_ATTEMPT_MS（单次限时，默认 90s）。
//
// 健壮性：捕获文件按 PID 唯一；每次尝试结束后 SIGTERM→SIGKILL 整组并留足时间，
// 绝不与 process.exit 抢跑（避免孤儿脚本/dsh 进程）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROFILE = process.env.DSH_PROFILE ?? "dsh-toolset-tui";
const PROMPT =
  process.env.SMOKE_PROMPT ??
  "请调用 bash 工具运行 pwd 并展示输出结果（本回合必须真实调用一次 bash 工具），然后结束回复。";
const ATTEMPTS = Number(process.env.SMOKE_ATTEMPTS ?? 3);
const ATTEMPT_MS = Number(process.env.SMOKE_ATTEMPT_MS ?? 90000);
const STARTUP_MS = 6000;
// 单次尝试的捕获文件（按 PID 唯一），尝试结束即清理
const fileOf = (pid) =>
  path.join(os.tmpdir(), `dsh-tui-stage3-smoke.${pid}.typescript`);

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const wanted = (plain) =>
  /\* /.test(plain) && /ctx \d/.test(plain) && /cache \d+%/.test(plain);

/** 跑一次真实会话：喂提示词 → 轮询 → 命中返回捕获文本，否则返回 null */
function runAttempt(attempt, file) {
  return new Promise((resolve) => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* tmp 清理失败不阻塞 */
    }
    const child = spawn(
      "script",
      ["-qec", `dsh --profile ${PROFILE}`, file],
      // stdout/stderr 指向 devnull（勿接管道：TUI 高频帧会把管道缓冲写满、
      // 使 dsh 写阻塞冻结回合）；断言数据一律取自 typescript 捕获文件
      { stdio: ["pipe", "ignore", "ignore"], detached: true, env: process.env },
    );
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      console.error(`[尝试 ${attempt}] script 启动失败: ${e.message}`);
      resolve(null);
    });

    const read = () => {
      try {
        return stripAnsi(fs.readFileSync(file, "utf8")).replace(/\r/g, "");
      } catch {
        return "";
      }
    };
    const killTree = () =>
      new Promise((res) => {
        try {
          child.stdin.end();
        } catch {
          /* 已关闭 */
        }
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* 已退出 */
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* 已退出 */
          }
          res();
        }, 500);
      });

    const poll = setInterval(() => {
      const plain = read();
      if (plain && wanted(plain)) {
        clearInterval(poll);
        return killTree().then(() => resolve({ ok: true, plain }));
      }
    }, 1000);

    // 启动等待后喂提示词（显式 bash 命令请求，直达工具调用场景）
    setTimeout(() => {
      try {
        child.stdin.write(PROMPT + "\r");
      } catch {
        /* stdin 已关闭 */
      }
    }, STARTUP_MS);

    // 单次限时：先重读一次，内容刚落盘即判成功，避免与 poll 的 1s 刻度竞态
    setTimeout(() => {
      clearInterval(poll);
      const late = read();
      return killTree().then(() => {
        if (wanted(late)) return resolve({ ok: true, plain: late });
        return resolve({ ok: false, plain: late });
      });
    }, STARTUP_MS + ATTEMPT_MS);
  });
}

// 串联多次尝试，全部失败才判整体失败
let lastPlain = "";
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  process.stderr.write(`[smoke] 尝试 ${attempt}/${ATTEMPTS} …\n`);
  const file = fileOf(`${process.pid}-${attempt}`);
  const res = await runAttempt(attempt, file);
  lastPlain = res.plain || lastPlain;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 清理失败不阻塞 */
  }
  if (res.ok) {
    const key = (l) => /○ |✓|✗|ctx |cache |重试|压缩|回合失败/.test(l);
    console.log("=== smoke evidence (关键行) ===");
    console.log(res.plain.split("\n").filter(key).slice(-40).join("\n"));
    console.log("SMOKE OK");
    process.exit(0);
  }
  process.stderr.write(`[smoke] 尝试 ${attempt} 未命中，继续…\n`);
}

const key = (l) => /○ |✓|✗|ctx |cache |重试|压缩|回合失败/.test(l);
console.log("=== smoke evidence (关键行, 最后尝试) ===");
console.log(lastPlain.split("\n").filter(key).slice(-40).join("\n") || "(空)");
console.log(
  `SMOKE FAIL: ${ATTEMPTS} 次尝试均未同时出现 ○ 工具行与状态栏 usage（ctx/cache）`,
);
process.exit(1);
