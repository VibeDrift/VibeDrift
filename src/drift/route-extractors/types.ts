/**
 * Shared types for the per-language route extractors.
 *
 * `RouteInfo` and `FileMiddleware` live here (rather than in
 * `security-consistency.ts`) so the per-language extractor modules and the
 * `security-ast-*` modules can depend on them without a circular import.
 * `security-consistency.ts` re-exports both for back-compat, so existing
 * `import type { RouteInfo } from "./security-consistency.js"` sites keep working.
 */

import type { DriftFile } from "../types.js";
import type { CrossFileIndex } from "../security-xfile-index.js";

export interface FileMiddleware {
  hasAuth: boolean;
  hasValidation: boolean;
  hasRateLimit: boolean;
}

export interface RouteInfo {
  method: string;
  path: string;
  file: string;
  line: number;
  hasAuth: boolean;
  hasValidation: boolean;
  hasRateLimit: boolean;
  hasErrorHandler: boolean;
  /** Python or Go AST path only: the name of a middleware/hook whose BODY is
   *  auth-flavored but statically unverifiable (an opaque helper, an imported or
   *  selector/attribute target, a duplicate def). Present ONLY when
   *  `hasAuth === false`; `hasAuth === true` always omits it. An "unsure" route
   *  still counts as not-authed in every vote (never blesses) — this field only
   *  lets a renderer hedge the finding copy to name the exact middleware the user
   *  should double-check. Never set on the JS/TS AST path or the regex fallback,
   *  so those routes serialize byte-identically. */
  authUnsureHook?: string;
}

/**
 * Dependencies threaded into every route extractor. A uniform shape keeps the
 * dispatch table simple; each language module reads only what it needs:
 *   - Go / Python: `fileMw` (regex-fallback inheritance) + `xfile` (AST import resolution)
 *   - JS/TS: `fileMw` only
 *   - Rust: neither (Axum layer scope is computed from the tree)
 */
export interface ExtractDeps {
  fileMw: Map<string, FileMiddleware>;
  xfile: CrossFileIndex;
}

/**
 * A per-language route extractor. `extract` runs the AST path on a clean parse
 * and falls back to regex otherwise, returning the routes for a single file.
 * Stateless — a plain object satisfies it (no class needed). Dispatch is by the
 * `ROUTE_EXTRACTORS` table key in security-consistency.ts; extractors carry no
 * language tag of their own (one extractor can serve several keys, e.g. js+ts).
 */
export interface RouteExtractor {
  extract(file: DriftFile, deps: ExtractDeps): RouteInfo[];
}
