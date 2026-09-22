// tests/session-delete.test.ts — 历史会话清理（删除单条 + 清理当前项目空会话）
//
// 三层覆盖：
// 1) 文件级安全（真实临时目录）：只删目标会话目录、符号链接逃逸被拒、非法 id / 未找到无副作用
// 2) 纯状态机与选择器：二次确认迁移、删除后记录与索引收敛、空会话范围（当前项目 + persisted + 无用户消息）
// 3) 面板交互流（App + 最小 fake adapter）：d→y 删除、x→y 清理范围、护栏提示、/session clean 直达确认

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteSessionDir,
  isSafeSessionId,
  sessionRoots,
} from "../src/app/adapter/dsh.ts";
import {
  cleanableSessionIds,
  currentProjectCwd,
  historyVisibleRecords,
  initialState,
  reduceState,
  startupCleanableIds,
} from "../src/app/state.ts";
import type { AppState } from "../src/app/state.ts";
import { App } from "../src/app/index.ts";
import type {
  DshAdapter,
  DshEvent,
  SessionDeleteResult,
  SessionInfo,
} from "../src/app/adapter/dsh.ts";
import type { KeyEvent, Renderer } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

import { flushApp, registerApp } from "./helpers/paintFlush.ts";
// ---------------------------------------------------------------------------
// 1) 文件级删除安全（真实临时目录）
// ---------------------------------------------------------------------------

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "dsh-tui-session-"));
}

/** 在 root/<slug>/<id> 造一个会话目录（含一个落盘文件），返回目录路径 */
function makeSession(root: string, slug: string, id: string): string {
  const dir = join(root, slug, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.v3.jsonl.zstd"), `payload:${id}`);
  return dir;
}

test("deleteSessionDir：只删除目标会话目录（同 slug 其他会话、其他 slug 都不动）", () => {
  const root = makeRoot();
  try {
    const target = makeSession(root, "proj-a", "tui-aaaa1111");
    const sibling = makeSession(root, "proj-a", "tui-bbbb2222");
    const res = deleteSessionDir("tui-aaaa1111", [root]);
    assert.equal(res.ok, true, "命中目标会话目录");
    assert.equal(existsSync(target), false, "目标目录已删除");
    assert.equal(existsSync(sibling), true, "同 slug 其他会话保留");
    assert.equal(
      readFileSync(join(sibling, "session.v3.jsonl.zstd"), "utf8"),
      "payload:tui-bbbb2222",
      "保留会话内容未被触碰",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleteSessionDir：符号链接逃逸被拒绝（根外内容不被删除）", () => {
  const base = makeRoot();
  const root = join(base, "sessions");
  const outside = join(base, "outside");
  try {
    mkdirSync(join(outside, "real-session"), { recursive: true });
    writeFileSync(join(outside, "real-session", "keep.txt"), "keep");
    mkdirSync(join(root, "proj-a"), { recursive: true });
    // 会话目录是指向根外的符号链接：realpath 解析后越界 → 必须拒绝
    symlinkSync(
      join(outside, "real-session"),
      join(root, "proj-a", "tui-esc0001"),
    );
    const res = deleteSessionDir("tui-esc0001", [root]);
    assert.equal(res.ok, false, "越界目标被拒绝");
    assert.equal(existsSync(join(outside, "real-session", "keep.txt")), true);
    assert.equal(
      readFileSync(join(outside, "real-session", "keep.txt"), "utf8"),
      "keep",
      "根外文件完好",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deleteSessionDir：非法 id 与未找到均失败且无副作用", () => {
  const root = makeRoot();
  try {
    const keep = makeSession(root, "proj-a", "tui-keep0001");
    for (const bad of [
      "",
      ".",
      "..",
      "../escape",
      "a/b",
      "a\\b",
      "a.b",
      "x".repeat(129),
    ]) {
      assert.equal(isSafeSessionId(bad), false, `id 白名单拒绝：${bad}`);
      const res = deleteSessionDir(bad, [root]);
      assert.equal(res.ok, false, `拒绝删除：${bad}`);
    }
    const missing = deleteSessionDir("tui-none9999", [root]);
    assert.equal(missing.ok, false, "未找到 → 失败");
    assert.equal(existsSync(keep), true, "无副作用：既有会话目录保留");
    assert.equal(
      readFileSync(join(keep, "session.v3.jsonl.zstd"), "utf8"),
      "payload:tui-keep0001",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleteSessionDir：按根顺序查找（首个命中根生效）", () => {
  const rootA = makeRoot();
  const rootB = makeRoot();
  try {
    const inB = makeSession(rootB, "proj-b", "tui-inrootb1");
    const res = deleteSessionDir("tui-inrootb1", [rootA, rootB]);
    assert.equal(res.ok, true);
    assert.equal(existsSync(inB), false, "第二个根命中并删除");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("sessionRoots：顺序同官方（override → DSH_HOME/sessions → ~/.dsh-tui/sessions）并去重", () => {
  const env = (v: Record<string, string>) => v as NodeJS.ProcessEnv;
  assert.deepEqual(
    sessionRoots(
      env({ DSH_TUI_SESSION_ROOT: "/tmp/sr", DSH_HOME: "/h/.dsh" }),
      "/h",
    ),
    ["/tmp/sr", "/h/.dsh/sessions", "/h/.dsh-tui/sessions"],
  );
  assert.deepEqual(sessionRoots(env({}), "/h"), [
    "/h/.dsh/sessions",
    "/h/.dsh-tui/sessions",
  ]);
  // 空白 override 视为未设置；与默认根重复时去重
  assert.deepEqual(
    sessionRoots(env({ DSH_TUI_SESSION_ROOT: "   ", DSH_HOME: " " }), "/h"),
    ["/h/.dsh/sessions", "/h/.dsh-tui/sessions"],
  );
  assert.deepEqual(
    sessionRoots(
      env({ DSH_TUI_SESSION_ROOT: "/h/.dsh/sessions", DSH_HOME: "/h/.dsh" }),
      "/h",
    ),
    ["/h/.dsh/sessions", "/h/.dsh-tui/sessions"],
  );
});

// ---------------------------------------------------------------------------
// 2) 纯状态机与选择器
// ---------------------------------------------------------------------------

function rec(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    createdAt: 1_700_000_000_000,
    live: false,
    persisted: true,
    ...over,
  };
}

function panelState(records: SessionInfo[]): AppState {
  let s = reduceState(initialState(), { type: "history-open" });
  s = reduceState(s, { type: "history-list", records });
  return s;
}

test("面板：list → confirm-delete（记住目标）→ cancel 回 list；不可删项不进入确认", () => {
  // 当前目录范围：需有 current 记录（否则项目不可解析 → 可见列表为空）
  const cur = rec({ id: "cur", live: true, current: true, cwd: "/proj" });
  const records = [
    cur,
    rec({ id: "s1", cwd: "/proj" }),
    rec({ id: "s2", cwd: "/proj" }),
  ];
  let s = panelState(records);
  s = reduceState(s, { type: "history-move", delta: 1 }); // 高亮 s1（cur 不可删）
  s = reduceState(s, { type: "history-confirm-delete" });
  assert.equal(s.history?.phase, "confirm-delete");
  assert.equal(s.history?.pendingDelete, "s1");
  s = reduceState(s, { type: "history-confirm-cancel" });
  assert.equal(s.history?.phase, "list");
  assert.equal(s.history?.pendingDelete, undefined);

  // 当前活跃 / live / 未持久化 → 不入确认（由调用方 notice 说明）
  const blocked: SessionInfo[][] = [
    [cur], // 高亮即当前活跃
    [cur, rec({ id: "liv", live: true, cwd: "/proj" })],
    [cur, rec({ id: "mem", persisted: false, cwd: "/proj" })],
  ];
  const targets = ["cur", "liv", "mem"];
  blocked.forEach((rs, i) => {
    let st = panelState(rs);
    if (i > 0) st = reduceState(st, { type: "history-move", delta: 1 });
    st = reduceState(st, { type: "history-confirm-delete" });
    assert.equal(st.history?.phase, "list", `不入确认：${targets[i]}`);
    assert.equal(st.history?.pendingDelete, undefined);
  });
});

test("面板：deleting → delete-done 移除记录并收敛高亮索引", () => {
  const cur = rec({ id: "cur", live: true, current: true, cwd: "/proj" });
  const records = [
    cur,
    rec({ id: "s1", cwd: "/proj" }),
    rec({ id: "s2", cwd: "/proj" }),
    rec({ id: "s3", cwd: "/proj" }),
  ];
  let s = panelState(records);
  s = reduceState(s, { type: "history-move", delta: 3 }); // 高亮末行 s3
  assert.equal(s.history?.index, 3);
  s = reduceState(s, { type: "history-confirm-delete" });
  s = reduceState(s, { type: "history-delete" });
  assert.equal(s.history?.phase, "deleting");
  s = reduceState(s, { type: "history-delete-done", ids: ["s3"] });
  assert.equal(s.history?.phase, "list");
  assert.deepEqual(
    s.history?.records.map((r) => r.id),
    ["cur", "s1", "s2"],
  );
  assert.equal(s.history?.index, 2, "索引收敛到末行");
  assert.equal(s.history?.pendingDelete, undefined);

  // ids=[]（adapter 全部拒绝/异常）→ 记录保留，仍回列表
  let f = panelState(records);
  f = reduceState(f, { type: "history-move", delta: 1 });
  f = reduceState(f, { type: "history-confirm-delete" });
  f = reduceState(f, { type: "history-delete" });
  f = reduceState(f, { type: "history-delete-done", ids: [] });
  assert.equal(f.history?.records.length, 4, "失败不动列表");
  assert.equal(f.history?.phase, "list");
});

test("面板：Space 标记/取消（自动下移）+ a 全选替换 + c 清空；不可删项不标记", () => {
  const cur = rec({ id: "cur", live: true, current: true, cwd: "/proj" });
  const records = [
    cur,
    rec({ id: "s1", cwd: "/proj", title: "第一条" }),
    rec({ id: "s2", cwd: "/proj", title: "第二条" }),
    rec({ id: "mem", persisted: false, cwd: "/proj" }),
    rec({ id: "liv", live: true, cwd: "/proj" }),
    rec({ id: "other", cwd: "/other" }),
  ];
  let s = panelState(records);

  // 高亮首行=当前活跃 → Space 不标记不移动
  s = reduceState(s, { type: "history-mark-toggle" });
  assert.equal(s.history?.marked, undefined, "当前活跃不可标记");

  s = reduceState(s, { type: "history-move", delta: 1 }); // s1
  s = reduceState(s, { type: "history-mark-toggle" });
  assert.deepEqual(s.history?.marked, ["s1"], "标记后记录 id");
  assert.equal(s.history?.index, 2, "标记后高亮自动下移一行");

  // 再标记 s2 → [s1, s2]；mem（未持久化）/liv（live）不接受标记
  s = reduceState(s, { type: "history-mark-toggle" });
  assert.deepEqual(s.history?.marked, ["s1", "s2"]);
  s = reduceState(s, { type: "history-mark-toggle" }); // 高亮 mem
  assert.deepEqual(s.history?.marked, ["s1", "s2"], "未持久化不可标记");
  s = reduceState(s, { type: "history-move", delta: 1 }); // liv
  s = reduceState(s, { type: "history-mark-toggle" });
  assert.deepEqual(s.history?.marked, ["s1", "s2"], "live 不可标记");

  // 再按 Space（当前 s2）→ 取消标记
  s = reduceState(s, { type: "history-move", delta: -2 }); // 回 s2（index 2）
  s = reduceState(s, { type: "history-mark-toggle" });
  assert.deepEqual(s.history?.marked, ["s1"], "再按 Space 取消标记");

  // a：全选当前范围可删项（替换标记集；cur/mem/liv/other 均不计）
  s = reduceState(s, { type: "history-mark-all" });
  assert.deepEqual(
    s.history?.marked,
    ["s1", "s2"],
    "a 全选=当前范围可删项（替换已有标记）",
  );

  // 跨范围切换标记保留；全部范围 a 含他目录可删项
  s = reduceState(s, { type: "history-scope-toggle" });
  assert.deepEqual(s.history?.marked, ["s1", "s2"], "Tab 切换范围标记保留");
  s = reduceState(s, { type: "history-mark-all" });
  assert.deepEqual(
    [...(s.history?.marked ?? [])].sort(),
    ["s1", "s2", "other"].sort(),
    "全部范围全选含他目录可删项",
  );

  // c：清空标记；已空再 c 为 no-op
  s = reduceState(s, { type: "history-mark-clear" });
  assert.deepEqual(s.history?.marked, [], "c 清空标记");
  assert.equal(
    reduceState(s, { type: "history-mark-clear" }),
    s,
    "空标记时 c 为 no-op",
  );
});

test("面板：有标记 d 走批量确认（pendingDeleteIds）；无标记走单条；批量集剔除已不可删项", () => {
  const cur = rec({ id: "cur", live: true, current: true, cwd: "/proj" });
  const records = [
    cur,
    rec({ id: "s1", cwd: "/proj", title: "第一条" }),
    rec({ id: "s2", cwd: "/proj", title: "第二条" }),
  ];
  let s = panelState(records);

  // 无标记 → 单条（高亮 s1 → pendingDelete）
  s = reduceState(s, { type: "history-move", delta: 1 });
  s = reduceState(s, { type: "history-confirm-delete" });
  assert.equal(s.history?.phase, "confirm-delete");
  assert.equal(s.history?.pendingDelete, "s1");
  assert.equal(s.history?.pendingDeleteIds, undefined);
  s = reduceState(s, { type: "history-confirm-cancel" });
  assert.equal(s.history?.phase, "list");
  assert.equal(s.history?.pendingDeleteIds, undefined, "取消清空批量目标");

  // 标记 s1+s2 → d 走批量（pendingDelete 清空、pendingDeleteIds 填标记集；取消后 index 仍在 s1）
  s = reduceState(s, { type: "history-mark-toggle" }); // s1
  s = reduceState(s, { type: "history-mark-toggle" }); // s2
  s = reduceState(s, { type: "history-confirm-delete" });
  assert.equal(s.history?.phase, "confirm-delete");
  assert.deepEqual(s.history?.pendingDeleteIds, ["s1", "s2"]);
  assert.equal(
    s.history?.pendingDelete,
    undefined,
    "批量时走 pendingDeleteIds",
  );

  // 标记项刷新后不可删（如变 live）→ 批量集剔除
  let t = reduceState(s, { type: "history-confirm-cancel" });
  t = reduceState(t, {
    type: "history-refresh",
    records: [
      cur,
      rec({ id: "s1", cwd: "/proj", title: "第一条" }),
      rec({ id: "s2", live: true, cwd: "/proj", title: "第二条" }),
    ],
  });
  t = reduceState(t, { type: "history-confirm-delete" });
  assert.deepEqual(t.history?.pendingDeleteIds, ["s1"], "批量集仅保留仍可删项");
});

test("面板：delete-done 批量移除记录并按成功集收敛标记（部分失败留标记）", () => {
  const cur = rec({ id: "cur", live: true, current: true, cwd: "/proj" });
  const records = [
    cur,
    rec({ id: "s1", cwd: "/proj" }),
    rec({ id: "s2", cwd: "/proj" }),
    rec({ id: "s3", cwd: "/proj" }),
  ];
  let s = panelState(records);
  s = reduceState(s, { type: "history-mark-all" });
  s = reduceState(s, { type: "history-confirm-delete" });
  s = reduceState(s, { type: "history-delete" });
  s = reduceState(s, { type: "history-delete-done", ids: ["s1", "s3"] });
  assert.deepEqual(
    s.history?.records.map((r) => r.id),
    ["cur", "s2"],
    "批量删除按成功集移除记录",
  );
  assert.deepEqual(s.history?.marked, ["s2"], "失败项（s2）保留标记便于重试");
  assert.equal(s.history?.pendingDeleteIds, undefined, "完成后清空批量目标");
});

test("面板：clean-done 仅移除已删除记录；阶段不符时忽略", () => {
  const records = [
    rec({ id: "cur", live: true, current: true, cwd: "/proj" }),
    rec({ id: "a", isEmpty: true, cwd: "/proj" }),
    rec({ id: "b", isEmpty: true, cwd: "/proj" }),
    rec({ id: "c", isEmpty: true, cwd: "/proj" }),
  ];
  const idle = panelState(records);
  const ignored = reduceState(idle, { type: "history-clean-done", ids: ["a"] });
  assert.equal(ignored.history?.records.length, 4, "非 cleaning 阶段忽略");

  // 无可清理项（空会话属于其他项目）→ 不进入确认
  const foreign = reduceState(
    panelState([
      rec({ id: "cur", live: true, current: true, cwd: "/proj" }),
      rec({ id: "x", isEmpty: true, cwd: "/other" }),
    ]),
    { type: "history-confirm-clean" },
  );
  assert.equal(foreign.history?.phase, "list", "无可清理项不进入确认");

  let s = reduceState(idle, { type: "history-confirm-clean" });
  assert.equal(s.history?.phase, "confirm-clean");
  assert.deepEqual(s.history?.pendingClean, ["a", "b", "c"]);
  assert.equal(s.history?.cleanCwd, "/proj", "确认态记住项目路径");
  s = reduceState(s, { type: "history-clean" });
  assert.equal(s.history?.phase, "cleaning");
  s = reduceState(s, { type: "history-clean-done", ids: ["a", "c"] });
  assert.deepEqual(
    s.history?.records.map((r) => r.id),
    ["cur", "b"],
  );
  assert.equal(s.history?.phase, "list");
  assert.equal(s.history?.cleanCwd, undefined);
});

test("cleanableSessionIds：仅当前项目 + 已持久化 + 非 live + 无用户消息", () => {
  const records = [
    rec({ id: "cur", live: true, current: true, cwd: "/proj" }),
    rec({ id: "empty-a", isEmpty: true, cwd: "/proj" }),
    rec({ id: "chat-b", cwd: "/proj" }),
    rec({ id: "empty-other", isEmpty: true, cwd: "/other" }),
    rec({ id: "empty-mem", isEmpty: true, cwd: "/proj", persisted: false }),
  ];
  const s = panelState(records);
  assert.deepEqual(cleanableSessionIds(s), ["empty-a"]);
  assert.equal(currentProjectCwd(s), "/proj");

  // 项目未知（无 current 记录且状态区仍是占位）→ 不清理任何会话
  const orphan = panelState([
    rec({ id: "empty-a", isEmpty: true, cwd: "/proj" }),
  ]);
  assert.equal(currentProjectCwd(orphan), undefined);
  assert.deepEqual(cleanableSessionIds(orphan), []);

  // 状态区 cwd 兜底（无 current 记录时仍能定位当前项目）
  const viaStatus = reduceState(
    panelState([rec({ id: "empty-a", isEmpty: true, cwd: "/proj" })]),
    {
      type: "status",
      status: { cwd: "/proj" },
    },
  );
  assert.equal(currentProjectCwd(viaStatus), "/proj");
  assert.deepEqual(cleanableSessionIds(viaStatus), ["empty-a"]);

  // all 范围：清理范围跟随列表范围（含其他目录空会话；仍排除 live/当前/未持久化/非空）
  const allScope = reduceState(s, { type: "history-scope-toggle" });
  assert.deepEqual(cleanableSessionIds(allScope), ["empty-a", "empty-other"]);

  // all 范围下当前项目未知仍可清理（列表即全量）
  const orphanAll = reduceState(orphan, { type: "history-scope-toggle" });
  assert.deepEqual(cleanableSessionIds(orphanAll), ["empty-a"]);

  // all → project 切回：范围恢复同 cwd 限定
  const backToProject = reduceState(allScope, { type: "history-scope-toggle" });
  assert.deepEqual(cleanableSessionIds(backToProject), ["empty-a"]);
});

test("startupCleanableIds：全目录空会话（持久化 + 非 live + 非当前 + 无用户消息），不依赖面板状态", () => {
  const records: SessionInfo[] = [
    rec({ id: "cur", live: true, current: true, cwd: "/proj" }),
    rec({ id: "live-other", live: true, cwd: "/other" }),
    rec({ id: "empty-a", isEmpty: true, cwd: "/proj" }),
    rec({ id: "empty-b", isEmpty: true, cwd: "/other" }),
    rec({ id: "chat-c", cwd: "/proj" }),
    rec({ id: "mem-d", isEmpty: true, cwd: "/proj", persisted: false }),
    rec({ id: "noflag-e", isEmpty: true, cwd: "/x", persisted: true }),
  ];
  // cur/live 排除：live 会话、当前会话不算可清理；mem-d 未持久化排除；
  // noflag-e：isEmpty=true + persisted=true → 可清理
  assert.deepEqual(startupCleanableIds(records), [
    "empty-a",
    "empty-b",
    "noflag-e",
  ]);
  // 空列表 / 无可清理项 → 空数组
  assert.deepEqual(startupCleanableIds([]), []);
  assert.deepEqual(startupCleanableIds([rec({ id: "chat", cwd: "/" })]), []);
});

// ---------------------------------------------------------------------------
// 3) 面板交互流（App + 最小 fake adapter）
// ---------------------------------------------------------------------------

/** ANSI SGR 序列（帧着色）：ESC 由码点构造，避免正则字面量里的控制字符告警 */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

class FakeRenderer implements Renderer {
  private lastRenderRows: string[] = [];
  get lastRender(): string[] {
    flushApp();
    return this.lastRenderRows;
  }
  private renderCount = 0;
  /** 读帧前同步冲刷合帧（生产语义：同 tick 多次标脏只画一次） */
  get renders(): number {
    flushApp();
    return this.renderCount;
  }
  closes = 0;
  size: Size = { cols: 100, rows: 30 };
  press!: (k: KeyEvent) => void;

  render(rows: FrameRow[]): void {
    this.lastRenderRows = rows.map((r) =>
      r.segments.map((s) => s.text).join(""),
    );
    this.renderCount++;
  }
  refresh(rows: FrameRow[]): void {
    this.render(rows);
  }
  onKey(cb: (k: KeyEvent) => void): void {
    this.press = cb;
  }
  emitKey(k: KeyEvent): void {
    this.press(k);
  }
  onResize(_cb: (cols: number, rows: number) => void): void {}
  getSize(): Size {
    return this.size;
  }
  setTheme(_id: ThemeId): void {}
  close(): void {
    this.closes++;
  }
}

/**
 * 只实现历史会话路径所需的 adapter 面（其余成员不参与测试，故不声明）。
 * 方法用**原型方法**定义（刻意不解绑安全）：App 侧按接收者调用（`.call(adapter)`），
 * 若退回解绑调用会丢 this → 测试失败。
 * 另：删除只标记服务端状态、不改本地可见列表——列表只能靠重新 listSessions 更新，
 * 这样「删除后是否真的重拉列表」可被证伪（本地移除不会被误判为已刷新）。
 */
class FakeSessionsAdapter {
  sessionId = "s1";
  /** 服务端会话列表（listSessions 的唯一数据源） */
  serverRecords: SessionInfo[] = [];
  deleteCalls: string[] = [];
  listSessionsCalls = 0;
  failOn = new Set<string>();
  /** 非空时删除会等它 resolve：便于确定性观测 deleting/cleaning 阶段帧 */
  deleteGate: Promise<void> | null = null;
  private deleted = new Set<string>();
  private cbs: ((e: DshEvent) => void)[] = [];

  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    return () => {};
  }
  sendMessage(): void {}
  runCommand(): void {}
  approve(): void {}
  answerQuestion(): void {}
  cancelQuestion(): void {}
  interrupt(): void {}
  dispose(): void {}
  async listSessions(): Promise<SessionInfo[]> {
    this.listSessionsCalls++;
    return this.serverRecords.filter((r) => !this.deleted.has(r.id));
  }
  async deleteSession(id: string): Promise<SessionDeleteResult> {
    this.deleteCalls.push(id);
    if (this.deleteGate) await this.deleteGate;
    if (this.failOn.has(id)) return { ok: false, reason: "删除失败：EPERM" };
    this.deleted.add(id);
    return { ok: true };
  }
}

function makeApp(opts?: { autoCleanEmpty?: boolean }): {
  renderer: FakeRenderer;
  adapter: FakeSessionsAdapter;
  frame: () => string;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeSessionsAdapter();
  const app = new TrackedApp({
    renderer,
    adapter: adapter as unknown as DshAdapter,
    autoCleanEmpty: opts?.autoCleanEmpty,
  });
  app.start();
  return {
    renderer,
    adapter,
    frame: () =>
      renderer.lastRender.map((l) => l.replace(ANSI_SGR, "")).join("\n"),
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function press(renderer: FakeRenderer, name: string): void {
  renderer.press({ name, ctrl: false, meta: false, shift: false });
}

function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) press(renderer, ch);
  press(renderer, "enter");
}

test("面板 d → 二次确认 → y：只删高亮会话并刷新列表", async () => {
  const { renderer, adapter, frame } = makeApp();
  adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
    rec({ id: "tui-first001", title: "第一条", cwd: "/proj" }),
    rec({ id: "tui-second02", title: "第二条", cwd: "/proj" }),
  ];
  typeAndEnter(renderer, "/session");
  await flush();
  await flush();
  // 默认范围=当前目录：三条同 cwd 全可见（标题给出「可见/全量」）
  assert.ok(
    frame().includes("历史会话 [当前目录]（3/3）"),
    "列表打开且计数正确",
  );
  assert.equal(adapter.listSessionsCalls, 1, "打开面板拉取一次列表");
  assert.ok(frame().includes("[空]") === false, "非空会话无 [空] 标记");

  press(renderer, "down"); // 首行是当前活跃会话（不可删）→ 下移到「第一条」
  press(renderer, "d");
  assert.ok(frame().includes("删除确认"), "进入删除二次确认");
  assert.ok(frame().includes("第一条"), "确认文案含目标标题");
  assert.deepEqual(adapter.deleteCalls, [], "确认前不调用 adapter");

  press(renderer, "y");
  await flush();
  await flush();
  assert.deepEqual(adapter.deleteCalls, ["tui-first001"], "仅删除高亮会话");
  assert.equal(adapter.listSessionsCalls, 2, "删除成功后重拉一次列表");
  assert.ok(
    frame().includes("历史会话 [当前目录]（2/2）"),
    "重拉后列表收敛（fake 不自改可见列表）",
  );
  assert.ok(frame().includes("已删除会话「第一条」"), "成功提示保留原会话标题");
});

test("面板 x → 二次确认 → y：清理范围跟随列表范围（当前目录 / 全部）", async () => {
  const { renderer, adapter, frame } = makeApp();
  adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
    rec({ id: "tui-empty001", isEmpty: true, cwd: "/proj", title: "空会话" }),
    rec({ id: "tui-chat0001", cwd: "/proj", title: "有对话" }),
    rec({
      id: "tui-empty002",
      isEmpty: true,
      cwd: "/other",
      title: "他项目空会话",
    }),
    rec({ id: "tui-sym00001", isEmpty: true, cwd: "/proj", persisted: false }),
  ];
  typeAndEnter(renderer, "/session");
  await flush();
  await flush();
  // 默认当前目录：4 条同 cwd 可见（他目录 1 条隐藏），标题给出 可见/全量
  assert.ok(
    frame().includes("历史会话 [当前目录]（4/5）"),
    "默认范围=当前目录",
  );
  assert.ok(!frame().includes("他项目空会话"), "默认隐藏他目录会话");
  assert.ok(frame().includes("[空]"), "空会话列表标记 [空]");

  // 当前目录范围：只清理本目录空会话（他目录不计、未持久化不算）
  press(renderer, "x");
  assert.ok(frame().includes("清理空会话"), "进入清理确认");
  assert.ok(
    frame().includes("清理当前目录（/proj）的空会话 1 个？"),
    "当前目录范围文案与数量",
  );
  press(renderer, "n");
  assert.ok(frame().includes("历史会话 [当前目录]（4/5）"), "取消回列表");

  press(renderer, "tab");
  assert.ok(frame().includes("历史会话 [全部]（5）"), "Tab 切到全部范围");
  assert.ok(frame().includes("他项目空会话"), "全部范围显示他目录会话");

  // 全部范围：清理范围跟随列表（含他目录空会话）
  press(renderer, "x");
  assert.ok(frame().includes("清理空会话"), "进入清理确认");
  assert.ok(
    frame().includes("清理全部目录的空会话 2 个？"),
    "全部范围文案与数量（跟随列表范围）",
  );
  assert.deepEqual(adapter.deleteCalls, [], "确认前不调用 adapter");

  press(renderer, "y");
  await flush();
  await flush();
  assert.deepEqual(
    adapter.deleteCalls,
    ["tui-empty001", "tui-empty002"],
    "全部范围清理全部目录空会话（串行按列表顺序）",
  );
  assert.equal(adapter.listSessionsCalls, 2, "批量清理只重拉一次列表");
  assert.ok(frame().includes("已清理 2 个空会话"), "清理成功提示");
  assert.ok(
    frame().includes("历史会话 [全部]（3）"),
    "重拉后列表收敛（切范围不被重置）",
  );
});

test("面板护栏：当前活跃会话不可删、x 无可清理项给提示且不调用 adapter", async () => {
  const { renderer, adapter, frame } = makeApp();
  adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
  ];
  typeAndEnter(renderer, "/session");
  await flush();
  await flush();

  press(renderer, "d");
  assert.ok(frame().includes("当前活跃会话不可删除"), "d 给不可删提示");
  assert.ok(!frame().includes("删除确认"), "不进入删除确认");
  assert.deepEqual(adapter.deleteCalls, []);

  press(renderer, "x");
  assert.ok(frame().includes("没有可清理的空会话"), "x 给空结果提示");
  assert.ok(!frame().includes("确认清理"), "不进入清理确认");
  assert.deepEqual(adapter.deleteCalls, []);
});

test("面板护栏：adapter 拒绝删除（失败）→ 列表保留并提示失败原因", async () => {
  const { renderer, adapter, frame } = makeApp();
  adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
    rec({ id: "tui-boom0001", title: "删不掉的", cwd: "/proj" }),
  ];
  adapter.failOn.add("tui-boom0001");
  typeAndEnter(renderer, "/session");
  await flush();
  await flush();
  press(renderer, "down");
  press(renderer, "d");
  press(renderer, "y");
  await flush();
  await flush();
  assert.deepEqual(adapter.deleteCalls, ["tui-boom0001"]);
  assert.equal(adapter.listSessionsCalls, 1, "失败不重拉列表");
  assert.ok(frame().includes("删除失败"), "失败提示可见");
  assert.ok(frame().includes("历史会话 [当前目录]（2/2）"), "记录保留");
});

test("面板批量删除：Space 标记 → d 批量确认 → y 删除全部标记并重拉一次列表", async () => {
  const { renderer, adapter, frame } = makeApp();
  adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
    rec({ id: "tui-first001", title: "第一条", cwd: "/proj" }),
    rec({ id: "tui-second02", title: "第二条", cwd: "/proj" }),
    rec({ id: "tui-third003", title: "第三条", cwd: "/proj" }),
  ];
  typeAndEnter(renderer, "/session");
  await flush();
  await flush();

  // 首行是当前活跃会话（不可标记）→ 下移后 Space 标记前两条（自动下移），标题显示标记计数
  press(renderer, "down");
  press(renderer, "space");
  press(renderer, "space");
  assert.ok(
    frame().includes("· 标记 2"),
    "标题标明标记计数: " +
      frame()
        .split("\n")
        .find((l) => l.includes("历史会话")),
  );

  press(renderer, "d");
  assert.ok(frame().includes("批量删除确认"), "进入批量删除确认：标题");
  assert.ok(frame().includes("删除标记的 2 个会话？"), "确认文案含数量");
  assert.ok(
    frame().includes("第一条（tui-firs）") &&
      frame().includes("第二条（tui-seco"),
    "确认文案预览列出标记会话",
  );
  assert.deepEqual(adapter.deleteCalls, [], "确认前不调用 adapter");

  press(renderer, "y");
  await flush();
  await flush();
  assert.deepEqual(
    adapter.deleteCalls,
    ["tui-first001", "tui-second02"],
    "批量删除按标记顺序串行删除",
  );
  assert.equal(adapter.listSessionsCalls, 2, "批量删除只重拉一次列表");
  assert.ok(frame().includes("已删除 2 个会话"), "批量成功提示");
  assert.ok(
    frame().includes("历史会话 [当前目录]（2/2）"),
    "重拉后列表收敛（fake 不自改可见列表）",
  );
  assert.ok(frame().includes("已删除 1 个会话") === false, "不用单条文案");
});

test("面板批量删除：部分失败 → 成功项移除、失败项保留标记并重拉列表", async () => {
  const { renderer, adapter, frame } = makeApp();
  adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
    rec({ id: "tui-ok000001", title: "能删的", cwd: "/proj" }),
    rec({ id: "tui-boom0001", title: "删不掉的", cwd: "/proj" }),
    rec({ id: "tui-ok000002", title: "另一个", cwd: "/proj" }),
  ];
  adapter.failOn.add("tui-boom0001");
  typeAndEnter(renderer, "/session");
  await flush();
  await flush();

  // a 全选当前范围 3 个可删项（当前活跃天然排除）
  press(renderer, "a");
  assert.ok(frame().includes("· 标记 3"), "a 全选当前范围可删项");

  press(renderer, "d");
  assert.ok(frame().includes("删除标记的 3 个会话？"), "批量确认数量=3");
  press(renderer, "y");
  await flush();
  await flush();
  assert.deepEqual(
    adapter.deleteCalls,
    ["tui-ok000001", "tui-boom0001", "tui-ok000002"],
    "逐条删除（失败项也调用）",
  );
  assert.ok(frame().includes("已删除 2 个会话（1 个失败）"), "部分失败提示");
  assert.equal(adapter.listSessionsCalls, 2, "批量删除只重拉一次列表");
  assert.ok(
    frame().includes("· 标记 1"),
    "失败项保留标记便于重试（重拉列表后仍在）",
  );
  assert.ok(frame().includes("删不掉的"), "失败会话仍在列表");
});

test("/session clean 直达清理确认（无可清理项则提示且不开确认）", async () => {
  const { renderer, adapter, frame } = makeApp();
  adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
    rec({ id: "tui-empty001", isEmpty: true, cwd: "/proj" }),
  ];
  typeAndEnter(renderer, "/session clean");
  await flush();
  await flush();
  assert.ok(frame().includes("确认清理"), "直达清理确认");
  press(renderer, "y");
  await flush();
  await flush();
  assert.deepEqual(adapter.deleteCalls, ["tui-empty001"]);
  assert.equal(adapter.listSessionsCalls, 2, "清理成功后重拉一次列表");

  // 再执行一次：已无空会话 → 提示，不进入确认
  const again = makeApp();
  again.adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
  ];
  typeAndEnter(again.renderer, "/session clean");
  await flush();
  await flush();
  assert.ok(again.frame().includes("没有可清理的空会话"));
  assert.deepEqual(again.adapter.deleteCalls, []);
});

test("面板提示行：确认阶段给 y/n 提示，进行中阶段留空（不穿透默认提示）", async () => {
  const { renderer, adapter, frame } = makeApp();
  adapter.serverRecords = [
    rec({ id: "tui-victim001", cwd: "/proj", title: "待删会话" }),
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
    rec({ id: "tui-empty001", isEmpty: true, cwd: "/proj", title: "空会话" }),
  ];
  /** 提示区 = 帧末行 */
  const hintLine = (): string => {
    const lines = frame().split("\n");
    return lines[lines.length - 1] ?? "";
  };
  typeAndEnter(renderer, "/session");
  await flush();
  await flush();
  assert.ok(hintLine().includes("[d]删除"), "list 阶段提示含删除键");

  press(renderer, "d");
  assert.ok(hintLine().includes("[y/Enter]确认 · [n/Esc]取消"), "删除确认提示");
  assert.ok(!frame().includes("打断并发送"), "确认阶段不显示默认提示");

  // 挂住 deleting：进行中阶段提示行必须留空（且不透传默认提示）
  let release!: () => void;
  adapter.deleteGate = new Promise<void>((r) => (release = r));
  press(renderer, "y");
  await flush();
  assert.ok(frame().includes("删除中"), "面板显示删除中");
  assert.equal(hintLine().trim(), "", "deleting 阶段提示行留空");
  assert.ok(!frame().includes("打断并发送"), "进行中不显示默认提示");
  release();
  await flush();
  await flush();
  assert.equal(adapter.listSessionsCalls, 2, "释放后完成并重拉列表");

  // 清理确认 + cleaning 阶段
  adapter.deleteGate = new Promise<void>((r) => (release = r));
  press(renderer, "x");
  assert.ok(hintLine().includes("[y/Enter]确认 · [n/Esc]取消"), "清理确认提示");
  press(renderer, "y");
  await flush();
  assert.ok(frame().includes("清理中"), "面板显示清理中");
  assert.equal(hintLine().trim(), "", "cleaning 阶段提示行留空");
  release();
  await flush();
  await flush();
  assert.equal(adapter.listSessionsCalls, 3, "清理完成后再重拉一次");
});

// ---------------------------------------------------------------------------
// 4) 列表范围：当前目录（默认）/ 全部目录
// ---------------------------------------------------------------------------

test("面板范围：默认当前目录、Tab 切换全部、按 id 保留选中、不可见回首项", () => {
  const records = [
    rec({ id: "cur", live: true, current: true, cwd: "/proj" }),
    rec({ id: "p1", cwd: "/proj" }),
    rec({ id: "o1", cwd: "/other" }),
  ];
  let s = panelState(records);
  assert.equal(s.history?.scope, "project", "history-open 默认当前目录");
  assert.deepEqual(
    historyVisibleRecords(s).map((r) => r.id),
    ["cur", "p1"],
    "当前目录只保留同 cwd 会话",
  );

  // 高亮 p1 → 切到全部：按 id 保留选中
  s = reduceState(s, { type: "history-move", delta: 1 });
  s = reduceState(s, { type: "history-scope-toggle" });
  assert.equal(s.history?.scope, "all");
  assert.deepEqual(
    historyVisibleRecords(s).map((r) => r.id),
    ["cur", "p1", "o1"],
  );
  assert.equal(
    historyVisibleRecords(s)[s.history!.index]?.id,
    "p1",
    "切范围按 id 保留选中项",
  );

  // 选到仅全部范围可见的 o1 → 切回当前目录：不可见 → 回首项
  s = reduceState(s, { type: "history-move", delta: 1 });
  assert.equal(historyVisibleRecords(s)[s.history!.index]?.id, "o1");
  s = reduceState(s, { type: "history-scope-toggle" });
  assert.equal(s.history?.scope, "project");
  assert.equal(s.history?.index, 0, "选中项不可见 → 回首项");

  // move 以可见长度为界（当前目录 2 条 → 下移到底为 1，而非全量 3 条）
  s = reduceState(s, { type: "history-move", delta: 99 });
  assert.equal(s.history?.index, 1, "move 按可见长度 clamp");
});

test("historyVisibleRecords：当前目录不可识别 → 空列表（不把全量当当前目录）", () => {
  const s = panelState([rec({ id: "o1", cwd: "/other" })]);
  assert.equal(
    currentProjectCwd(s),
    undefined,
    "无 current 记录且状态区为占位",
  );
  assert.deepEqual(historyVisibleRecords(s), [], "识别失败不展示全量");
  const all = reduceState(s, { type: "history-scope-toggle" });
  assert.equal(historyVisibleRecords(all).length, 1, "全部范围仍可见");
});

test("面板范围：默认只显示当前目录会话，Tab 切全部再切回（不重拉数据）", async () => {
  const { renderer, adapter, frame } = makeApp();
  adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
    rec({ id: "tui-here0001", cwd: "/proj", title: "本目录会话" }),
    rec({ id: "tui-away0001", cwd: "/other", title: "他目录会话" }),
  ];
  typeAndEnter(renderer, "/session");
  await flush();
  await flush();
  assert.ok(
    frame().includes("历史会话 [当前目录]（2/3）"),
    "默认范围=当前目录",
  );
  assert.ok(frame().includes("本目录会话"), "本目录会话可见");
  assert.ok(!frame().includes("他目录会话"), "他目录会话默认隐藏");

  press(renderer, "tab");
  assert.ok(frame().includes("历史会话 [全部]（3）"), "Tab → 全部");
  assert.ok(frame().includes("他目录会话"), "全部范围显示他目录会话");

  press(renderer, "tab");
  assert.ok(
    frame().includes("历史会话 [当前目录]（2/3）"),
    "再 Tab → 回当前目录",
  );
  assert.ok(!frame().includes("他目录会话"), "他目录会话再次隐藏");
  assert.equal(adapter.listSessionsCalls, 1, "切范围不重拉（同一份数据）");
});

test("面板范围：当前目录不可识别 → 明确空态并提示按 Tab 看全部", async () => {
  const { renderer, adapter, frame } = makeApp();
  adapter.serverRecords = [
    rec({ id: "tui-away0001", cwd: "/other", title: "他目录会话" }),
  ];
  typeAndEnter(renderer, "/session");
  await flush();
  await flush();
  assert.ok(frame().includes("无法识别当前目录"), "识别失败给明确空态");
  assert.ok(frame().includes("[Tab] 查看全部 1 条"), "空态提示可切范围");
  assert.ok(!frame().includes("他目录会话"), "不把全量当作当前目录展示");

  press(renderer, "tab");
  assert.ok(frame().includes("他目录会话"), "Tab 后他目录会话可见");
});

/** 构造即登记到合帧冲刷钩子：FakeRenderer 读帧前 flushApp() 同步冲刷待绘制帧 */
class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

test("启动自动清理（autoCleanEmpty=true）：start 异步删除全目录空会话并提示", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSessionsAdapter();
  adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
    rec({ id: "tui-empty001", isEmpty: true, cwd: "/proj" }),
    rec({ id: "tui-empty002", isEmpty: true, cwd: "/other" }),
    rec({ id: "tui-chat0001", cwd: "/proj" }),
    rec({ id: "tui-mem00001", isEmpty: true, cwd: "/proj", persisted: false }),
  ];
  const app = new TrackedApp({
    renderer,
    adapter: adapter as unknown as DshAdapter,
    autoCleanEmpty: true,
  });
  app.start();
  await flush();
  await flush();
  // 全目录空会话（持久化+非 live+非当前+无用户消息）：empty001/empty002；
  // 当前活跃、带对话、未持久化均不动。删除走 adapter.deleteSession（串行）。
  assert.deepEqual(adapter.deleteCalls, ["tui-empty001", "tui-empty002"]);
  assert.ok(
    renderer.lastRender.join("\n").includes("已自动清理 2 个空会话"),
    "启动清理成功提示可见",
  );
  app.dispose();
});

test("启动自动清理（autoCleanEmpty=true）：删除失败按个计数并提示失败数", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSessionsAdapter();
  adapter.serverRecords = [
    rec({ id: "tui-empty001", isEmpty: true, cwd: "/proj" }),
    rec({ id: "tui-boom0001", isEmpty: true, cwd: "/proj" }),
  ];
  adapter.failOn.add("tui-boom0001");
  const app = new TrackedApp({
    renderer,
    adapter: adapter as unknown as DshAdapter,
    autoCleanEmpty: true,
  });
  app.start();
  await flush();
  await flush();
  assert.deepEqual(adapter.deleteCalls, ["tui-empty001", "tui-boom0001"]);
  assert.ok(
    renderer.lastRender
      .join("\n")
      .includes("已自动清理 1 个空会话（1 个失败）"),
    "部分失败提示含失败数",
  );
  app.dispose();
});

test("启动自动清理：关闭（缺省/autoCleanEmpty=false）或不挂会话服务时不调用删除", async () => {
  // 缺省关闭：不传 autoCleanEmpty → 即使有可清理项也不删
  const renderer = new FakeRenderer();
  const adapter = new FakeSessionsAdapter();
  adapter.serverRecords = [
    rec({ id: "tui-empty001", isEmpty: true, cwd: "/x" }),
  ];
  const app = new TrackedApp({
    renderer,
    adapter: adapter as unknown as DshAdapter,
  });
  app.start();
  await flush();
  await flush();
  assert.deepEqual(adapter.deleteCalls, [], "缺省关闭不自动清理");
  app.dispose();

  // 开启但宿主未挂载会话服务（listSessions/deleteSession undefined）→ 静默跳过
  const r2 = new FakeRenderer();
  const bare = {
    onEvent: () => () => {},
    sendMessage: () => {},
    runCommand: () => {},
    approve: () => {},
    answerQuestion: () => {},
    cancelQuestion: () => {},
    interrupt: () => {},
    dispose: () => {},
  } as unknown as DshAdapter;
  const a2 = new TrackedApp({
    renderer: r2,
    adapter: bare,
    autoCleanEmpty: true,
  });
  a2.start();
  await flush();
  assert.ok(true, "无会话服务时启动清理静默跳过（不抛错）");
  a2.dispose();
});

// ---------------------------------------------------------------------------
// 退出自动清理（复用 session.autoCleanEmpty：提示渲染到活动区，等待完成后再收尾退出）
// ---------------------------------------------------------------------------

test("退出自动清理（autoCleanEmpty=true）：提示渲染到活动区并等待清理完成再关渲染器", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSessionsAdapter();
  const app = new TrackedApp({
    renderer,
    adapter: adapter as unknown as DshAdapter,
    autoCleanEmpty: true,
  });
  app.start();
  await flush();
  // 启动后再造空会话：让「其他空会话」只由退出清理负责（启动清理为空）
  adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
    rec({ id: "tui-empty001", isEmpty: true, cwd: "/proj" }),
    rec({ id: "tui-empty002", isEmpty: true, cwd: "/other" }),
    rec({ id: "tui-chat0001", cwd: "/proj" }),
    rec({ id: "tui-mem00001", isEmpty: true, cwd: "/proj", persisted: false }),
  ];
  const rendersBefore = renderer.renders;
  app.dispose();
  assert.equal(renderer.closes, 0, "清理完成前不关渲染器（等待中）");
  await flush();
  await flush();
  // 全目录空会话（持久化+非 live+非当前+无用户消息）；当前活跃/带对话/未持久化不动
  assert.deepEqual(adapter.deleteCalls, ["tui-empty001", "tui-empty002"]);
  assert.equal(renderer.closes, 1, "清理完成后才关渲染器");
  // 「正在清理」提示帧 + 结果帧都渲染到活动区（绕过 disposed/合帧，close 前落屏）
  assert.ok(
    renderer.renders - rendersBefore >= 2,
    "先出「正在清理」帧、再出结果帧",
  );
  assert.ok(
    renderer.lastRender.join("\n").includes("已自动清理 2 个空会话"),
    "结果渲染到活动区",
  );
});

test("退出自动清理：无可清理项时静默（不出提示帧），仍正常关闭", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSessionsAdapter();
  const app = new TrackedApp({
    renderer,
    adapter: adapter as unknown as DshAdapter,
    autoCleanEmpty: true,
  });
  app.start();
  await flush();
  adapter.serverRecords = [
    rec({ id: "tui-cur00001", live: true, current: true, cwd: "/proj" }),
    rec({ id: "tui-chat0001", cwd: "/proj" }),
  ];
  const rendersBefore = renderer.renders;
  app.dispose();
  await flush();
  await flush();
  assert.deepEqual(adapter.deleteCalls, [], "无可清理项不入队");
  assert.equal(renderer.closes, 1, "仍正常关闭");
  assert.equal(renderer.renders - rendersBefore, 0, "无可清理项不出提示帧");
});

test("退出自动清理：部分失败计数渲染到活动区，仍完成收尾", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSessionsAdapter();
  adapter.failOn.add("tui-boom0001");
  const app = new TrackedApp({
    renderer,
    adapter: adapter as unknown as DshAdapter,
    autoCleanEmpty: true,
  });
  app.start();
  await flush();
  adapter.serverRecords = [
    rec({ id: "tui-empty001", isEmpty: true, cwd: "/proj" }),
    rec({ id: "tui-boom0001", isEmpty: true, cwd: "/proj" }),
  ];
  app.dispose();
  await flush();
  await flush();
  assert.deepEqual(adapter.deleteCalls, ["tui-empty001", "tui-boom0001"]);
  assert.equal(renderer.closes, 1, "失败也完成收尾（不阻塞退出）");
  assert.ok(
    renderer.lastRender
      .join("\n")
      .includes("已自动清理 1 个空会话（1 个失败）"),
    "部分失败计数渲染到活动区",
  );
});

test("退出自动清理：关闭（缺省）时 dispose 同步收尾，不渲染提示不删", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSessionsAdapter();
  adapter.serverRecords = [
    rec({ id: "tui-empty001", isEmpty: true, cwd: "/x" }),
  ];
  const app = new TrackedApp({
    renderer,
    adapter: adapter as unknown as DshAdapter,
  });
  app.start();
  const rendersBefore = renderer.renders;
  app.dispose();
  assert.equal(renderer.closes, 1, "同步关闭（不等待）");
  assert.deepEqual(adapter.deleteCalls, [], "未开启不自动清理");
  assert.equal(renderer.renders - rendersBefore, 0, "关闭时不渲染提示");
});
