// tests/tui-config-merge.test.ts — TUI 配置来源合并（patch > 配置文件 > 默认）
//
// 2026-10-27 用户裁定：`tui.config.json` 的内容改为写进 profile 的 cordis.patch.yml
// （`- id: tui` 的 config 扁平展开，主题段改名 `colorschema`）；patch 值优先于包内配置文件。

import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeTuiConfig } from "../src/app/config.ts";

test("mergeTuiConfig：patch 段覆盖文件段（段内逐键浅合并）", () => {
  const file = {
    layout: { activityPlacement: "vertical" as const, statusColumnDivisor: 3 },
    approval: { timeoutMs: 60_000 },
  };
  const merged = mergeTuiConfig(file, {
    layout: { activityPlacement: "auto" },
    approval: { timeoutMs: 90_000 },
  });
  assert.equal(merged.layout?.activityPlacement, "auto", "patch 覆盖同名键");
  assert.equal(
    merged.layout?.statusColumnDivisor,
    3,
    "patch 未重述的键保留文件值",
  );
  assert.equal(merged.approval?.timeoutMs, 90_000, "审批超时取 patch 值");
});

test("mergeTuiConfig：patch 的 colorschema 段覆盖文件 theme 段", () => {
  const file = {
    theme: { active: "dark" as const, paletteDir: "~/fff/colortheme" },
  };
  const merged = mergeTuiConfig(file, { colorschema: { active: "light" } });
  assert.equal(merged.theme?.active, "light", "colorschema.active 生效");
  assert.equal(
    merged.theme?.paletteDir,
    "~/fff/colortheme",
    "文件里的个人调色板目录仍在（patch 未重述）",
  );
  // 完全不给 patch：文件值原样保留
  assert.deepEqual(mergeTuiConfig(file).theme, file.theme);
});

test("mergeTuiConfig：patch 缺省时返回文件配置；文件缺段时按 patch 补", () => {
  assert.deepEqual(mergeTuiConfig({}), {});
  const merged = mergeTuiConfig({}, { session: { autoCleanEmpty: false } });
  assert.equal(merged.session?.autoCleanEmpty, false, "文件无该段也能由 patch 补");
  assert.equal(merged.layout, undefined, "未提供的段不凭空出现");
});
