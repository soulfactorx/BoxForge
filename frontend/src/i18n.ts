// English for the UI.
//
// The UI is written in Korean, in the components themselves. Rather than
// thread every text through a lookup, the page is translated as it is
// drawn: a table (i18n/en.json, made with scripts/extract-strings.cjs)
// maps each Korean text to its English, and an observer rewrites the
// text nodes and the labels of whatever React puts on the page. React is
// not disturbed: it compares what it wants with what it last asked for,
// not with what the page shows.
import table from "./i18n/en.json";

export type Lang = "ko" | "en";
const KEY = "boxforge.lang";

/** The choice kept in this browser: a language, or "" to follow the PC. */
export function chosen(): Lang | "" {
  try {
    const v = localStorage.getItem(KEY);
    return v === "ko" || v === "en" ? v : "";
  } catch {
    return "";
  }
}

/** The language in use. */
export function lang(): Lang {
  return chosen() || (navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en");
}

/** Keeps the choice and shows the page again in it. */
export function choose(v: Lang | "") {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    // no storage: the choice lasts until the page is closed
  }
  location.reload();
}

const hangul = /[\uac00-\ud7a3]/;
const exact = new Map<string, string>();
// Texts with something filled in ({0}, {1}…): matched as patterns.
const patterns: { re: RegExp; greedy: RegExp; to: string; order: number[]; weight: number }[] = [];
// Pieces to look for inside a text that matches nothing whole.
let pieces: [string, string][] = [];

for (const [ko, en] of Object.entries(table as Record<string, string>)) {
  if (!/\{\d+\}/.test(ko)) {
    exact.set(ko, en);
    continue;
  }
  const order: number[] = [];
  const source = ko
    .split(/(\{\d+\})/)
    .map((part) => {
      const m = /^\{(\d+)\}$/.exec(part);
      if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
      order.push(+m[1]);
      return "([\\s\\S]*?)";
    })
    .join("");
  patterns.push({ re: new RegExp("^" + source + "$"), greedy: new RegExp("^" + source.split("*?").join("*") + "$"), to: en, order, weight: ko.replace(/\{\d+\}/g, "").length });
}
// The pattern with the most fixed text is the most particular: tried first.
patterns.sort((a, b) => b.weight - a.weight);
pieces = [...exact.entries()].filter(([ko]) => ko.length >= 2).sort((a, b) => b[0].length - a[0].length);

const done = new Map<string, string>();

/** One text in English; itself when there is nothing to say for it. */
export function translate(text: string): string {
  if (!hangul.test(text)) return text;
  const hit = done.get(text);
  if (hit !== undefined) return hit;
  const lead = /^\s*/.exec(text)![0];
  const tail = /\s*$/.exec(text)![0];
  const core = text.slice(lead.length, text.length - tail.length || undefined).replace(/\s+/g, " ");
  let out = exact.get(core);
  if (out === undefined) {
    for (const p of patterns) {
      if (!p.re.test(core)) continue;
      // What was filled in may be a text of the UI itself. Where two
      // values stand side by side the split between them is a guess: the
      // one that leaves the least Korean is taken.
      const fill = (re: RegExp) => {
        const m = re.exec(core)!;
        const filled: Record<number, string> = {};
        p.order.forEach((n, i) => (filled[n] = translate(m[i + 1])));
        return p.to.replace(/\{(\d+)\}/g, (_, n) => filled[+n] ?? "");
      };
      const count = (t: string) => (t.match(/[\uac00-\ud7a3]/g) ?? []).length;
      out = fill(p.re);
      if (count(out) > 0 && p.order.length > 1) {
        const other = fill(p.greedy);
        if (count(other) < count(out)) out = other;
      }
      break;
    }
  }
  if (out === undefined) {
    // Put together by the code from smaller texts: each is looked for.
    out = core;
    for (const [ko, en] of pieces) {
      if (out.includes(ko)) out = out.split(ko).join(en);
      if (!hangul.test(out)) break;
    }
  }
  const result = lead + out + tail;
  if (done.size < 20000) done.set(text, result);
  return result;
}

const LABELS = ["placeholder", "title", "aria-label", "alt"];
// What the user or a program wrote is theirs: terminals, logs, editors.
const SKIP = ".xterm, textarea, pre.log-box, [data-keep-text]";

function textNode(n: Text) {
  const v = n.nodeValue;
  if (!v || !hangul.test(v)) return;
  if (n.parentElement?.closest(SKIP)) return;
  const t = translate(v);
  if (t !== v) n.nodeValue = t;
}

function element(el: Element) {
  for (const a of LABELS) {
    const v = el.getAttribute(a);
    if (v && hangul.test(v)) {
      const t = translate(v);
      if (t !== v) el.setAttribute(a, t);
    }
  }
}

function sweep(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return textNode(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (el.matches(SKIP)) return;
  element(el);
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) textNode(n as Text);
    else element(n as Element);
  }
}

/** Starts showing the page in the language in use. */
export function start() {
  document.documentElement.lang = lang();
  if (lang() !== "en") return;
  sweep(document.body);
  new MutationObserver((changes) => {
    for (const c of changes) {
      if (c.type === "characterData") textNode(c.target as Text);
      else if (c.type === "attributes") element(c.target as Element);
      else c.addedNodes.forEach(sweep);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: LABELS });
}
