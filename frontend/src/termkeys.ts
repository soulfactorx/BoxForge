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
