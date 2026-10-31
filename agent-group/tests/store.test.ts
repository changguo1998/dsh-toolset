/**
 * 存储层单测：文件存储的读写口径（缺失按空书、以当前会话为准、旧版 `peerLinks` 补齐、
 * 损坏与形状不符不静默接受、原子写与 0600、目录推导与写入失败都转 `StateUnavailableError`），
 * 以及内存存储的深拷贝与注入失败（供动作层测降级）。
 *
 * 只碰 `mkdtemp` 出来的临时目录，不依赖宿主。
 */

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { emptyBook } from "../src/model.ts";
import {
  FileBookStore,
  MemoryBookStore,
  StateUnavailableError,
} from "../src/store.ts";
import type { AgentGroupBook } from "../src/types.ts";

const MANAGER = "sess-manager";
const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-group-store-"));
  dirs.push(dir);
  return dir;
}

/** 起一个落在临时目录里的文件存储（每组一个会话目录）。 */
async function setup(fileName?: string) {
  const root = await tempDir();
  const store = new FileBookStore(
    (managerSessionId) => join(root, `session-${managerSessionId}`),
    fileName,
  );
  return { root, store };
}

/** 落一份形状合法的书（写动作不参与本文件，直接构造）。 */
function sampleBook(managerSessionId = MANAGER): AgentGroupBook {
  return {
    version: 1,
    managerSessionId,
    groups: {
      team: {
        id: "g-1",
        name: "team",
        managerSessionId,
        createdAt: 10,
        members: {
          manager: {
            name: "manager",
            target: managerSessionId,
            sessionId: managerSessionId,
            level: 0,
            role: "manager",
            addedAt: 10,
          },
        },
        links: {},
        peerLinks: {},
        instructions: [],
      },
    },
  };
}

async function writeRaw(
  store: FileBookStore,
  managerSessionId: string,
  text: string,
): Promise<void> {
  const file = store.pathOf(managerSessionId);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text, "utf8");
}

test("文件存储: 状态文件不存在时按空书返回（首次建组不报错）", async () => {
  const { store } = await setup();
  assert.deepEqual(await store.load(MANAGER), emptyBook(MANAGER));
});

test("文件存储: 保存后能读回，文件 0600、2 空格缩进、不留临时文件", async () => {
  const { store } = await setup();
  const book = sampleBook();
  await store.save(book);

  const file = store.pathOf(MANAGER);
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, `状态文件应为 0600，实际 ${mode.toString(8)}`);
  const text = await readFile(file, "utf8");
  assert.match(text, /^\{\n {2}"version": 1,/);
  assert.match(text, /\n$/);

  // 临时文件在 rename 后不留（目录里只有状态文件）
  const entries = await readdir(join(file, ".."));
  assert.deepEqual(entries, ["agent-group.json"]);

  const loaded = await store.load(MANAGER);
  assert.deepEqual(loaded, book);
});

test("文件存储: 状态文件名可配，pathOf 与落盘一致", async () => {
  const { store } = await setup("groups.json");
  await store.save(sampleBook());
  const file = store.pathOf(MANAGER);
  assert.match(file, /groups\.json$/);
  const loaded = await store.load(MANAGER);
  assert.equal(loaded.groups["team"]?.name, "team");
});

test("文件存储: 读回时以当前会话为准（文件被复制到别的会话目录不自作主张）", async () => {
  const { store } = await setup();
  // 文件里写的是旧会话，但它现在躺在当前会话的目录里
  await writeRaw(store, MANAGER, JSON.stringify(sampleBook("sess-old")));
  const loaded = await store.load(MANAGER);
  assert.equal(loaded.managerSessionId, MANAGER);
  assert.equal(loaded.groups["team"]?.name, "team");
});

test("文件存储: 旧版落盘缺 peerLinks 时按空补齐", async () => {
  const { store } = await setup();
  const book = sampleBook();
  const legacy = JSON.parse(JSON.stringify(book)) as {
    groups: Record<string, Record<string, unknown>>;
  };
  delete legacy.groups["team"]?.["peerLinks"];
  await writeRaw(store, MANAGER, JSON.stringify(legacy));

  const loaded = await store.load(MANAGER);
  assert.deepEqual(loaded.groups["team"]?.peerLinks, {});
});

test("文件存储: 非法 JSON → StateUnavailableError，提示删掉文件重建", async () => {
  const { store } = await setup();
  await writeRaw(store, MANAGER, "{ 不是 JSON");
  await assert.rejects(
    () => store.load(MANAGER),
    (error: unknown) => {
      assert.ok(error instanceof StateUnavailableError);
      assert.equal(error.name, "StateUnavailableError");
      assert.match(error.message, /不是合法 JSON/);
      assert.match(error.message, /删掉该文件后重新 create_group/);
      return true;
    },
  );
});

test("文件存储: 形状校验逐项生效（版本 / 会话 / 组集合 / 组字段）", async () => {
  const { store } = await setup();
  const cases: Array<{ label: string; text: string }> = [
    { label: "顶层不是对象", text: "[]" },
    { label: "version 不是 1", text: JSON.stringify({ version: 2 }) },
    {
      label: "managerSessionId 不是字符串",
      text: JSON.stringify({ version: 1, managerSessionId: 1, groups: {} }),
    },
    {
      label: "groups 不是对象",
      text: JSON.stringify({
        version: 1,
        managerSessionId: MANAGER,
        groups: "nope",
      }),
    },
    {
      label: "组不是对象",
      text: JSON.stringify({
        version: 1,
        managerSessionId: MANAGER,
        groups: { team: 1 },
      }),
    },
    {
      label: "组缺 name",
      text: JSON.stringify({
        version: 1,
        managerSessionId: MANAGER,
        groups: { team: { id: "g-1", createdAt: 1 } },
      }),
    },
    {
      label: "组 createdAt 不是数字",
      text: JSON.stringify({
        version: 1,
        managerSessionId: MANAGER,
        groups: {
          team: { id: "g-1", name: "team", createdAt: "10" },
        },
      }),
    },
    {
      label: "组缺 members",
      text: JSON.stringify({
        version: 1,
        managerSessionId: MANAGER,
        groups: { team: { id: "g-1", name: "team", createdAt: 1 } },
      }),
    },
    {
      label: "组缺 links",
      text: JSON.stringify({
        version: 1,
        managerSessionId: MANAGER,
        groups: {
          team: {
            id: "g-1",
            name: "team",
            createdAt: 1,
            members: {},
          },
        },
      }),
    },
    {
      label: "组缺 instructions",
      text: JSON.stringify({
        version: 1,
        managerSessionId: MANAGER,
        groups: {
          team: {
            id: "g-1",
            name: "team",
            createdAt: 1,
            members: {},
            links: {},
          },
        },
      }),
    },
  ];
  for (const item of cases) {
    await writeRaw(store, MANAGER, item.text);
    await assert.rejects(
      () => store.load(MANAGER),
      (error: unknown) => {
        assert.ok(error instanceof StateUnavailableError, item.label);
        assert.match(error.message, /形状不符/, item.label);
        return true;
      },
      item.label,
    );
  }
});

test("文件存储: 目录推导抛错 → StateUnavailableError（带会话 id 与原因）", async () => {
  const store = new FileBookStore(() => {
    throw new Error("会话不在宿主的 sessions 里");
  });
  await assert.rejects(
    () => store.load(MANAGER),
    (error: unknown) => {
      assert.ok(error instanceof StateUnavailableError);
      assert.match(error.message, /sessionDirFor\(sess-manager\)/);
      assert.match(error.message, /会话不在宿主的 sessions 里/);
      return true;
    },
  );
  // pathOf 是排障入口，不包装异常
  assert.throws(() => store.pathOf(MANAGER), /会话不在宿主的 sessions 里/);
});

test("文件存储: 读失败但不是 ENOENT → StateUnavailableError（不按空书吞掉）", async () => {
  const root = await tempDir();
  // 把会话目录本身做成文件：readFile 报 ENOTDIR（非 ENOENT）
  const blocker = join(root, "session-sess-manager");
  await writeFile(blocker, "x", "utf8");
  const store = new FileBookStore((managerSessionId) =>
    join(root, `session-${managerSessionId}`),
  );
  await assert.rejects(
    () => store.load(MANAGER),
    (error: unknown) => {
      assert.ok(error instanceof StateUnavailableError);
      assert.match(error.message, /读取组状态失败/);
      return true;
    },
  );
});

test("文件存储: 写入失败 → StateUnavailableError，且不留下临时文件", async () => {
  const root = await tempDir();
  // 会话目录的位置被一个普通文件占住：mkdir 报 ENOTDIR
  const blocker = join(root, "session-sess-manager");
  await writeFile(blocker, "x", "utf8");
  const store = new FileBookStore((managerSessionId) =>
    join(root, `session-${managerSessionId}`),
  );
  await assert.rejects(
    () => store.save(sampleBook()),
    (error: unknown) => {
      assert.ok(error instanceof StateUnavailableError);
      assert.match(error.message, /写入组状态失败/);
      return true;
    },
  );
  // 根目录里只剩占位的文件，没有残留的 .tmp
  const entries = await readdir(root);
  assert.deepEqual(entries, ["session-sess-manager"]);
});

test("内存存储: save 存深拷贝，后续改动不影响已存副本", async () => {
  const store = new MemoryBookStore();
  const book = sampleBook();
  await store.save(book);
  book.groups["team"]!.name = "changed";

  const first = await store.load(MANAGER);
  assert.equal(first.groups["team"]?.name, "team");
  // 读出来的也是副本：改它不污染仓库
  first.groups["team"]!.name = "mutated";
  const second = await store.load(MANAGER);
  assert.equal(second.groups["team"]?.name, "team");
  assert.equal(store.saves, 1);
  assert.equal(store.loads, 2);
});

test("内存存储: 未保存过的会话按空书；注入失败可测动作层降级", async () => {
  const store = new MemoryBookStore();
  assert.deepEqual(await store.load("sess-other"), emptyBook("sess-other"));

  store.failLoad = new Error("读失败（测试注入）");
  await assert.rejects(() => store.load(MANAGER), /读失败（测试注入）/);

  store.failLoad = undefined;
  store.failSave = new Error("写失败（测试注入）");
  await assert.rejects(() => store.save(sampleBook()), /写失败（测试注入）/);
});
