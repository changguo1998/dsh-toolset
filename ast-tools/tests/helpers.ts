/**
 * 测试公共辅助：
 * - astTest：二进制可用时正常跑，缺失时 skip（缺 bin 的机器上套件仍全绿，
 *   binary.test.ts 的降级用例专门覆盖「二进制缺失」路径且无需二进制）。
 * - withTempDir / writeFixture：临时工作区管理。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import type { TestContext } from "node:test";
import { findAstGrepBin } from "../src/binary.ts";

/** 当前环境是否探测到 ast-grep 二进制。 */
export function hasAstGrep(): boolean {
  return findAstGrepBin() !== null;
}

type TestFn = (t: TestContext) => void | Promise<void>;

/** 条件测试：二进制缺失时注册为 skip 用例。 */
export const astTest: (name: string, fn: TestFn) => void = hasAstGrep()
  ? nodeTest
  : (nodeTest.skip as (name: string, fn: TestFn) => void);

/** 创建临时目录，返回路径与清理函数。 */
export function withTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ast-tools-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 写 fixture 文件，返回绝对路径。 */
export function writeFixture(
  dir: string,
  name: string,
  content: string,
): string {
  const file = join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}
