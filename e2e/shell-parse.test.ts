import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage } from "./harness.ts";

test("shell_parse 服务在真实宿主里剥离包装器并递归嵌套命令", async (t) => {
  const host = await bootPackage("shell-parse");
  t.after(async () => host.dispose());

  const parser = host.ctx.get("shellParse") as {
    commandWords(command: string): readonly string[];
    commandPositions(command: string): readonly {
      word: string;
      wrappers: readonly string[];
      source: string;
    }[];
    splitCommandSegments(command: string): {
      segments: readonly string[];
      balanced: boolean;
    };
  };
  assert.equal(typeof parser.commandWords, "function");

  // 多词包装器 + 带值选项
  assert.deepEqual(parser.commandWords("sudo -u root uv run python x.py"), [
    "python",
  ]);
  assert.deepEqual(parser.commandWords("timeout 30 npx tsx gen.ts"), ["tsx"]);
  // 嵌套：shell -c 与命令替换
  assert.deepEqual(parser.commandWords('bash -c "ruby x.rb"'), [
    "bash",
    "ruby",
  ]);
  assert.deepEqual(parser.commandWords("echo $(ruby x.rb)"), ["echo", "ruby"]);
  // 参数位不误判
  assert.deepEqual(parser.commandWords("echo python"), ["echo"]);

  const position = parser.commandPositions(
    "sudo -u root uv run python x.py",
  )[0];
  assert.equal(position?.word, "python");
  assert.deepEqual(position?.wrappers, ["sudo", "uv run"]);
  assert.equal(position?.source, "top");

  const parsed = parser.splitCommandSegments('echo "a;b"; ls -la');
  assert.deepEqual(parsed.segments, ['echo "a;b"', "ls -la"]);
  assert.equal(parsed.balanced, true);
});
