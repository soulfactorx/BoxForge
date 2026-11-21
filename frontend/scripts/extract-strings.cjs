// Lists every Korean text of the UI, for translation: the JSX text, the
// string literals and the template literals of frontend/src, and the
// Korean strings the Go side sends to the page.
//
//   node scripts/extract-strings.cjs            # prints what en.json lacks
//   node scripts/extract-strings.cjs --all      # prints every key
//
// A key is the text as it reaches the page. What is filled in at run time
// is written {0}, {1}, … in the order it appears.
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const hangul = /[가-힣]/;
const keys = new Set();
const add = (s) => {
  s = s.replace(/\s+/g, " ").trim();
  if (hangul.test(s)) keys.add(s);
};

// JSX joins the lines of a text, trimming each: as React does.
const jsxText = (raw) =>
  raw
    .split(/\r?\n/)
    .map((l, i, all) => (all.length === 1 ? l : i === 0 ? l.trimEnd() : i === all.length - 1 ? l.trimStart() : l.trim()))
    .filter((l) => l !== "")
    .join(" ");

const src = path.join(__dirname, "..", "src");
for (const f of fs.readdirSync(src)) {
  if (!/\.tsx?$/.test(f)) continue;
  const sf = ts.createSourceFile(f, fs.readFileSync(path.join(src, f), "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const walk = (n) => {
    if (ts.isJsxText(n)) add(jsxText(n.text));
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) add(n.text);
    else if (ts.isTemplateExpression(n)) {
      let s = n.head.text;
      n.templateSpans.forEach((span, i) => (s += `{${i}}` + span.literal.text));
      add(s);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
}

// Go: string literals with Korean in them; %s and its kind become {n}.
const goDir = path.join(__dirname, "..", "..");
const goFiles = [];
const scan = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", "frontend", ".git", "build", "docs"].includes(e.name)) scan(p);
    } else if (e.name.endsWith(".go") && !e.name.endsWith("_test.go")) goFiles.push(p);
  }
};
scan(goDir);
for (const f of goFiles) {
  if (f.includes(path.join("cmd", "boxforge-server"))) continue; // what the server prints on its console
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    let s = m[1];
    if (!hangul.test(s)) continue;
    try {
      s = JSON.parse('"' + s + '"');
    } catch {
      continue;
    }
    let i = 0;
    add(s.replace(/%[-+# 0]*\d*(?:\.\d+)?[sdvqwf]/g, () => `{${i++}}`));
  }
}

const file = path.join(src, "i18n", "en.json");
const have = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const all = [...keys].sort();
const out = process.argv.includes("--all") ? all : all.filter((k) => !(k in have));
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
if (!process.argv.includes("--all")) process.stderr.write(`${all.length} texts, ${out.length} without a translation, ${Object.keys(have).filter((k) => !keys.has(k)).length} translations no longer used\n`);
