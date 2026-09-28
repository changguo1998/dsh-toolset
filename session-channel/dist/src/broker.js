// src/broker.ts — 消息与在线状态的 Redis 操作层（纯函数式：入参 client，无内部状态）。
//
// 键位见 `keys.ts`；语义约定：
//  - 在线 = 在线键存在（TTL 内）且 pid 存活（本机快检）；崩溃残留由懒 GC 删除；
//  - 发送 = 目标唯一命中 → XADD 入邮箱流 → 可选等待回执键；
//  - 收件 = XREVRANGE（新→旧，只读视图）/ XREAD（阻塞读新消息，reader 连接专用）。
import { ACK_TTL_SEC, DEFAULT_MAX_TEXT_BYTES, MAX_STREAM_LEN, POLL_INTERVAL_MS, } from "./constants.js";
import { ackKey, ALIVE_PATTERN, aliveKey, inboxKey, sessionIdFromAliveKey, } from "./keys.js";
import { SessionChannelError, } from "./types.js";
/** 心跳/在线：写入（或刷新）本会话的在线键。 */
export async function announcePresence(client, peer, ttlSec) {
    await client.set(aliveKey(peer.sessionId), JSON.stringify(peer), {
        EX: ttlSec,
    });
}
/** 优雅退出：删除本会话在线键（崩溃时靠 TTL + 懒 GC）。 */
export async function clearPresence(client, sessionId) {
    await client.del(aliveKey(sessionId));
}
/** 列出在线对端；顺带懒清理「pid 已死」的残留键。 */
export async function listPeers(client) {
    const peers = [];
    for await (const keys of client.scanIterator({ MATCH: ALIVE_PATTERN })) {
        for (const key of keys) {
            const raw = await client.get(key);
            const peer = parsePeer(raw);
            if (peer === undefined) {
                await client.del(key);
                continue;
            }
            if (!isProcessAlive(peer.pid)) {
                await client.del(key);
                continue;
            }
            peers.push(peer);
        }
    }
    return peers.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
/** 解析寻址目标：会话 id 精确匹配，或 `cwd:<路径>` 前缀匹配。 */
export async function resolveTarget(client, to) {
    const peers = await listPeers(client);
    if (to.startsWith("cwd:")) {
        const want = normalizeDir(to.slice("cwd:".length));
        return peers.filter((p) => normalizeDir(p.cwd) === want);
    }
    return peers.filter((p) => p.sessionId === to);
}
/**
 * 发送：解析目标（须唯一命中）→ XADD 入邮箱流 → 可选等待回执。
 * 失败的稳定错误码：`target_offline`（无命中）、`target_ambiguous`（多命中）、`text_too_large`。
 */
export async function sendMessage(client, req, opts = {}) {
    const text = req.text;
    const maxBytes = opts.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
        throw new SessionChannelError("text_too_large", `正文超过上限（${maxBytes} 字节）`);
    }
    const targets = await resolveTarget(client, req.to);
    if (targets.length === 0) {
        throw new SessionChannelError("target_offline", `目标不在线：${req.to}（在线对端见 session-channel peers）`);
    }
    if (targets.length > 1) {
        throw new SessionChannelError("target_ambiguous", `目标命中多个会话（${targets.length}）：${targets.map((t) => t.sessionId).join(", ")}`);
    }
    const target = targets[0];
    const from = req.from ?? "";
    const fromCwd = await cwdOf(client, from);
    const messageId = String(await client.xAdd(inboxKey(target.sessionId), "*", { id: "pending", from, fromCwd, text, ts: String(Date.now()) }, {
        TRIM: {
            strategy: "MAXLEN",
            strategyModifier: "~",
            threshold: MAX_STREAM_LEN,
        },
    }));
    const waitMs = req.waitMs ?? 0;
    const delivered = waitMs > 0 ? await waitForAck(client, messageId, waitMs) : undefined;
    return { ok: true, messageId, delivered, target };
}
/** 收件箱只读视图（新→旧，最多 count 条）。 */
export async function readInbox(client, sessionId, count) {
    const reply = (await client.xRevRange(inboxKey(sessionId), "+", "-", {
        COUNT: count,
    }));
    return reply.map((entry) => toInboxMessage(String(entry.id), entry.message));
}
/** 阻塞读：等待任意一个已知会话的新消息（reader 连接专用）。返回 null = 等待超时无消息。 */
export async function readNew(client, streams, blockMs) {
    if (streams.length === 0)
        return null;
    const reply = (await client.xRead(streams, { BLOCK: blockMs, COUNT: 20 }));
    if (reply === null)
        return null;
    return reply.map((stream) => ({
        name: String(stream.name),
        messages: stream.messages.map((m) => toInboxMessage(String(m.id), m.message)),
    }));
}
/** 写入回执键（接收方注入成功后调用）。 */
export async function ackMessage(client, messageId, ttlSec = ACK_TTL_SEC) {
    await client.set(ackKey(messageId), "injected", { EX: ttlSec });
}
/** 该消息是否已写回执（接收方重启后跳过已投递消息用）。 */
export async function isAcked(client, messageId) {
    return (await client.get(ackKey(messageId))) === "injected";
}
/** 等待回执（发送方可选；轮询间隔 100ms）。 */
export async function waitForAck(client, messageId, waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const value = await client.get(ackKey(messageId));
        if (value === "injected")
            return true;
        if (Date.now() >= deadline)
            return false;
        await sleep(POLL_INTERVAL_MS);
    }
}
/** 流条目 → 收件箱条目。 */
function toInboxMessage(id, fields) {
    return {
        id,
        from: fields["from"] ?? "",
        fromCwd: fields["fromCwd"] ?? "",
        text: fields["text"] ?? "",
        ts: Number.parseInt(fields["ts"] ?? "0", 10) || 0,
    };
}
/** 在线键值 → PeerInfo（形状不符返回 undefined，调用方清除该键）。 */
export function parsePeer(raw) {
    if (raw === null)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== "object")
        return undefined;
    const p = parsed;
    const sessionId = typeof p["sessionId"] === "string" ? p["sessionId"] : "";
    const pid = typeof p["pid"] === "number" ? p["pid"] : Number.NaN;
    if (sessionId === "" || !Number.isInteger(pid))
        return undefined;
    return {
        sessionId,
        pid,
        instanceId: typeof p["instanceId"] === "string" ? p["instanceId"] : "",
        cwd: typeof p["cwd"] === "string" ? p["cwd"] : "",
        profile: typeof p["profile"] === "string" ? p["profile"] : "",
        startedAt: typeof p["startedAt"] === "number" ? p["startedAt"] : 0,
    };
}
/** pid 存活快检（EPERM 视为存活：进程存在但无权限）。 */
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
/** 目录归一（去尾部斜杠；空串原样）。 */
export function normalizeDir(dir) {
    if (dir === "")
        return "";
    return dir.length > 1 && dir.endsWith("/") ? dir.replace(/\/+$/, "") : dir;
}
/** 从任意会话的在线键取 cwd（发送方不在线时为空串）。 */
export async function cwdOf(client, sessionId) {
    if (sessionId === "")
        return "";
    const peer = parsePeer(await client.get(aliveKey(sessionId)));
    return peer?.cwd ?? "";
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=broker.js.map