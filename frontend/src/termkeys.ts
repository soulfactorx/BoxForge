// What a terminal key sends, as xterm (and so most terminals) sends it: for
// the extra keys a phone's keyboard lacks (arrows, Tab, Esc, F1–F12…), and
// Ctrl / Alt held for the next key, from the bar or the phone's keyboard.

export interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export const noMods: Mods = { ctrl: false, alt: false, shift: false };

// The parameter a modified key carries: 1 + shift 1 + alt 2 + ctrl 4.
const param = (m: Mods) => 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);
const any = (m: Mods) => m.ctrl || m.alt || m.shift;

const letters: Record<string, string> = { Up: "A", Down: "B", Right: "C", Left: "D", Home: "H", End: "F" };
const tilde: Record<string, number> = { Ins: 2, Del: 3, PgUp: 5, PgDn: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const ss3: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };

/** One typed character with Ctrl and Alt held: Ctrl+C is 0x03, Alt+x is Esc x. */
export function withMods(data: string, m: Mods): string {
  if (data.length !== 1 || (!m.ctrl && !m.alt)) return data;
  let c = data;
  if (m.ctrl) {
    const code = c.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) c = String.fromCharCode(code - 64); // @ A–Z [ \ ] ^ _
    else if (c === " " || c === "2") c = "\x00";
    else if (c === "?" || c === "8") c = "\x7f";
    else if (c === "3") c = "\x1b";
    else if (c === "4") c = "\x1c";
    else if (c === "5") c = "\x1d";
    else if (c === "6") c = "\x1e";
    else if (c === "7" || c === "/") c = "\x1f";
  }
  return m.alt ? "\x1b" + c : c;
}

/**
 * The bytes a key sends. appCursor: the program asked for application
 * cursor keys (full-screen programs such as vim and less do), where the
 * arrows and Home/End are sent as Esc O x.
 */
export function keySeq(key: string, m: Mods, appCursor: boolean): string {
  if (key === "Esc") return m.alt ? "\x1b\x1b" : "\x1b";
  if (key === "Tab") return m.shift ? "\x1b[Z" : m.alt ? "\x1b\t" : "\t";
  if (key === "Enter") return m.alt ? "\x1b\r" : "\r";
  if (key === "Backspace") return m.ctrl ? "\x08" : m.alt ? "\x1b\x7f" : "\x7f";
  if (letters[key]) {
    const l = letters[key];
    if (any(m)) return `\x1b[1;${param(m)}${l}`;
    return (appCursor ? "\x1bO" : "\x1b[") + l;
  }
  if (tilde[key]) return any(m) ? `\x1b[${tilde[key]};${param(m)}~` : `\x1b[${tilde[key]}~`;
  if (ss3[key]) return any(m) ? `\x1b[1;${param(m)}${ss3[key]}` : `\x1bO${ss3[key]}`;
  return withMods(key, m); // a character: | ~ / - …
}

/**
 * A phone's keyboard, followed by what is in xterm's input box rather than
 * by its keyboard events (as soulfactorx/pi-desktop's terminal does).
 *
 * Samsung's and Google's keyboards compose even English a word at a time,
 * and xterm sends only what a composition ends with: what is typed shows in
 * a line under the terminal and reaches the program a word later (Korean
 * came out with spaces between its letters). The order and contents of
 * those events differ from keyboard to keyboard; the box's value doesn't
 * lie. So each time it changes it is compared with the last: letters gone
 * are sent as DEL, letters new are sent at once. A Korean letter being made
 * (ㅎ→하→한) is written and written again as it changes.
 *
 * A letter sent with Ctrl or Alt held went to the program as a control
 * key: marked used, so the keyboard taking it back later sends no DEL.
 */
export class InputMirror {
  private value = "";
  private plain: boolean[] = [];

  /** The box's new value: how many DELs to send, and what is new. */
  update(next: string): { deletes: number; add: string } {
    const chars = Array.from(next);
    const prev = Array.from(this.value);
    let common = 0;
    while (common < prev.length && common < chars.length && prev[common] === chars[common]) common++;
    const deletes = this.plain.slice(common).filter(Boolean).length;
    const add = chars.slice(common).join("");
    this.value = next;
    this.plain = [...this.plain.slice(0, common), ...chars.slice(common).map(() => true)];
    return { deletes, add };
  }

  /** The first letter of what update just gave was sent with Ctrl or Alt. */
  consumeFirstAdded(addLength: number): void {
    const at = this.plain.length - addLength;
    if (addLength > 0 && at >= 0) this.plain[at] = false;
  }

  /** The box was emptied from outside (xterm does on Enter, Ctrl+C, losing focus). */
  reset(): void {
    this.value = "";
    this.plain = [];
  }
}

/** A phone keyboard's new line is the terminal's Enter. */
export const toTerminalText = (text: string) => text.replace(/\r?\n/g, "\r");

/** Letters only, no control keys. */
export const isPrintable = (data: string) => data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);

/** A real key that makes one letter (a Bluetooth keyboard): not a phone keyboard's 229. */
export const isCharacterKey = (e: KeyboardEvent) => e.keyCode !== 229 && Array.from(e.key).length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
