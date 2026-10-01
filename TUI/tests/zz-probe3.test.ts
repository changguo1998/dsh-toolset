import { test } from "node:test";
import { buildFrame, frameGeometry } from "../src/app/layout.ts";
import { rowAnsi } from "./helpers/rowText.ts";
import { initialState, reduceState } from "../src/app/state.ts";

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
test("probe3", () => {
  let s = initialState();
  s = reduceState(s, { type: "status", status: { time: "12:00:00", cwd: "/u", git: "main" } });
  s = reduceState(s, { type: "user-line", text: "第一问" });
  s = reduceState(s, { type: "append", text: "回复一段正文" });
  const g1 = frameGeometry(s, { rows: 24, cols: 80 });
  const g2 = frameGeometry(reduceState(s, { type: "lower-panes", visible: false }), { rows: 24, cols: 80 });
  console.log("geom shown:", JSON.stringify({ t: g1.titleRows, a: g1.activityH, d: g1.dialogueH, sep: g1.activitySepRow, top: g1.contentTopH }));
  console.log("geom hidden:", JSON.stringify({ t: g2.titleRows, a: g2.activityH, d: g2.dialogueH, sep: g2.activitySepRow, top: g2.contentTopH }));
  const rows = buildFrame(reduceState(s, { type: "lower-panes", visible: false }), { rows: 24, cols: 80 }).map((r) => strip(rowAnsi(r)));
  console.log("=== hidden rows 0..8 ===");
  rows.slice(0, 9).forEach((r, i) => console.log(i, "|" + r.replace(/\s+$/, "") + "|"));
  // 焦点=status 时的顶部行
  let st = s;
  st = reduceState(st, { type: "focus-panel-cycle" });
  st = reduceState(st, { type: "focus-panel-cycle" });
  st = reduceState(st, { type: "focus-panel-cycle" });
  const fr = buildFrame(st, { rows: 24, cols: 80 }).map((r) => strip(rowAnsi(r)));
  console.log("=== status focus rows 0..3 ===");
  fr.slice(0, 4).forEach((r, i) => console.log(i, "|" + r.replace(/\s+$/, "") + "|"));
});
