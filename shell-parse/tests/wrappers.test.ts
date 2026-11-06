import { test } from "node:test";
import assert from "node:assert/strict";

import { stripWrappers, tokenizeSegment } from "../src/index.ts";

/** 便捷：切词后剥离包装器，返回命令位词与包装器链。 */
function strip(command: string): {
  word: string | undefined;
  wrappers: readonly string[];
} {
  const tokens = tokenizeSegment(command).map((token) => token.value);
  const stripped = stripWrappers(tokens);
  return { word: tokens[stripped.index], wrappers: stripped.wrappers };
}

test("stripWrappers：单层包装器", () => {
  assert.deepEqual(strip("ruby x.rb"), { word: "ruby", wrappers: [] });
  assert.deepEqual(strip("sudo -u root ruby -e 'p 1'"), {
    word: "ruby",
    wrappers: ["sudo"],
  });
  assert.deepEqual(strip("env FOO=1 BAR=2 python x.py"), {
    word: "python",
    wrappers: ["env"],
  });
  assert.deepEqual(strip("nohup node x.mjs"), {
    word: "node",
    wrappers: ["nohup"],
  });
});

test("stripWrappers：带位置参数的包装器（timeout / xargs）", () => {
  assert.deepEqual(strip("timeout 30 node x.mjs"), {
    word: "node",
    wrappers: ["timeout"],
  });
  assert.deepEqual(strip("timeout -s KILL 30 node x.mjs"), {
    word: "node",
    wrappers: ["timeout"],
  });
  assert.deepEqual(strip("xargs -n1 ruby x.rb"), {
    word: "ruby",
    wrappers: ["xargs"],
  });
  assert.deepEqual(strip("xargs -I{} perl -e 'print'"), {
    word: "perl",
    wrappers: ["xargs"],
  });
});

test("stripWrappers：语义带值的短选项（-n 10 / -o0 / -u root）", () => {
  assert.deepEqual(strip("nice -n 10 python x.py"), {
    word: "python",
    wrappers: ["nice"],
  });
  assert.deepEqual(strip("stdbuf -o0 node x.mjs"), {
    word: "node",
    wrappers: ["stdbuf"],
  });
  assert.deepEqual(strip("sudo --user=root gem list"), {
    word: "gem",
    wrappers: ["sudo"],
  });
});

test("stripWrappers：多词包装器（uv run / npx / pnpm exec / bundle exec）", () => {
  assert.deepEqual(strip("uv run python x.py"), {
    word: "python",
    wrappers: ["uv run"],
  });
  assert.deepEqual(strip("uv run --python 3.12 -- python x.py"), {
    word: "python",
    wrappers: ["uv run"],
  });
  assert.deepEqual(strip("npx -y tsx scripts/gen.ts"), {
    word: "tsx",
    wrappers: ["npx"],
  });
  assert.deepEqual(strip("pnpm exec ts-node src/main.ts"), {
    word: "ts-node",
    wrappers: ["pnpm exec"],
  });
  assert.deepEqual(strip("bundle exec ruby x.rb"), {
    word: "ruby",
    wrappers: ["bundle exec"],
  });
});

test("stripWrappers：多层包装器链", () => {
  assert.deepEqual(strip("sudo env FOO=1 ruby x.rb"), {
    word: "ruby",
    wrappers: ["sudo", "env"],
  });
});

test("stripWrappers：参数位与被包装器吃掉的下标不误判", () => {
  assert.deepEqual(strip("echo ruby"), { word: "echo", wrappers: [] });
  assert.deepEqual(strip("grep -rn ruby src/"), { word: "grep", wrappers: [] });
  // `command` 不进包装器表：`command -v python` 只是查路径，不能当执行
  assert.deepEqual(strip("command -v python"), {
    word: "command",
    wrappers: [],
  });
});
