// renderer/input.ts — stdin 原始字节 → KeyEvent 解码
//
// 隐藏大头：ANSI 转义序列解析。流式状态机处理跨 chunk 分片序列
// （CSI/SS3/UTF-8 多字节）与 bracketed paste。纯逻辑，无 IO，便于单测。

export interface KeyEvent {
  name: string; // 字符本身 / 'up' / 'down' / 'enter' / 'tab' / 'escape' / 'paste' …
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** 仅 'paste' 事件携带：被粘贴的完整文本 */
  text?: string;
}

const ESC = 0x1b;
const NEED_MORE = Symbol("need-more");
const CONSUMED = Symbol("consumed"); // 已消费但无输出 → 继续循环

type StepResult = KeyEvent | typeof NEED_MORE | typeof CONSUMED | undefined; // undefined = 无可消费字节

export class KeyDecoder {
  /** 待消费字节队列（普通模式） */
  private pending: number[] = [];
  /** bracketed paste 累积原始字节；null = 不在 paste 模式 */
  private pasteRaw: number[] | null = null;

  feed(bytes: ArrayLike<number> | null | undefined): KeyEvent[] {
    if (bytes) this.pending.push(...Array.from(bytes));
    const out: KeyEvent[] = [];
    for (;;) {
      const step = this.step();
      if (step === NEED_MORE || step === undefined) break;
      if (step === CONSUMED) continue;
      out.push(step);
    }
    return out;
  }

  /** 消费队首一个完整输入；不足时返回 NEED_MORE（保持待处理状态，等下次 feed） */
  private step(): StepResult {
    if (this.pasteRaw !== null) return this.stepPaste();
    const b = this.pending[0];
    if (b === undefined) return undefined;

    if (b === ESC) return this.stepEscape();

    if (b < 0x20 || b === 0x7f) {
      // CR LF（\r\n）合并为一个 enter，避免双触发（Linux 终端典型发送 \r）
      if (b === 0x0d && this.pending[1] === 0x0a) {
        this.pending.splice(0, 2);
        return { name: "enter", ctrl: false, meta: false, shift: false };
      }
      this.pending.shift();
      return decodeControl(b) ?? undefined;
    }
    // 可打印字符 / UTF-8 多字节
    const cp = decodeCodepoint(this.pending);
    if (!cp) return NEED_MORE;
    this.pending.splice(0, cp.len);
    return { name: cp.ch, ctrl: false, meta: false, shift: false };
  }

  private stepPaste(): StepResult {
    const raw = this.pasteRaw!;
    // 把本段 pending 并入 paste 累积
    if (this.pending.length) {
      raw.push(...this.pending);
      this.pending.length = 0;
    }
    // 在累积中查找结束标记 ESC [ 201 ~
    const marker = [ESC, 0x5b, 0x32, 0x30, 0x31, 0x7e];
    let found = -1;
    outer: for (let i = 0; i + marker.length <= raw.length; i++) {
      for (let k = 0; k < marker.length; k++) {
        if (raw[i + k] !== marker[k]) continue outer;
      }
      found = i;
      break;
    }
    if (found === -1) return NEED_MORE; // 仍在粘贴中
    const text = new TextDecoder("utf-8").decode(
      Uint8Array.from(raw.slice(0, found)),
    );
    this.pasteRaw = null;
    this.pending.push(...raw.slice(found + marker.length));
    return { name: "paste", ctrl: false, meta: false, shift: false, text };
  }

  private stepEscape(): StepResult {
    const second = this.pending[1];
    if (second === undefined) {
      // ESC 后无更多字节：视为独立 ESC 键
      this.pending.shift();
      return { name: "escape", ctrl: false, meta: false, shift: false };
    }
    if (second === 0x5b /* '[' */) return this.stepCsi();
    if (second === 0x4f /* 'O' */) return this.stepSs3();
    // ESC CR / ESC LF = Alt+Enter（Alt 前缀 + 回车）：合并为单个 meta+enter
    if (second === 0x0d || second === 0x0a) {
      this.pending.splice(0, 2);
      return { name: "enter", ctrl: false, meta: true, shift: false };
    }
    if (second >= 0x20 && second < 0x7f) {
      this.pending.splice(0, 2);
      return {
        name: String.fromCharCode(second),
        ctrl: false,
        meta: true,
        shift: false,
      };
    }
    // ESC + 控制字节：双 ESC 等 → 只发独立 ESC，控制字节留到下一轮
    this.pending.shift();
    return { name: "escape", ctrl: false, meta: false, shift: false };
  }

  private stepCsi(): StepResult {
    const p = this.pending;
    // 找到终态字节（0x40-0x7e）
    let finalIdx = -1;
    for (let j = 2; j < p.length; j++) {
      const c = p[j]!;
      if (c >= 0x40 && c <= 0x7e) {
        finalIdx = j;
        break;
      }
    }
    if (finalIdx === -1) return NEED_MORE;
    const params = p.slice(2, finalIdx); // 参数（不含终态）
    const fin = p[finalIdx]!;
    const seqLen = finalIdx + 1;

    // bracketed paste 起始/结束
    if (fin === 0x7e) {
      const digits = String.fromCharCode(...params);
      if (digits === "200") {
        this.pending.splice(0, seqLen);
        this.pasteRaw = [];
        return CONSUMED; // 进入 paste 模式，继续消费本 chunk 剩余字节
      }
      if (digits === "201") {
        this.pending.splice(0, seqLen);
        return CONSUMED; // 孤立的 paste-end 标记，忽略
      }
      // '~' 型功能键
      const tilde = {
        "1": "home",
        "2": "insert",
        "3": "delete",
        "4": "end",
        "5": "pageup",
        "6": "pagedown",
      } as const;
      const key = tilde[digits.split(";")[0] as keyof typeof tilde];
      this.pending.splice(0, seqLen);
      return key
        ? { name: key, ctrl: false, meta: false, shift: false }
        : undefined;
    }
    // 字母终态：光标键 + 可选修饰符
    const modifiers = params.includes(0x3b);
    let ctrl = false;
    let meta = false;
    let shift = false;
    if (modifiers) {
      const sepAt = params.lastIndexOf(0x3b);
      const modCode = parseDigitParam(params.slice(sepAt + 1));
      shift = (modCode & 1) !== 0;
      meta = (modCode & 2) !== 0;
      ctrl = (modCode & 4) !== 0;
      void sepAt;
    }
    const base = CSI_LETTERS[fin];
    this.pending.splice(0, seqLen);
    if (!base) return undefined;
    return { name: base, ctrl, meta, shift };
  }

  private stepSs3(): StepResult {
    const p = this.pending;
    const third = p[2];
    if (third === undefined) return NEED_MORE;
    const name = SS3_NAMES[third];
    this.pending.splice(0, 3);
    return name ? { name, ctrl: false, meta: false, shift: false } : undefined;
  }
}

// ESC [ <letter> 光标键
const CSI_LETTERS: Record<number, string> = {
  65: "up",
  66: "down",
  67: "right",
  68: "left",
  72: "home",
  70: "end",
  50: "home", // 2
  49: "end", // 1
};

// ESC O <letter>（应用模式光标键）
const SS3_NAMES: Record<number, string> = {
  65: "up",
  66: "down",
  67: "right",
  68: "left",
  72: "home",
  70: "end",
};

function parseDigitParam(bytes: number[]): number {
  let n = 0;
  for (const b of bytes) {
    if (b >= 0x30 && b <= 0x39) n = n * 10 + (b - 0x30);
  }
  return n;
}

/** 解码一个控制字节（回车/退格/Tab/Ctrl+字母 等） */
function decodeControl(b: number): KeyEvent | null {
  switch (b) {
    case 0x09:
      return { name: "tab", ctrl: false, meta: false, shift: false };
    case 0x0d: // CR
    case 0x0a: // LF
      return { name: "enter", ctrl: false, meta: false, shift: false };
    case 0x7f: // DEL
    case 0x08: // backspace
      return { name: "backspace", ctrl: false, meta: false, shift: false };
    case 0x00:
      return { name: "space", ctrl: true, meta: false, shift: false }; // Ctrl+Space
    default:
      if (b >= 1 && b <= 26)
        return {
          name: String.fromCharCode(0x60 + b),
          ctrl: true,
          meta: false,
          shift: false,
        };
      return null; // 其他控制字节丢弃
  }
}

/** 从队列头部解码一个 UTF-8 码点；字节不足返回 null */
function decodeCodepoint(buf: number[]): { ch: string; len: number } | null {
  const b0 = buf[0];
  if (b0 === undefined) return null;
  let len = 1;
  if (b0 < 0x80) return { ch: String.fromCharCode(b0), len: 1 };
  if (b0 >= 0xc0 && b0 <= 0xdf) len = 2;
  else if (b0 >= 0xe0 && b0 <= 0xef) len = 3;
  else if (b0 >= 0xf0 && b0 <= 0xf7) len = 4;
  else return { ch: "", len: 1 }; // 非法起始字节 → 跳过
  if (buf.length < len) return null;
  const bytes = buf.slice(0, len);
  const str = new TextDecoder("utf-8", { fatal: false }).decode(
    Uint8Array.from(bytes),
  );
  return { ch: str, len };
}
