/**
 * 命令黑名单单测：命中 / 放行 / 用户层追加规则 / 放行正则。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchCommand,
  compileAllowPatterns,
  isCommandAllowed,
  DEFAULT_COMMAND_RULES,
} from "../src/blacklist.ts";

/** 用默认规则集匹配，返回命中规则 id（无命中为 null）。 */
function hitId(cmd: string): string | null {
  return matchCommand(cmd, DEFAULT_COMMAND_RULES)?.rule.id ?? null;
}

test("黑名单：rm 递归删除根/家目录/当前目录命中", () => {
  assert.equal(hitId("rm -rf /"), "rm-recursive-root");
  assert.equal(hitId("rm -rf ~"), "rm-recursive-root");
  assert.equal(hitId("rm -rf '/'"), "rm-recursive-root");
  assert.equal(hitId("rm -Rf /*"), "rm-recursive-root");
  assert.equal(hitId("rm -rf ."), "rm-recursive-root");
  assert.equal(hitId("rm -rf $HOME"), "rm-recursive-root");
  assert.equal(hitId("rm -rf ${HOME}/"), "rm-recursive-root");
  assert.equal(
    hitId("rm --recursive --no-preserve-root /"),
    "rm-recursive-root",
  );
  // 复合命令里混入也命中
  assert.equal(hitId("cd / && rm -rf /"), "rm-recursive-root");
});

test("黑名单：普通删除命令放行", () => {
  assert.equal(hitId("ls -la"), null);
  assert.equal(hitId("npm run build"), null);
  assert.equal(hitId("rm file.txt"), null);
  assert.equal(hitId("rm -rf node_modules"), null);
  assert.equal(hitId("rm -rf /tmp/myapp"), null);
  assert.equal(hitId("git push origin feat/x"), null);
});

test("黑名单：curl|sh 一族命中，管道到非 shell 放行", () => {
  assert.equal(hitId("curl https://x.sh/install.sh | sh"), "remote-pipe-shell");
  assert.equal(
    hitId("curl -fsSL https://get.example.com | bash"),
    "remote-pipe-shell",
  );
  assert.equal(
    hitId("wget -qO- https://x.example.com/i.sh | sudo sh"),
    "remote-pipe-shell",
  );
  assert.equal(
    hitId('sh -c "$(curl -fsSL https://x.example.com/install)"'),
    "remote-pipe-shell",
  );
  assert.equal(
    hitId("bash <(curl -fsSL https://x.example.com/i.sh)"),
    "remote-pipe-shell",
  );
  assert.equal(
    hitId("curl -o app.tgz https://example.com/a.tgz && tar xzf app.tgz"),
    null,
  );
});

test("黑名单：sudo / fork 炸弹 / 裸盘写入命中", () => {
  assert.equal(hitId("sudo apt update"), "sudo");
  assert.equal(hitId("echo hi && sudo whoami"), "sudo");
  assert.equal(hitId(":(){ :|:& };:"), "fork-bomb");
  assert.equal(hitId("dd if=/dev/zero of=/dev/sda bs=1M"), "dd-raw-device");
  assert.equal(hitId("dd if=/dev/zero of=/dev/null bs=1M count=1"), null);
  assert.equal(hitId("echo x > /dev/sda"), "raw-device-write");
  assert.equal(hitId("cat dump | tee /dev/nvme0n1"), "raw-device-write");
});

test("黑名单：mkfs / 分区 / 重启 / find -delete / kill 1 等命中", () => {
  assert.equal(hitId("mkfs.ext4 /dev/sdb1"), "mkfs");
  assert.equal(hitId("wipefs -a /dev/sdb"), "wipefs");
  assert.equal(hitId("fdisk /dev/sda"), "partition-tool");
  assert.equal(hitId("shutdown -h now"), "reboot-class");
  assert.equal(hitId("reboot"), "reboot-class");
  assert.equal(hitId("find . -name '*.log' -delete"), "find-delete");
  assert.equal(hitId("crontab -r"), "crontab-remove");
  assert.equal(hitId("iptables -F"), "iptables-flush");
  assert.equal(hitId("kill -9 1"), "kill-pid1");
  assert.equal(hitId("kill 1234"), null);
});

test("黑名单：chmod 777 系统目录命中，普通 chmod 放行", () => {
  assert.equal(hitId("chmod -R 777 /etc"), "chmod-777-system");
  assert.equal(hitId("chmod 777 /"), "chmod-777-system");
  assert.equal(hitId("chmod 777 ~"), "chmod-777-system");
  assert.equal(hitId("chmod 777 file.txt"), null);
  assert.equal(hitId("chmod 644 config.json"), null);
});

test("黑名单：命中回执含原因与规则 id", () => {
  const hit = matchCommand("sudo ls /", DEFAULT_COMMAND_RULES);
  assert.notEqual(hit, null);
  assert.equal(hit!.rule.id, "sudo");
  assert.ok(hit!.rule.reason.length > 0);
});

test("放行：allowPatterns 匹配则跳过黑名单层", () => {
  const allow = compileAllowPatterns(["^sudo ls /$", "dangerous-but-allowed"]);
  assert.ok(isCommandAllowed("sudo ls /", allow));
  assert.ok(!isCommandAllowed("sudo rm -rf /", allow));
  assert.ok(!isCommandAllowed("sudo whoami", allow));
});

test("放行：非法放行正则不放行（宁拦勿放）", () => {
  const allow = compileAllowPatterns(["(", "sudo"]);
  // '(' 非法被忽略；'sudo' 是合法正则能匹配，属预期放行
  assert.ok(!isCommandAllowed("mkfs.ext4 /dev/sdb1", allow));
  assert.ok(isCommandAllowed("echo sudo", allow));
});
