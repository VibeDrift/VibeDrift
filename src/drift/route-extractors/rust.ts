/**
 * Rust route extractor — Axum / Actix / Rocket.
 *
 * AST ONLY, and ONLY on a CLEAN parse. There is NO regex fallback for Rust
 * anywhere in this codebase: an absent or errored tree yields zero Rust routes.
 * A parse error can only shrink the recognized route set for that file, never
 * emit a wrong route, and Rust has no legacy regex path whose over-blesses we
 * would need to preserve. Ignores `deps`: Axum `.layer` scope is CHAIN-scoped,
 * so the AST path computes covering-layer auth from the tree itself.
 */

import { extractRustRoutesAst } from "../security-ast-rust.js";
import type { RouteExtractor } from "./types.js";

export const rustRouteExtractor: RouteExtractor = {
  extract(file) {
    if (file.tree && !file.tree.rootNode.hasError) {
      return extractRustRoutesAst(file.tree, file.relativePath);
    }
    return [];
  },
};
