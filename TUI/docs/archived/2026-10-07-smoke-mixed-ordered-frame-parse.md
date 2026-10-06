# 冒烟 `activity-mixed-ordered` 场景帧解析改用终端模拟器（接取条目：`TUI/docs/BACKLOG.md`「`npm run demo -- --smoke` 的 `activity-mixed-ordered` 场景恒失败」）

状态：关闭　　开启：2026-10-07　　关闭：2026-10-07
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

修掉冒烟项 `activity-mixed-ordered` 的恒失败（`SMOKE_FAIL n=1`）：该场景把输出**按 `\r\n` 切行**，而渲染器自 2026-10-05（`647761d`）起**逐行绝对定位**（行间不再发 `\r\n`）→ 五个子串全部落在同一「行」上，行序断言 `aM > aT` 恒假（实测 `idx=0,0,0,0,0,-1`）。修好后 `npm run demo -- --smoke` 应 `SMOKE_FAIL n=0`。

## 调研（2026-10-07，源码 + 既有工具）

1. 现状取证（`demo/main.ts:513-515`）：取 `smokeOut` 中最后一处 `\x1b[2J\x1b[H` 之后的文本、按 `\r\n` 切行。**两处都已失真**：
   - 渲染器现在**只首帧清屏**（`src/renderer/screen.ts:151-165`：后续全帧走 `base + "\x1b[1;1H"` 覆盖重写，不发 `2J`）→ `split("\x1b[2J\x1b[H").at(-1)` 实际拿到的是**首帧之后的全部输出**，不是「最后一帧」（子代理实测：全流 `2J` 仅 1 次、CRLF 0 次）；
   - 每行以 `\x1b[<row>;1H` 绝对定位（`screen.ts:177`）+ `\x1b[K` 擦行（`:41`），行间无 `\r\n` → 切行结果只有 1 行。
1. **已有现成实现（复用点）**：`tests/helpers/screenEmu.ts` 的 `ScreenEmu`——喂入 ANSI 报文，按真实 VT 语义处理 `CSI H/K/J`、CR/LF、SGR、宽字符与自动换行，产出**屏幕单元格**；`line(r)` 给第 r 行文本（行尾裁剪）。用法见 `tests/screen-residue.test.ts:17-32`（`feed` 在 `write` 回调里逐块喂）；仓库自带的排查配方见 `src/renderer/index.ts:94-113` 与 `README.md:352`（把 `kind:"out"` 报文按序喂给 `ScreenEmu.feed()` 重放）。
1. 跨目录复用的先例与编译面：`scripts/freeze-focus-frame.mts:20` 已从 `tests/helpers/` 导入（但 `scripts` 不在 tsconfig 的 include）；本条的 demo 与 tests **都在** `tsconfig.json:24-29` 的 include 内 → 子代理用项目同款编译参数实测导入 **exit 0**；emit 侧 `.ts`→`.js` 由 `rewriteRelativeImportExtensions` 重写，`dist/tests/helpers/screenEmu.js` 本就存在（`dist/tests` 已在发布面，属既有事实，本条不新增）。
1. 屏幕尺寸：smoke 无 TTY，渲染器用默认尺寸（`renderer.getSize()`；`screen.ts:126-127` 的 `process.stdout.columns || 80 / rows || 24` → 80×24，无 resize 路径），`ScreenEmu` 必须以**同一尺寸**构造（`screen-residue.test.ts:21-31` 的注释专门强调这点）。
1. 断言本体（`demo/main.ts:518-539`）：`aT < aM < aTool < aN`（时间顺序）+ `aSum >= 0` + `mixedSepIdx < 0 || aSum < mixedSepIdx`（总结在活动区分隔行之前）。**旧取证下 `mixedSepIdx` 恒为 -1**（只有一行，正则 `/^─+$/` 不命中）→ 第三项判据从未生效。**子代理实测（修好取证后）**：它命中**恒为第 19 行**、内容是 80 个 `─` 的**状态区下方横线**（帧 chrome，`layout.ts` 的 `makeSep`），不是活动区分隔行 → 判据退化成 `2 < 19` 恒真，注释（`:523` 与 `:529`）双双失真；且 80×24 的 `auto` 排列实测为**左右分栏、根本没有活动区分隔行**（`layout.ts:748-749`），纵向排列时真分隔行整行 `trim()` 后以状态列内容或 `├`/`│` 开头、同样匹配不上 → 该判据在两种排列下都无法表达注释语义。另 `:527` 的 `sepBefore` 是**从未使用的死代码**。

## 决策

**D1｜自己写帧解析，还是复用模拟器？** → **复用 `tests/helpers/screenEmu.ts` 的 `ScreenEmu`**（ponytail 第 2 级：本仓已有实现）。不新写解析器、不动渲染器。理由：模拟器已覆盖 `2J` / 光标定位 / `K` 擦行 / 宽字符 / Nerd Font 代理对等真实语义；自写正则会重复这套逻辑且必然漏边界（探针的 `\x1b[6n`、`\x1b[J` 清屏尾等）。

**D2｜喂「最后一帧」还是整段输出？** → **喂整段 `smokeOut`**，末屏即最后一帧的真实屏幕。理由：渲染器每帧整屏覆盖重写，模拟器喂全量后留下的就是末屏；这样既避开「怎么切出最后一帧」的判断（现状那套 `2J` 切片本身已失效），也天然覆盖首帧 `2J`、`\x1b[J` 清尾与光标复位等既有序列。**子代理实测的四条污染路径全部无害**：① 宽度校准探针的字**根本不在 `smokeOut` 内**（捕获钩子在 `app.start()` 之后安装，而探针写入发生在 `start()` 内；即便在，也会被首帧 `2J` 整屏擦掉）；② 探针后的 `\x1b[1;1H` 只移光标不写字；③ `\x1b[J` 与模拟器 `J` 分支语义一致；④ smoke 非 TTY 下尺寸恒为 80×24，无 resize 路径。整段 557K 字符喂一次实测 **15.6ms**。

**D3｜尺寸与取值** → `const size = renderer.getSize()` → `new ScreenEmu(size.cols, size.rows)` → `mixedLines = Array.from({ length: size.rows }, (_, r) => emu.line(r))`。行文本用 `emu.line(r)`（自带行尾空白裁剪，等价旧代码「剥 SGR + includes」的语义）；注意 `line(r)` 是**整行**（左状态列 + 中历史 pane + 右活动 pane 同行），与旧按行取证口径一致。

**D4｜断言与验收** → 断言**收敛为「时间顺序 + 总结可见」**（`aT < aM < aTool < aN`、`aSum >= 0`），**删掉** `mixedSepIdx` 判据与死代码 `sepBefore`，注释按实测事实重写（80×24 `auto` = 左右分栏、无活动区分隔行）。理由（子代理实测，见调研 5）：原第三项判据在两种排列下都表达不了注释语义，修好取证后更退化为恒真——留着只会误导；「总结是否落在历史 pane」需按列判（`ScreenEmu.slice` 可用），**另开 BACKLOG 条目**，不在本条扩范围。验收 = `npm run demo -- --smoke` 的 `activity-mixed-ordered` 转绿且 **`SMOKE_FAIL n=0`**（子代理用 `tmp/` 副本端到端实测：`SMOKE_OK` + 退出码 0，其余 33 项全绿）。

**明确不做**：渲染器（`src/renderer/**`）与布局层；`smokeFrames` 捕获机制（`demo/main.ts:51-70`）；其它冒烟断言；`tests/**` 断言（本条不新增/改单测——修复对象就是冒烟脚本自身）；`demo/smokePty.mjs` 按 `\n` 切只用于证据打印（既有小瑕疵，不入本条）。

## 规划（计划改动文件清单）

1. `TUI/demo/main.ts`：import `ScreenEmu`（`../tests/helpers/screenEmu.ts`）；`activity-mixed-ordered` 场景的取证改成「整段输出喂模拟器 → 逐行 `emu.line(r)`」（替换 `:513-515`）；按 D4 删 `mixedSepIdx` / `sepBefore` 与第三项判据、重写注释。
1. `TUI/docs/BACKLOG.md`：条目标〔进行中〕→ 关闭时移除（余下条目按编号口径重编）；**追加一条新条目**——该冒烟场景只验行序、未验 pane 归属（「总结是否落在历史 pane」需按列判，可用 `ScreenEmu.slice`）。
1. 本追踪文档：建 → 关闭时移入 `TUI/docs/archived/`。

## 实现记录

- 2026-10-07：接取条目并标〔进行中〕；建本追踪文档（目标 / 调研 / 决策 / 规划）。
- **决策阶段子代理审阅（`f2292881`）：有异议 1 条（低）＋5 点实测通过**，意见**全部采纳**：
  1. `mixedSepIdx` 修好取证后命中的是**状态区下方全宽横线**（恒 19）→ 按建议 A 删判据 + 删死代码 `sepBefore` + 注释按实测重写，并把「pane 归属」**另开 BACKLOG 条目**；
  1. D2 措辞按实测更正（探针字节不在 `smokeOut` 内、即便在也被首帧 `2J` 擦除）；
  1. 补引更权威的同源先例（`src/renderer/index.ts:94-113` + `README.md:352` 的排查配方）。
- `demo/main.ts`：import `ScreenEmu`（注释写明同源用法）；取证改 `const smokeSize = renderer.getSize()` → `new ScreenEmu(smokeSize.cols, smokeSize.rows)` → `screen.feed(smokeOut)` → `emu.line(r)`；删 `mixedSepIdx` / `sepBefore` 与第三项判据，`ok(...)` 的 detail 去掉分隔行下标。
- `TUI/docs/BACKLOG.md`：条目完成清理（余下五条重编号为 1-5，两处「前置 = 条目 N」与来源注记同步左移）；**追加第 6 条**「冒烟只验行序、不再验 pane 归属」（20-30 min，P3）。
- 无其它文件改动：`src/**`（渲染器 / 布局 / 状态）与 `tests/**` 均未动。

## 测试与证据

- `TUI` 实测（2026-10-07，本机）：
  - `npm run check` ✓（`tsc --noEmit` 无输出）
  - `npm run build` ✓
  - `npm run test` ✓ **1332/1332 通过**（`fail 0`，与改动前基线一致）
  - `npm run demo -- --smoke` → **`SMOKE_PASS activity-mixed-ordered`** + **`SMOKE_OK sent=["!hello","x","rm tmp","等待审批的输入","中止示例"] interrupts=1`** + 退出码 **0** ⇒ **`SMOKE_FAIL n=0`**（改动前：`SMOKE_FAIL activity-mixed-ordered (idx=0,0,0,0,0,-1)` + `SMOKE_FAIL n=1`）。
- 子代理端到端复核（`tmp/` 副本，未改本仓）：按 D1-D3 实现后同样 `SMOKE_PASS` + `SMOKE_OK` + 退出码 0；整段 557K 字符喂模拟器 15.6ms；四条污染路径逐一排除；`demo → tests/helpers` 导入用项目同款 tsc 参数实测 exit 0。
- 反向证据（判据清理的依据）：修好取证后 `emu.line(19)` = 80 个 `─`（状态区下方横线），`mixedSepIdx` 恒 19 → `2 < 19` 恒真；80×24 `auto` 为左右分栏、无活动区分隔行（`layout.ts:748-749`）。
- 人工确认门禁：按用户在 goal 中的指示（跳过中间提交确认点、每条目一次收尾提交），以「`check` / `build` / `test` 全绿 + 冒烟 `SMOKE_FAIL n=0` + 子代理端到端复核」为凭据。

## 收尾

- 条目：按完成清理，已从 `TUI/docs/BACKLOG.md` 移除；余下五条按编号口径重编为 1-5（两处「前置 = 条目 N」与来源注记同步）；**新增第 6 条**（pane 归属按列断言，源自本次审阅发现）。
- 回写：无（`TUI/docs/SPEC.md` / `DESIGN.md` / `README.md` 未约定冒烟脚本的取证口径）。
- 本文件移入 `TUI/docs/archived/`。
- 遗留项：新增条目 6（按列断言总结落在历史 pane，20-30 min）；无代码遗留。
- 关闭日期：2026-10-07。
