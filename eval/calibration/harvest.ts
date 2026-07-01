/**
 * Calibration harvest: collect REAL codedna-fingerprint duplicate groups (with
 * function bodies) from a diverse, stratified set of cached repos, so each group
 * can be judged by Claude as a real semantic duplicate vs coincidental/boilerplate.
 *
 * Output (stdout JSON): pairs[] = one representative pair per dup group, with
 * bodies + metadata (repo, repoType, groupSize, crossPackage). This is the
 * sampling frame for measuring the exact-hash detector's PRECISION.
 *
 * Run: node_modules/.bin/tsx eval/calibration/harvest.ts > eval/calibration/pairs.json
 */
import { discoverFiles } from "../../src/core/discovery.js";
import { extractAllFunctions } from "../../src/codedna/function-extractor.js";
import {
  computeSemanticFingerprints,
  findDuplicateGroups,
} from "../../src/codedna/semantic-fingerprint.js";
import type { ExtractedFunction } from "../../src/codedna/types.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "..", "discrimination", ".cache");

// repo dir (under .cache) -> coarse type, for stratified analysis of precision.
const REPOS: { dir: string; label: string; type: "monorepo" | "lib" | "app-messy" }[] = [
  { dir: "trpc-trpc", label: "trpc/trpc", type: "monorepo" },
  { dir: "TanStack-query", label: "TanStack/query", type: "monorepo" },
  { dir: "vuejs-core", label: "vuejs/core", type: "monorepo" },
  { dir: "honojs-hono", label: "honojs/hono", type: "lib" },
  { dir: "fastify-fastify", label: "fastify/fastify", type: "lib" },
  { dir: "expressjs-express", label: "expressjs/express", type: "lib" },
  { dir: "sindresorhus-ky", label: "sindresorhus/ky", type: "lib" },
  { dir: "sindresorhus-p-map", label: "sindresorhus/p-map", type: "lib" },
  { dir: "sindresorhus-p-queue", label: "sindresorhus/p-queue", type: "lib" },
  { dir: "LucasAnd1-nestjs-microservices-starter-template", label: "nestjs-starter", type: "app-messy" },
];

const PER_REPO_CAP = 22; // cap so large monorepos don't dominate the estimate
const MAX_BODY = 3500; // trim bodies sent downstream

// Deterministic LCG so re-harvests are reproducible.
function mkRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function sampleK<T>(arr: T[], k: number, rng: () => number): T[] {
  if (arr.length <= k) return arr;
  const idx = arr.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, k).sort((a, b) => a - b).map((i) => arr[i]);
}

function topPkg(relPath: string): string {
  // first 2 path segments approximate a "package" in a monorepo (packages/x, src/y)
  const parts = relPath.split("/");
  return parts.slice(0, 2).join("/");
}

const rng = mkRng(20260624);
const out: any[] = [];
let gid = 0;

for (const repo of REPOS) {
  const root = join(CACHE, repo.dir);
  let files;
  try {
    ({ files } = await discoverFiles(root));
  } catch (e) {
    process.stderr.write(`skip ${repo.dir}: ${(e as Error).message}\n`);
    continue;
  }
  const functions = extractAllFunctions(files);
  const fps = computeSemanticFingerprints(functions);
  const groups = findDuplicateGroups(fps, functions);

  // body lookup keyed exactly as findDuplicateGroups keys (name:file)
  const lookup = new Map<string, ExtractedFunction>();
  for (const fn of functions) lookup.set(`${fn.name}:${fn.file}`, fn);

  const sampled = sampleK(groups, PER_REPO_CAP, rng);
  let kept = 0;
  for (const g of sampled) {
    const refs = g.functions;
    if (refs.length < 2) continue;
    const a = lookup.get(`${refs[0].name}:${refs[0].file}`);
    const b = lookup.get(`${refs[1].name}:${refs[1].file}`);
    if (!a || !b || !a.rawBody || !b.rawBody) continue;
    const crossPackage = topPkg(refs[0].relativePath) !== topPkg(refs[1].relativePath);
    out.push({
      id: `g${gid++}`,
      repo: repo.label,
      repoType: repo.type,
      groupSize: refs.length,
      crossPackage,
      fnA: { name: a.name, path: a.relativePath, body: a.rawBody.slice(0, MAX_BODY) },
      fnB: { name: b.name, path: b.relativePath, body: b.rawBody.slice(0, MAX_BODY) },
    });
    kept++;
  }
  process.stderr.write(`${repo.label}: ${functions.length} fns, ${groups.length} dup-groups, kept ${kept}\n`);
}

process.stderr.write(`TOTAL pairs: ${out.length}\n`);
process.stdout.write(JSON.stringify(out, null, 2));
