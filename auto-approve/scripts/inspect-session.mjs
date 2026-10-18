#!/usr/bin/env node
/**
 * auto-approve 只读巡检：从会话日志 + 本包会话审计还原「哪些调用被自动放行、命中哪条规则」。
 *
 * 数据源（都不写）：
 *   - `<会话目录>/session.v4.jsonl[.zstd]`：宿主 `approval/asked {id, toolName, callId?, reason?}`
 *     与 `approval/decided {id, outcome}` 会话审计对；
 *   - `<会话目录>/auto-approve-audit.jsonl`：本包逐次裁定行（`callId` / `toolName` /
 *     `outcome` / `source` / `ruleId` / `mode` / `risk` / `fingerprintHash`，不含参数原文）。
 *
 * 用法：
 *   node scripts/inspect-session.mjs --session <会话 id> [--json] [--limit N]
 *   node scripts/inspect-session.mjs --dir <会话目录> [--json]
 *   node scripts/inspect-session.mjs --file <session.v4.jsonl[.zstd]> [--json]
 *
 * 退出码：0 = 正常（无审批事件也返回 0）；2 = 用法 / 数据源错误。
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import path from "node:path";

const AUDIT_FILE = "auto-approve-audit.jsonl";
const SESSION_LOGS = ["session.v4.jsonl.zstd", "session.v4.jsonl"];

function usage(code = 2, msg) {
  if (msg) console.error(`inspect-session: ${msg}`);
  console.error(
    "usage: node scripts/inspect-session.mjs (--session <id> | --dir <会话目录> | --file <会话日志>) [--json] [--limit N]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const out = { json: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--session") out.session = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i] ?? 0);
    else if (a === "--help" || a === "-h") usage(0);
    else usage(2, `未知参数 ${a}`);
  }
  return out;
}

/** 按会话 id 在 `$DSH_HOME/sessions` 下定位会话目录（宿主目录编码对调用方不透明）。 */
function findSessionDir(sessionId, home) {
  const root = path.join(home, "sessions");
  if (!existsSync(root)) return null;
  const hits = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(root, project.name, sessionId);
    if (existsSync(candidate)) hits.push(candidate);
  }
  return hits[0] ?? null;
}

/** 读会话日志：多帧 zstd 用 `zstd -dc`（Node zstd 只解首帧），退化为单帧解码。 */
function readSessionLog(file) {
  const raw = readFileSync(file);
  if (!file.endsWith(".zstd")) return raw.toString("utf8");
  try {
    return execFileSync("zstd", ["-dc", file], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    // 无 zstd CLI：只解首帧并在 stderr 提示（多帧日志会缺事件）
    console.error(
      "inspect-session: 无 zstd CLI，只解首帧（若为多帧日志请安装 zstd）",
    );
    return zstdDecompressSync(raw).toString("utf8");
  }
}

function readAudit(dir) {
  const file = path.join(dir, AUDIT_FILE);
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line);
      if (row.truncated === true) continue; // 截断 marker
      rows.push(row);
    } catch {
      // 坏行忽略（只读巡检不因单行损坏失败）
    }
  }
  return rows;
}

/** 抽取 approval/asked + approval/decided 对（按事件 id 关联）。 */
function readApprovals(text) {
  const asked = new Map();
  const decided = new Map();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "approval/asked") {
      asked.set(event.data?.id, {
        id: event.data?.id,
        toolName: event.data?.toolName,
        callId: event.data?.callId,
        reason: event.data?.reason,
        time: event.time,
      });
    } else if (event.type === "approval/decided") {
      decided.set(event.data?.id, {
        id: event.data?.id,
        outcome: event.data?.outcome,
        time: event.time,
      });
    }
  }
  const rows = [];
  for (const [id, ask] of asked) {
    const dec = decided.get(id);
    rows.push({
      id,
      toolName: ask.toolName,
      callId: ask.callId,
      askedAt: ask.time,
      decidedAt: dec?.time,
      outcome: dec?.outcome,
    });
  }
  return rows.sort((a, b) => (a.askedAt ?? 0) - (b.askedAt ?? 0));
}

function stamp(ms) {
  if (typeof ms !== "number") return "-";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = process.env.DSH_HOME ?? path.join(homedir(), ".dsh");
  let dir = args.dir;
  let logFile = args.file;
  if (args.session) {
    const found = findSessionDir(args.session, home);
    if (found === null) usage(2, `在 ${path.join(home, "sessions")} 下找不到会话 ${args.session}`);
    dir = found;
  }
  if (dir !== undefined) {
    if (!existsSync(dir)) usage(2, `会话目录不存在：${dir}`);
    logFile = SESSION_LOGS.map((n) => path.join(dir, n)).find((p) =>
      existsSync(p),
    );
    if (logFile === undefined) usage(2, `会话目录无 ${SESSION_LOGS.join(" / ")}：${dir}`);
  }
  if (logFile === undefined) usage(2, "缺 --session / --dir / --file");
  if (!existsSync(logFile)) usage(2, `日志不存在：${logFile}`);
  if (statSync(logFile).size === 0) usage(2, `日志为空：${logFile}`);

  const approvals = readApprovals(readSessionLog(logFile));
  const audit = dir === undefined ? [] : readAudit(dir);
  const auditByCall = new Map();
  for (const row of audit) {
    if (typeof row.callId === "string") auditByCall.set(row.callId, row);
  }
  const rows = approvals.map((a) => {
    const hit = a.callId === undefined ? undefined : auditByCall.get(a.callId);
    return {
      ...a,
      decision: a.outcome ?? "pending",
      auto: hit !== undefined,
      mode: hit?.mode,
      source: hit?.source,
      ruleId: hit?.ruleId,
      risk: hit?.risk,
      fingerprintHash: hit?.fingerprintHash,
      auditAt: hit?.t,
    };
  });
  const limited = args.limit > 0 ? rows.slice(-args.limit) : rows;
  const autoRows = rows.filter((r) => r.auto);
  const unmatched = audit.filter(
    (r) => typeof r.callId === "string" && !approvals.some((a) => a.callId === r.callId),
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          session: path.basename(path.dirname(logFile)),
          dir: dir ?? null,
          approvals: rows.length,
          auto: autoRows.length,
          manual: rows.length - autoRows.length,
          unmatchedAuditRows: unmatched.length,
          rows: limited,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`会话 ${path.basename(path.dirname(logFile))}`);
  console.log(
    `审批对 ${rows.length} 条（自动 ${autoRows.length} / 人工 ${rows.length - autoRows.length}）；审计行 ${audit.length} 条（未配对 ${unmatched.length}）`,
  );
  if (limited.length === 0) {
    console.log("（本会话无 approval/asked 事件）");
    return;
  }
  console.log("");
  console.log("时间                 工具              裁定        来源 / 规则                       callId");
  for (const r of limited) {
    const origin = r.auto
      ? `${r.source ?? "?"}${r.ruleId === undefined ? "" : ` / ${r.ruleId}`}`
      : "人工面板";
    console.log(
      [
        stamp(r.decidedAt ?? r.askedAt),
        String(r.toolName ?? "?").slice(0, 16).padEnd(16),
        String(r.decision).padEnd(11),
        origin.slice(0, 32).padEnd(32),
        r.callId ?? "-",
      ].join(" "),
    );
  }
  const pending = rows.filter((r) => r.outcome === undefined);
  if (pending.length > 0) console.log(`\n另有 ${pending.length} 条 pending（无 decided）`);
}

main();
