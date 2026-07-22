/**
 * Calibration corpora for multi-language import-style drift (#56).
 *
 * Each axis gets two directory roots:
 *   - a MIXED-convention directory (dominant pattern + one planted deviator) that
 *     must FIRE the axis finding and cite the deviator;
 *   - a NO-DOMINANT-convention directory (≈50/50) that must stay SILENT about
 *     drift (no specific file flagged) — the #56 acceptance criterion.
 */

import type { BaselineFile } from "./baseline.js";

// ─── Go grouping (stdlib vs external, blank-line separated) ───
function goFile(pkg: string, name: string, grouped: boolean): BaselineFile {
  const block = grouped
    ? `import (\n\t"fmt"\n\n\t"github.com/x/y"\n)`
    : `import (\n\t"fmt"\n\t"github.com/x/y"\n)`;
  return { path: `${pkg}/${name}.go`, content: `package ${pkg}\n\n${block}\n\nfunc ${name}() { fmt.Println(y.V) }\n` };
}
export const goGroupingMixed = (): BaselineFile[] =>
  [["a", true], ["b", true], ["c", true], ["d", true], ["e", false]].map(([n, g]) => goFile("gosvc", n as string, g as boolean));
export const goGroupingSplit = (): BaselineFile[] =>
  [["a", true], ["b", true], ["c", true], ["d", false], ["e", false], ["f", false]].map(([n, g]) => goFile("gomix", n as string, g as boolean));
export const goDeviatorPath = "gosvc/e.go";

// ─── Python path style (absolute-local vs relative) ───
function pyFile(pkg: string, name: string, relative: boolean): BaselineFile {
  const block = relative
    ? `from .models import User\nfrom ..db import session`
    : `from ${pkg}.models import User\nfrom ${pkg}.db import session`;
  return { path: `${pkg}/${name}.py`, content: `${block}\n\n\ndef ${name}():\n    return User\n` };
}
export const pyPathStyleMixed = (): BaselineFile[] =>
  [["a", true], ["b", true], ["c", true], ["d", true], ["e", false]].map(([n, r]) => pyFile("pysvc", n as string, r as boolean));
export const pyPathStyleSplit = (): BaselineFile[] =>
  [["a", true], ["b", true], ["c", true], ["d", false], ["e", false], ["f", false]].map(([n, r]) => pyFile("pymix", n as string, r as boolean));
export const pyDeviatorPath = "pysvc/e.py";

// ─── Rust glob (use …::* vs explicit) ───
function rsFile(dir: string, name: string, glob: boolean): BaselineFile {
  const second = glob ? `use crate::prelude::*;` : `use serde::Deserialize;`;
  return { path: `${dir}/${name}.rs`, content: `use std::collections::HashMap;\n${second}\n\nfn ${name}() {}\n` };
}
export const rustGlobMixed = (): BaselineFile[] =>
  [["a", false], ["b", false], ["c", false], ["d", false], ["e", true]].map(([n, g]) => rsFile("rssvc", n as string, g as boolean));
export const rustGlobSplit = (): BaselineFile[] =>
  [["a", false], ["b", false], ["c", false], ["d", true], ["e", true], ["f", true]].map(([n, g]) => rsFile("rsmix", n as string, g as boolean));
export const rustDeviatorPath = "rssvc/e.rs";
