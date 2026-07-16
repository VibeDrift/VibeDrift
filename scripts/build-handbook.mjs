#!/usr/bin/env node
/**
 * build-handbook.mjs
 *
 * Compiles the markdown chapters in docs/handbook/ into a single portable,
 * self-contained HTML developer handbook. Zero dependencies: runs with any
 * Node >= 18, no npm install needed.
 *
 * Usage:   node scripts/build-handbook.mjs
 * Config:  docs/handbook/handbook.json  (title, subtitle, badge, output, ...)
 * Source:  docs/handbook/NN-*.md        (chapters, compiled in filename order)
 * Images:  docs/handbook/assets/*.svg   (inlined into the HTML at build time)
 *
 * The generated HTML is a build artifact of the markdown sources. To update
 * the handbook, edit the chapter markdown (or add a new NN-chapter.md) and
 * re-run this script. Never edit the generated HTML by hand.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "docs", "handbook");
const ASSET_DIR = path.join(SRC_DIR, "assets");

// ---------------------------------------------------------------------------
// Config + chapter collection
// ---------------------------------------------------------------------------

const config = JSON.parse(
  fs.readFileSync(path.join(SRC_DIR, "handbook.json"), "utf8"),
);

let version = config.version ?? "";
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  version = pkg.version ?? version;
} catch {
  /* python repo: no package.json, use config.version */
}

const chapterFiles = fs
  .readdirSync(SRC_DIR)
  .filter((f) => /^\d{2}-.*\.md$/.test(f))
  .sort();

if (chapterFiles.length === 0) {
  console.error(`No chapter files (NN-*.md) found in ${SRC_DIR}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const usedSlugs = new Map();
function slugify(text) {
  let slug = text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  if (!slug) slug = "section";
  const n = usedSlugs.get(slug) ?? 0;
  usedSlugs.set(slug, n + 1);
  return n === 0 ? slug : `${slug}-${n}`;
}

// ---------------------------------------------------------------------------
// Syntax highlighting (small, regex-based, escape-as-we-emit)
// ---------------------------------------------------------------------------

const KEYWORDS = {
  ts: "abstract any as async await boolean break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let map namespace never new null number object of package private protected public readonly return satisfies set static string super switch this throw true try type typeof undefined unique unknown var void while with yield",
  js: "async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield",
  python:
    "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map nil package range return select struct switch type var true false iota bool byte error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 usize isize bool str String Option Some None Result Ok Err Vec Box",
  bash: "if then else elif fi for while do done case esac function in echo exit return local export set shift source true false",
  sql: "select from where insert into values update set delete create table alter drop index primary key foreign references not null unique default on conflict returning join left right inner outer group by order limit offset as and or in is boolean integer bigint text timestamptz uuid jsonb serial",
  json: "true false null",
  yaml: "true false null",
  toml: "true false",
};
KEYWORDS.tsx = KEYWORDS.ts;
KEYWORDS.typescript = KEYWORDS.ts;
KEYWORDS.javascript = KEYWORDS.js;
KEYWORDS.py = KEYWORDS.python;
KEYWORDS.sh = KEYWORDS.bash;
KEYWORDS.shell = KEYWORDS.bash;

function highlight(code, lang) {
  const kw = KEYWORDS[lang];
  const parts = [];
  // token alternatives, ordered: comments, strings, then the rest as plain
  const alts = [];
  if (["ts", "tsx", "typescript", "js", "javascript", "go", "rust"].includes(lang)) {
    alts.push(String.raw`\/\*[\s\S]*?\*\/`, String.raw`\/\/[^\n]*`);
    alts.push("`(?:\\\\[\\s\\S]|[^`\\\\])*`");
  }
  if (["python", "py", "bash", "sh", "shell", "yaml", "toml"].includes(lang)) {
    alts.push(String.raw`#[^\n]*`);
  }
  if (["python", "py"].includes(lang)) {
    alts.push(String.raw`"""[\s\S]*?"""`, String.raw`'''[\s\S]*?'''`);
  }
  if (lang === "sql") alts.push(String.raw`--[^\n]*`);
  alts.push(String.raw`"(?:\\[\s\S]|[^"\\\n])*"`, String.raw`'(?:\\[\s\S]|[^'\\\n])*'`);
  const master = new RegExp(alts.join("|"), "g");

  let last = 0;
  let m;
  const plainOut = (chunk) => {
    let out = escapeHtml(chunk);
    // keywords first: the inserted span markup contains no digits, so the
    // number pass below cannot corrupt it (the reverse order would).
    if (kw) {
      const set = new Set(kw.split(/\s+/));
      out = out.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (w) =>
        set.has(lang === "sql" ? w.toLowerCase() : w)
          ? `<span class="tk-k">${w}</span>`
          : w,
      );
    }
    out = out.replace(
      /\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/g,
      '<span class="tk-n">$1</span>',
    );
    return out;
  };
  while ((m = master.exec(code)) !== null) {
    if (m.index > last) parts.push(plainOut(code.slice(last, m.index)));
    const tok = m[0];
    const isComment =
      tok.startsWith("//") ||
      tok.startsWith("/*") ||
      tok.startsWith("#") ||
      tok.startsWith("--") ||
      tok.startsWith('"""') ||
      tok.startsWith("'''");
    parts.push(
      `<span class="${isComment ? "tk-c" : "tk-s"}">${escapeHtml(tok)}</span>`,
    );
    last = m.index + tok.length;
  }
  if (last < code.length) parts.push(plainOut(code.slice(last)));
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Inline markdown (bold, italic, code, links, images)
// ---------------------------------------------------------------------------

function renderInline(text) {
  const codeSpans = [];
  // protect code spans first
  let s = text.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00${codeSpans.length - 1}\x00`;
  });
  s = escapeHtml(s);
  // images (svg images are inlined at block level; inline ones become data refs)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => inlineImage(alt, src));
  // links
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, label, href) =>
      `<a href="${href}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ""}>${label}</a>`,
  );
  // bold, italic, strikethrough
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // restore code spans
  s = s.replace(/\x00(\d+)\x00/g, (_, i) => codeSpans[Number(i)]);
  return s;
}

function inlineImage(alt, src) {
  const file = path.join(SRC_DIR, src);
  if (src.endsWith(".svg") && fs.existsSync(file)) {
    const svg = fs.readFileSync(file, "utf8").replace(/<\?xml[^>]*\?>\s*/, "");
    return `<figure class="diagram">${svg}${alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : ""}</figure>`;
  }
  if (fs.existsSync(file)) {
    const ext = path.extname(file).slice(1);
    const b64 = fs.readFileSync(file).toString("base64");
    return `<img src="data:image/${ext};base64,${b64}" alt="${escapeHtml(alt)}">`;
  }
  console.warn(`  warn: image not found: ${src}`);
  return `<em>[missing image: ${escapeHtml(alt || src)}]</em>`;
}

// ---------------------------------------------------------------------------
// Block-level markdown renderer
// ---------------------------------------------------------------------------

const ADMONITIONS = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };

function renderMarkdown(md, headings, chapterSlug) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // blank
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1].toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      const code = buf.join("\n");
      if (lang === "svg" || lang === "raw") {
        out.push(`<figure class="diagram">${code}</figure>`);
      } else {
        out.push(
          `<div class="codeblock">${lang ? `<span class="codelang">${lang}</span>` : ""}<pre><code>${highlight(code, lang)}</code></pre></div>`,
        );
      }
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const slug = level === 1 ? chapterSlug : slugify(text);
      if (level <= 3) headings.push({ level, text, slug });
      out.push(
        `<h${level} id="${slug}">${renderInline(text)}<a class="anchor" href="#${slug}" aria-label="link">#</a></h${level}>`,
      );
      i++;
      continue;
    }

    // hr
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // blockquote / admonition
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const adMatch = buf[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/);
      const inner = renderMarkdown(
        (adMatch ? buf.slice(1) : buf).join("\n"),
        [],
        chapterSlug,
      );
      if (adMatch) {
        const kind = adMatch[1];
        out.push(
          `<div class="admonition ad-${kind.toLowerCase()}"><div class="ad-title">${ADMONITIONS[kind]}</div>${inner}</div>`,
        );
      } else {
        out.push(`<blockquote>${inner}</blockquote>`);
      }
      continue;
    }

    // table
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])
    ) {
      const splitRow = (row) =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());
      const headCells = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headCells.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      out.push(`<div class="tablewrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    // list (ordered or unordered, with nesting by 2+ spaces)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length && (/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        items.push(lines[i]);
        i++;
      }
      out.push(renderList(items, chapterSlug));
      continue;
    }

    // raw HTML block (e.g. hand-placed <svg> or <div>)
    if (/^\s*<\/?[a-zA-Z]/.test(line)) {
      const buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push(buf.join("\n"));
      continue;
    }

    // paragraph
    {
      const buf = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^(#{1,6})\s/.test(lines[i]) &&
        !/^```/.test(lines[i]) &&
        !/^\s*>/.test(lines[i]) &&
        !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p>${renderInline(buf.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

function renderList(rawItems, chapterSlug) {
  // parse items with indentation → tree
  const parsed = [];
  for (const raw of rawItems) {
    const m = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (m) {
      parsed.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
    } else if (parsed.length) {
      parsed[parsed.length - 1].text += " " + raw.trim();
    }
  }
  function build(items, depth) {
    if (!items.length) return "";
    const baseIndent = items[0].indent;
    const ordered = items[0].ordered;
    let html = ordered ? "<ol>" : "<ul>";
    let k = 0;
    while (k < items.length) {
      const item = items[k];
      const children = [];
      let j = k + 1;
      while (j < items.length && items[j].indent > baseIndent) {
        children.push(items[j]);
        j++;
      }
      html += `<li>${renderInline(item.text)}${build(children, depth + 1)}</li>`;
      k = j;
    }
    html += ordered ? "</ol>" : "</ul>";
    return html;
  }
  return build(parsed, 0);
}

// ---------------------------------------------------------------------------
// Assemble chapters
// ---------------------------------------------------------------------------

const chapters = [];
for (const file of chapterFiles) {
  const md = fs.readFileSync(path.join(SRC_DIR, file), "utf8");
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : file;
  const chapterSlug = slugify(title);
  const headings = [];
  const html = renderMarkdown(md, headings, chapterSlug);
  chapters.push({ file, title, slug: chapterSlug, headings, html });
  console.log(`  compiled ${file} (${headings.length} headings)`);
}

const generatedOn = new Date().toISOString().slice(0, 10);

const sidebar = chapters
  .map((ch) => {
    const subs = ch.headings
      .filter((hd) => hd.level === 2)
      .map(
        (hd) =>
          `<a class="nav-h2" href="#${hd.slug}" data-target="${hd.slug}">${escapeHtml(hd.text)}</a>`,
      )
      .join("");
    return `<div class="nav-chapter"><a class="nav-h1" href="#${ch.slug}" data-target="${ch.slug}">${escapeHtml(ch.title)}</a>${subs}</div>`;
  })
  .join("\n");

const content = chapters
  .map(
    (ch) =>
      `<section class="chapter" data-chapter="${ch.slug}">\n${ch.html}\n<div class="chapter-src">Edit this chapter: <code>docs/handbook/${ch.file}</code>, then rebuild with <code>node scripts/build-handbook.mjs</code></div>\n</section>`,
  )
  .join("\n");

const confidentialBanner = config.confidential
  ? `<div class="confidential">CONFIDENTIAL. Internal VibeDrift engineering documentation. Do not distribute outside the team.</div>`
  : "";

// Optional head metadata. Defaults keep an internal handbook private (noindex,
// no canonical); a public handbook served on the web sets these in its
// handbook.json so search engines index the canonical URL, not this file.
const metaTags = [
  config.noindex ? '<meta name="robots" content="noindex">' : "",
  config.description
    ? `<meta name="description" content="${escapeHtml(config.description)}">`
    : "",
  config.canonical
    ? `<link rel="canonical" href="${escapeHtml(config.canonical)}">`
    : "",
]
  .filter(Boolean)
  .join("\n");

// When homeUrl is set, the sidebar title links back to the site (useful when
// the handbook is served standalone, with no site chrome around it).
const brandTitle = config.homeUrl
  ? `<a class="t" href="${escapeHtml(config.homeUrl)}">${escapeHtml(config.title)}</a>`
  : `<span class="t">${escapeHtml(config.title)}</span>`;

// ---------------------------------------------------------------------------
// Final HTML
// ---------------------------------------------------------------------------

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${metaTags}
<title>${escapeHtml(config.title)}</title>
<style>
:root {
  --bg: #0b0d10; --s1: #12151a; --s2: #181c23; --bd: #262c36;
  --w: #e8eaed; --d: #9aa3af; --dim: #6b7280;
  --y: #eab308; --y-soft: rgba(234, 179, 8, 0.12);
  --g: #34d399; --r: #f87171; --b: #60a5fa; --p: #c084fc;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; scroll-padding-top: 24px; }
body { background: var(--bg); color: var(--w); font-family: var(--sans); font-size: 15.5px; line-height: 1.65; }
a { color: var(--y); text-decoration: none; }
a:hover { text-decoration: underline; }

.layout { display: flex; min-height: 100vh; }
nav.sidebar {
  width: 300px; flex-shrink: 0; position: sticky; top: 0; height: 100vh;
  overflow-y: auto; background: var(--s1); border-right: 1px solid var(--bd);
  padding: 20px 0 40px;
}
.brand { padding: 0 20px 14px; border-bottom: 1px solid var(--bd); margin-bottom: 12px; }
.brand .t { font-family: var(--mono); font-weight: 700; font-size: 15px; color: var(--w); }
a.t:hover { text-decoration: none; }
.brand .badge {
  display: inline-block; font-family: var(--mono); font-size: 10px; letter-spacing: 1px;
  color: var(--y); border: 1px solid var(--y); border-radius: 3px; padding: 1px 6px; margin-left: 6px;
  vertical-align: 2px;
}
.brand .meta { font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 6px; }
.search { padding: 0 20px 12px; }
.search input {
  width: 100%; background: var(--s2); border: 1px solid var(--bd); border-radius: 6px;
  color: var(--w); font-family: var(--mono); font-size: 12.5px; padding: 7px 10px; outline: none;
}
.search input:focus { border-color: var(--y); }
.nav-chapter { margin-bottom: 2px; }
.nav-h1 {
  display: block; padding: 6px 20px; color: var(--w); font-size: 13px; font-weight: 600;
}
.nav-h2 {
  display: block; padding: 4px 20px 4px 34px; color: var(--d); font-size: 12.5px;
}
.nav-h1:hover, .nav-h2:hover { background: var(--s2); text-decoration: none; }
.nav-h1.active, .nav-h2.active { color: var(--y); background: var(--y-soft); border-right: 2px solid var(--y); }
.nav-hidden { display: none; }

main { flex: 1; min-width: 0; }
.confidential {
  background: #3b0d0d; color: #fca5a5; border-bottom: 1px solid #7f1d1d;
  font-family: var(--mono); font-size: 12px; letter-spacing: 0.5px;
  text-align: center; padding: 8px 16px; position: sticky; top: 0; z-index: 10;
}
.page { max-width: 880px; margin: 0 auto; padding: 40px 48px 120px; }

.chapter { border-bottom: 1px solid var(--bd); padding-bottom: 40px; margin-bottom: 48px; }
.chapter-src { font-family: var(--mono); font-size: 11.5px; color: var(--dim); margin-top: 32px; }

h1 { font-size: 30px; line-height: 1.25; margin: 48px 0 18px; letter-spacing: -0.5px; }
.chapter > h1:first-child { margin-top: 8px; }
h1::before { content: ""; display: block; width: 44px; height: 3px; background: var(--y); margin-bottom: 14px; border-radius: 2px; }
h2 { font-size: 21px; margin: 40px 0 12px; letter-spacing: -0.3px; }
h3 { font-size: 17px; margin: 30px 0 10px; }
h4 { font-size: 15px; margin: 24px 0 8px; color: var(--d); }
.anchor { visibility: hidden; margin-left: 8px; color: var(--dim); font-weight: 400; }
h1:hover .anchor, h2:hover .anchor, h3:hover .anchor, h4:hover .anchor { visibility: visible; }

p { margin: 0 0 14px; color: var(--w); }
li { margin: 4px 0; color: var(--w); }
ul, ol { margin: 0 0 14px; padding-left: 26px; }
strong { color: var(--w); }
em { color: var(--d); }
hr { border: none; border-top: 1px solid var(--bd); margin: 28px 0; }
code {
  font-family: var(--mono); font-size: 0.86em; background: var(--s2);
  border: 1px solid var(--bd); border-radius: 4px; padding: 1.5px 5px; color: #f0d879;
}
blockquote { border-left: 3px solid var(--bd); padding: 2px 0 2px 16px; margin: 0 0 14px; color: var(--d); }

.codeblock { position: relative; margin: 0 0 16px; }
.codeblock pre {
  background: var(--s1); border: 1px solid var(--bd); border-radius: 8px;
  padding: 14px 16px; overflow-x: auto; line-height: 1.55;
}
.codeblock pre code { background: none; border: none; padding: 0; color: var(--w); font-size: 12.8px; }
.codelang {
  position: absolute; top: 6px; right: 10px; font-family: var(--mono);
  font-size: 10px; color: var(--dim); letter-spacing: 1px; text-transform: uppercase;
}
.tk-k { color: var(--p); }
.tk-s { color: var(--g); }
.tk-c { color: var(--dim); font-style: italic; }
.tk-n { color: var(--b); }

.tablewrap { overflow-x: auto; margin: 0 0 16px; border: 1px solid var(--bd); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th { background: var(--s2); text-align: left; font-family: var(--mono); font-size: 12px; color: var(--d); }
th, td { padding: 8px 12px; border-bottom: 1px solid var(--bd); vertical-align: top; }
tr:last-child td { border-bottom: none; }

.diagram {
  background: var(--s1); border: 1px solid var(--bd); border-radius: 10px;
  padding: 20px; margin: 0 0 18px; text-align: center; overflow-x: auto;
}
.diagram svg { max-width: 100%; height: auto; }
.diagram figcaption { font-family: var(--mono); font-size: 12px; color: var(--dim); margin-top: 12px; text-align: center; }

.admonition { border: 1px solid var(--bd); border-left: 3px solid var(--b); border-radius: 6px; background: var(--s1); padding: 12px 16px 4px; margin: 0 0 16px; }
.admonition p, .admonition li { color: var(--d); font-size: 14px; }
.ad-title { font-family: var(--mono); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 6px; color: var(--b); }
.ad-warning, .ad-caution { border-left-color: var(--r); }
.ad-warning .ad-title, .ad-caution .ad-title { color: var(--r); }
.ad-important { border-left-color: var(--y); }
.ad-important .ad-title { color: var(--y); }
.ad-tip { border-left-color: var(--g); }
.ad-tip .ad-title { color: var(--g); }

@media (max-width: 900px) {
  nav.sidebar { display: none; }
  .page { padding: 24px 20px 80px; }
}
@media print {
  nav.sidebar, .confidential { display: none; }
  body { background: #fff; color: #111; }
  .page { max-width: none; }
}
</style>
</head>
<body>
${confidentialBanner}
<div class="layout">
<nav class="sidebar">
  <div class="brand">
    ${brandTitle}<span class="badge">${escapeHtml(config.badge ?? "")}</span>
    <div class="meta">${version ? `v${escapeHtml(version)} · ` : ""}generated ${generatedOn}</div>
  </div>
  <div class="search"><input id="q" type="search" placeholder="Filter sections…" autocomplete="off"></div>
  ${sidebar}
</nav>
<main>
<div class="page">
${content}
</div>
</main>
</div>
<script>
(function () {
  // sidebar filter
  var q = document.getElementById("q");
  q.addEventListener("input", function () {
    var term = q.value.toLowerCase();
    document.querySelectorAll(".nav-chapter").forEach(function (ch) {
      var links = ch.querySelectorAll("a");
      var any = false;
      links.forEach(function (a) {
        var hit = !term || a.textContent.toLowerCase().indexOf(term) !== -1;
        a.classList.toggle("nav-hidden", !hit && a.classList.contains("nav-h2"));
        if (hit) any = true;
      });
      ch.classList.toggle("nav-hidden", !any);
    });
  });
  // scrollspy
  var links = {};
  document.querySelectorAll("nav a[data-target]").forEach(function (a) {
    links[a.getAttribute("data-target")] = a;
  });
  var current = null;
  var obs = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          if (current) current.classList.remove("active");
          var a = links[e.target.id];
          if (a) {
            a.classList.add("active");
            current = a;
          }
        }
      });
    },
    { rootMargin: "0px 0px -75% 0px" }
  );
  document.querySelectorAll("h1[id], h2[id]").forEach(function (h) {
    obs.observe(h);
  });
})();
</script>
</body>
</html>
`;

const outPath = path.resolve(REPO_ROOT, config.output);
fs.writeFileSync(outPath, html);
const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`\nWrote ${outPath} (${kb} KB, ${chapters.length} chapters)`);
