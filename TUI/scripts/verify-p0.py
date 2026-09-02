#!/usr/bin/env python3
"""P0 会话生命周期真机验证（两阶段 PTY 驱动真实 dsh + dsh-toolset-tui profile）。

覆盖：
- RESUME_PASS：阶段 A 先创建 identified 目标会话（消息带 id、优雅退出落盘）；
  阶段 B 在 /session 面板中精确选中该会话 → Enter 切换（agents.resume，契约顺序
  dispose→resume）→ 发探测消息 → 断言探测文本落入【被恢复会话】（resume 为原会话
  继续语义）的 session.jsonl.zstd。Enter 未在超时内生效会自动重试一次。
- COPY_OSC_PASS：/copy 输出的 OSC52 序列（ESC ]52;c;...BEL）真实出现在 PTY 字节流。

用法：python3 TUI/scripts/verify-p0.py
退出码：0 = 全部 PASS；1 = 任一 FAIL；2 = 环境/脚本错误。
"""
from __future__ import annotations

import glob
import os
import re
import select
import signal
import subprocess
import sys
import time

PROFILE = os.environ.get("DSH_TUI_PROFILE", "dsh-toolset-tui")
CWDDIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # TUI/
SESSIONS_ROOT = os.path.expanduser("~/.dsh/sessions")
MODEL_ROUND = 20.0  # 阶段 A：消息发出后等模型消费一轮的预算
START_TIMEOUT = 90.0  # 阶段 B 等待 resume + 模型回复的预算

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-Z\\-_]")
OSC52_RE = re.compile(rb"\x1b]52;c;[A-Za-z0-9+/=]*\x07")
LIST_LINE_RE = re.compile(
    r">?\s*\d{2}-\d{2} \d{2}:\d{2}\s+((?:tui-)?[0-9a-f]{4,12})\b"
)
TITLE_RE = re.compile(r"历史会话（\d+）")


def strip_ansi(b: bytes) -> str:
    return ANSI_RE.sub("", b.decode("utf-8", "replace"))


def collect_sessions() -> dict[str, str]:
    """会话 id -> session.jsonl.zstd 绝对路径（两层容器扫描）。"""
    out: dict[str, str] = {}
    for p in glob.glob(os.path.join(SESSIONS_ROOT, "*", "*", "session.jsonl.zstd")):
        out[os.path.basename(os.path.dirname(p))] = p
    return out


def zstd_text(path: str) -> str:
    r = subprocess.run(["zstd", "-dc", path], capture_output=True, text=True)
    return r.stdout


class Pty:
    """minimal pty 容器：读字节累积 + 关键字等待。"""

    def __init__(self, argv: list[str], cwd: str):
        import fcntl
        import pty
        import struct
        import termios

        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.execvp(argv[0], argv)
        # 显式设置终端窗口尺寸（pty.fork 不继承时默认 0 会挤压 TUI 布局）
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        except OSError:
            pass
        self.pid = pid
        self.fd = fd
        self.raw = b""
        self.s = strip_ansi(self.raw)

    def pump(self, timeout: float = 0.3) -> None:
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if not r:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                break
            if not data:
                break
            self.raw += data
            self.s = strip_ansi(self.raw)

    def want(self, needle: str, timeout: float, poll: float = 0.15) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            self.pump(poll)
            if needle in self.s:
                return True
        return False

    def send(self, text: str) -> None:
        time.sleep(0.08)
        os.write(self.fd, text.encode("utf-8"))

    def send_key(self, esc: bytes) -> None:
        time.sleep(0.05)
        os.write(self.fd, esc)

    def close(self) -> None:
        try:
            os.kill(self.pid, signal.SIGTERM)
        except OSError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


def panel_rows(s: str) -> list[str]:
    """从 PTY 文本提取【当前面板】的可见会话行（以最后一次标题为准，忽略旧帧）。"""
    marks = list(TITLE_RE.finditer(s))
    if not marks:
        return []
    tail = s[marks[-1].end():]
    rows: list[str] = []
    # 列表行之间可能存在空行（面板 body 交替帧），仅非空且非列表行才是面板结束
    for line in tail.splitlines():
        if LIST_LINE_RE.search(line):
            rows.append(line)
        elif rows and line.strip():
            break  # 非空非列表内容（标题/按键提示/横线）→ 面板结束
    return rows


def panel_row_index(rows: list[str], prefix: str) -> int | None:
    """目标会话短前缀在面板可见行中的 row index（未含则 None）。"""
    for i, line in enumerate(rows):
        if prefix in line:
            return i
    return None


def run_tui_phase(
    seed: str,
    *,
    resume_target: str | None,
    do_copy: bool,
) -> tuple[str | None, list[str]]:
    """启动一次 TUI（可选 resume 到目标会话），发消息，收 OSC52。"""
    p = Pty(["dsh", "--profile", PROFILE], cwd=CWDDIR)
    diag: list[str] = []
    target_used: str | None = None
    try:
        if not p.want("Type a message", 25):
            return target_used, ["FAIL: TUI 未在 25s 内启动"]
        p.send_key(b"\x0c")
        p.pump(0.4)

        if resume_target:
            p.send("/session\r")
            if not p.want("历史会话（", 15):
                return target_used, diag + ["FAIL: /session 未打开面板"]
            p.pump(0.6)
            short = resume_target[:10]
            idx = panel_row_index(panel_rows(p.s), short)
            if idx is None:
                idx = panel_row_index(panel_rows(p.s), resume_target[:6])
            if idx is None:
                rows = panel_rows(p.s)[:3]
                return target_used, diag + [
                    f"FAIL: 面板中找不到目标 {resume_target}（rows={rows}）"
                ]
            for _ in range(idx):
                p.send_key(b"\x1b[B")
            p.pump(0.3)
            p.send("\r")
            if not p.want("已切换到会话", 20):
                # 加固：面板可能仍打开（Enter 未切走）——重试一次 Enter
                p.send("\r")
                if not p.want("已切换到会话", 25):
                    return target_used, diag + [
                        "FAIL: resume 未出现「已切换到会话」（尾部：\n" + p.s[-400:] + "\n)"
                    ]
            # resume 为原会话语义（resumeSessionId == 返回 agent.session.id），
            # 断言落盘目标即选中目标；不再依赖 adapter 诊断行
            target_used = resume_target
            p.pump(0.4)

        p.send(seed + "\r")

        # 等 seed 本地回显铺出（确认已发出）；阶段 B 期间周期性 /copy 直到捕获 OSC52
        start = time.time()
        echoes = False
        got_osc = False
        while time.time() - start < START_TIMEOUT:
            p.pump(0.4)
            if seed in p.s:
                echoes = True
            if do_copy and echoes:
                p.send("/copy\r")
                p.pump(0.5)
                if OSC52_RE.search(p.raw):
                    got_osc = True
                    break
            elif echoes and time.time() - start > MODEL_ROUND:
                break  # 阶段 A：消息已发出且等过一轮，足够落盘
        if do_copy and not got_osc:
            return target_used, diag + [
                "FAIL: 未捕获 /copy 的 OSC52（尾部：\n" + p.s[-500:] + "\n)"
            ]
        osc = "COPY_OSC_PASS" if got_osc else "COPY_OSC_FAIL"

        p.send("/quit\r")
        time.sleep(2.0)  # 优雅退出，让持久化 flush
    finally:
        p.close()
    return target_used, diag + [osc]


def print_recent_sessions(limit: int = 4) -> None:
    paths = sorted(
        glob.glob(os.path.join(SESSIONS_ROOT, "*", "*", "session.jsonl.zstd")),
        key=os.path.getmtime,
        reverse=True,
    )[:limit]
    for pth in paths:
        print(
            "   ",
            time.strftime("%H:%M:%S", time.localtime(os.path.getmtime(pth))),
            os.path.basename(os.path.dirname(os.path.dirname(pth))),
            os.path.basename(os.path.dirname(pth)),
        )


def main() -> int:
    before = collect_sessions()

    # --- 阶段 A：构建 identified 目标会话 ---
    try:
        seed = "p0-seed-" + str(int(time.time() * 1000))
    except Exception:
        seed = "p0-seed-fallback"
    _t, diag_a = run_tui_phase(seed, resume_target=None, do_copy=False)
    time.sleep(4)  # 落盘
    target_sid: str | None = None
    for sid, path in collect_sessions().items():
        if sid in before:
            continue
        try:
            if seed in zstd_text(path):
                target_sid = sid
                break
        except Exception:
            continue
    if target_sid is None:
        print("FAIL: 阶段 A seed 未落盘（TUI 消息未持久化）。诊断：")
        for line in diag_a:
            print("  " + line)
        print("  最近会话：")
        print_recent_sessions()
        return 1
    print(f"阶段 A：目标 identified 会话 = {target_sid}")

    # --- 阶段 B：resume 目标会话 + /copy ---
    try:
        probe = "p0-probe-" + str(int(time.time() * 1000))
    except Exception:
        probe = "p0-probe-fallback"
    resumed, diag_b = run_tui_phase(probe, resume_target=target_sid, do_copy=True)
    time.sleep(4)  # 落盘
    real_sid = resumed or target_sid
    probe_sid: str | None = None
    for sid, path in collect_sessions().items():
        try:
            if probe in zstd_text(path):
                probe_sid = sid
                break
        except Exception:
            continue

    resume_pass = False
    if probe_sid is None:
        print("FAIL: 探测文本未出现在任何会话 JSONL。最近会话：")
        print_recent_sessions()
    elif probe_sid == real_sid:
        resume_pass = True
        print(f"RESUME_OK：探测文本落入续写会话 {probe_sid}（目标 {target_sid}）")
    else:
        print(
            f"FAIL: 探测文本落入 {probe_sid}，adapter 声明的续写会话为 {real_sid}"
        )

    copy_pass = False
    for line in diag_b:
        if line == "COPY_OSC_PASS":
            copy_pass = True
        if line.startswith(("FAIL", "COPY_OSC")):
            print("  " + line)

    print("RESUME_PASS" if resume_pass else "RESUME_FAIL")
    print("COPY_OSC_PASS" if copy_pass else "COPY_OSC_FAIL")
    return 0 if (resume_pass and copy_pass) else 1


if __name__ == "__main__":
    sys.exit(main())
