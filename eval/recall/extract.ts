/**
 * Recall probe — step 1 (extract).
 *
 * Extract every function (name, path, raw body) from one repo and dump it as
 * JSON, so the Python side can embed the bodies with the PRODUCTION embedder
 * (corpus CodeRankEmbed) and reproduce the deep-scan candidate-generation path
 * exactly. We reuse the CLI's own extractor so the function pool is faithful.
 *
 * SHIPPED-CODE-ONLY mode: pass a root path with `--root <path>` (e.g. the
 * vibedrift-public repo itself) and/or include-prefixes with `--include
 * src,packages`. The v6 non-shipped path regexes (test/example/fixture/
 * generated, verbatim from src/scoring/engine.ts) are ALWAYS excluded so the
 * probe measures duplication in code the repo actually SHIPS — not test
 * scaffolding (which the score already de-weights and which polluted pass 1).
 *
 * Run:
 *   tsx eval/recall/extract.ts <cachedRepoDir>                 # cached corpus repo, all code
 *   tsx eval/recall/extract.ts <label> --root <absPath> --include src   # shipped-only
 */
import { discoverFiles } from "../../src/core/discovery.js";
import { extractAllFunctions } from "../../src/codedna/function-extractor.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "..", "discrimination", ".cache");

// Verbatim from src/scoring/engine.ts — what the v6 score treats as NOT-shipped.
const GENERATED_PATH_RE = /(^|\/)(generated|__generated__)\/|\.(generated|gen)\.[A-Za-z0-9]+$|\.pb\.go$|_pb2?\.py$|\.min\.[A-Za-z0-9]+$/;
const FIXTURE_PATH_RE = /(^|\/)(fixtures?|__fixtures__|__mocks__|mocks|snapshots|__snapshots__)\//;
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[A-Za-z0-9]+$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const EXAMPLE_PATH_RE = /(^|\/)(examples?|demos?|samples?)\//;
const NOT_SHIPPED = [GENERATED_PATH_RE, FIXTURE_PATH_RE, TEST_PATH_RE, EXAMPLE_PATH_RE];

const argv = process.argv.slice(2);
const label = argv[0];
const rootArg = (() => { const i = argv.indexOf("--root"); return i >= 0 ? argv[i + 1] : null; })();
const includeArg = (() => { const i = argv.indexOf("--include"); return i >= 0 ? argv[i + 1] : null; })();
const includes = includeArg ? includeArg.split(",").map((s) => s.trim()).filter(Boolean) : [];
const shipped = !!rootArg || includes.length > 0;
if (!label) {
  process.stderr.write("usage: tsx extract.ts <label> [--root <absPath>] [--include src,packages]\n");
  process.exit(1);
}

const root = rootArg ? rootArg : join(CACHE, label);
const { files } = await discoverFiles(root);
const functions = extractAllFunctions(files);

let dropped = 0;
const out = functions
  .filter((fn) => fn.rawBody && fn.rawBody.trim().length > 0)
  .filter((fn) => {
    if (!shipped) return true;
    const rel = fn.relativePath;
    if (NOT_SHIPPED.some((re) => re.test(rel))) { dropped++; return false; }
    if (includes.length && !includes.some((p) => rel === p || rel.startsWith(p + "/"))) { dropped++; return false; }
    return true;
  })
  .map((fn, i) => ({
    id: `f${i}`,
    name: fn.name,
    file: fn.file,
    relativePath: fn.relativePath,
    body: fn.rawBody,
  }));

const outPath = join(HERE, `${label}.functions.json`);
writeFileSync(outPath, JSON.stringify(out));
process.stderr.write(
  `${label}: ${out.length} functions kept` +
  (shipped ? ` (shipped-only; dropped ${dropped} non-shipped/out-of-include)` : "") +
  ` of ${functions.length} extracted -> ${outPath}\n`,
);
