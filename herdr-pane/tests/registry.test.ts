/**
 * tests/registry.test.ts — 归属登记、label 拼接、同 pane 串行化与退出清理
 *
 * 退出清理的同步面用一个**假的 `spawnSync` 替身**验证「调了哪些 argv」——
 * `createExitCleanup` 依赖模块级 `runHerdrSync`，故这里以「登记表是否被清空 + 关闭路径是否
 * 走到」为主断言，真实关闭行为留给真机脚本（不向用户 pane 动手）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PaneRegistry,
  closeArgs,
  createExitCleanup,
  renameArgs,
  runPaneCommand,
} from "../src/registry.ts";
import { resolveConfig } from "../src/types.ts";
import { fakeRunner, okEnvelope } from "./helpers.ts";

test("PaneRegistry: 登记 / 查询 / 注销 / 清空", () => {
  const registry = new PaneRegistry("dsh-pane");
  assert.equal(registry.has("wT1:p2"), false);
  const record = registry.register({ paneId: "wT1:p2", cwd: "/tmp" });
  assert.equal(record.label, "dsh-pane");
  assert.equal(record.cwd, "/tmp");
  assert.equal(registry.has("wT1:p2"), true);
  assert.equal(registry.get("wT1:p2")?.paneId, "wT1:p2");
  assert.equal(registry.panes.length, 1);

  registry.register({ paneId: "wT1:p2", label: "renamed" });
  assert.equal(registry.get("wT1:p2")?.label, "renamed");
  assert.equal(registry.panes.length, 1, "重复登记不新增记录");

  registry.unregister("wT1:p2");
  assert.equal(registry.has("wT1:p2"), false);
  registry.register({ paneId: "wT1:p3" });
  registry.clear();
  assert.deepEqual(registry.panes, []);
});

test("PaneRegistry: 同 pane 串行、不同 pane 并行、失败不阻塞后续", async () => {
  const registry = new PaneRegistry("dsh-pane");
  const order: string[] = [];
  const slow =
    (tag: string, ms: number, fail = false) =>
    async (): Promise<string> => {
      order.push(`start:${tag}`);
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      order.push(`end:${tag}`);
      if (fail) throw new Error(`${tag} failed`);
      return tag;
    };

  // 同 pane 顺序执行
  await Promise.all([
    registry.serialize("wT1:p2", slow("a", 5)),
    registry.serialize("wT1:p2", slow("b", 1)),
  ]);
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"]);

  // 失败不阻塞排队（后一笔照常执行）
  const failing = registry.serialize("wT1:p3", slow("c", 1, true));
  const after = registry.serialize("wT1:p3", slow("d", 1));
  await assert.rejects(failing);
  await after;
  assert.deepEqual(order.slice(4), ["start:c", "end:c", "start:d", "end:d"]);
});

test("closeArgs / renameArgs: 异步关闭与 label 共用同一套 argv（避免两处漂移）", () => {
  assert.deepEqual(closeArgs("wT1:p2"), ["pane", "close", "wT1:p2"]);
  assert.deepEqual(renameArgs("wT1:p2", "dsh-pane"), [
    "pane",
    "rename",
    "wT1:p2",
    "dsh-pane",
  ]);
  // 显式空串 = 清除（CLI 用 --clear，而不是空 label 参数）
  assert.deepEqual(renameArgs("wT1:p2", ""), [
    "pane",
    "rename",
    "--clear",
    "wT1:p2",
  ]);
});

test("createExitCleanup: closeOnExit=true 时清空登记表；false 时保留现场", () => {
  const enabled = resolveConfig({ closeOnExit: true });
  const registryOn = new PaneRegistry(enabled.label);
  registryOn.register({ paneId: "wT1:p2" });
  const cleanupOn = createExitCleanup(
    "/nonexistent/herdr",
    registryOn,
    enabled,
  );
  const entries = cleanupOn.closeAllSync();
  assert.deepEqual(entries, [{ paneId: "wT1:p2", attempted: true }]);
  // 关闭路径尽力而为：登记表已清空（进程随后就退出，残留靠 label 识别）
  assert.equal(registryOn.panes.length, 0);
  // 幂等：再调一次不产生新条目
  assert.deepEqual(cleanupOn.closeAllSync(), []);

  const disabled = resolveConfig({ closeOnExit: false });
  const registryOff = new PaneRegistry(disabled.label);
  registryOff.register({ paneId: "wT1:p3" });
  const cleanupOff = createExitCleanup(
    "/nonexistent/herdr",
    registryOff,
    disabled,
  );
  assert.deepEqual(cleanupOff.closeAllSync(), [
    { paneId: "wT1:p3", attempted: false },
  ]);
  assert.equal(registryOff.panes.length, 0);
});

test("createExitCleanup: 二进制不可用时只记录 attempted=false（不抛错）", () => {
  const config = resolveConfig({});
  const registry = new PaneRegistry(config.label);
  registry.register({ paneId: "wT1:p4" });
  const cleanup = createExitCleanup(undefined, registry, config);
  assert.deepEqual(cleanup.closeAllSync(), [
    { paneId: "wT1:p4", attempted: false },
  ]);
});

test("runPaneCommand: 薄包装把 argv 与超时原样交给 runner", async () => {
  const runner = fakeRunner(() => okEnvelope({}));
  const result = await runPaneCommand(runner, ["pane", "list"], 1234);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(runner.calls[0], ["pane", "list"]);
  assert.deepEqual(runner.timeouts[0], 1234);
});
