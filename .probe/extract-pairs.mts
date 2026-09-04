import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { extractAllFunctions } from "../src/codedna/function-extractor.js";
import { buildSignature, findLshCandidatePairs, lcsSimilarity } from "../src/codedna/minhash.js";
import { detectLanguage } from "../src/core/language.js";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", ".next", "out", ".probe"]);
const FLAG_THRESHOLD = Number(process.env.THRESH ?? "0.7");

function walk(d: string, a: string[] = []): string[] {
  for (const e of readdirSync(d)) {
    if (SKIP.has(e)) continue;
    const p = join(d, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, a);
    else if (detectLanguage(e)) a.push(p);
  }
  return a;
}

const out: unknown[] = [];
for (const root of process.argv.slice(2)) {
  const files = walk(root).map((p) => ({
    path: p, relativePath: relative(root, p).replace(/\\/g, "/"),
    content: readFileSync(p, "utf8"), language: detectLanguage(p)!,
  }));
  const fns = extractAllFunctions(files as never) as Array<{ name: string; file: string; relativePath: string; line: number; rawBody: string; language: string }>;
  const indexed = fns.map((fn) => ({ fn, ...buildSignature(fn.rawBody) }));
  const cands = findLshCandidatePairs(indexed.map((i) => i.signature));
  const seen = new Set<string>();
  for (const key of cands) {
    const [ai, bi] = key.split("-").map(Number);
    const a = indexed[ai], b = indexed[bi];
    if (!a || !b) continue;
    if (a.fn.file === b.fn.file) continue;
    const shorter = Math.min(a.tokens.length, b.tokens.length);
    const longer = Math.max(a.tokens.length, b.tokens.length);
    if (shorter / longer < 0.6) continue;
    const sim = lcsSimilarity(a.tokens, b.tokens);
    if (sim < FLAG_THRESHOLD) continue;
    const dk = [a.fn.relativePath + ":" + a.fn.name, b.fn.relativePath + ":" + b.fn.name].sort().join("|");
    if (seen.has(dk)) continue;
    seen.add(dk);
    out.push({
      repo: root.split("/").pop(), language: a.fn.language, similarity: Number(sim.toFixed(3)),
      a: { file: a.fn.relativePath, name: a.fn.name, line: a.fn.line, body: a.fn.rawBody.slice(0, 1400) },
      b: { file: b.fn.relativePath, name: b.fn.name, line: b.fn.line, body: b.fn.rawBody.slice(0, 1400) },
    });
  }
}
writeFileSync(process.env.OUT!, JSON.stringify(out, null, 1));
console.log(`extracted ${out.length} pairs`);
