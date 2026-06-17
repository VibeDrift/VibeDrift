import type { AnalysisContext, Finding, SupportedLanguage } from "../core/types.js";
import type { ScoringCategory } from "../scoring/categories.js";

export interface Analyzer {
  id: string;
  name: string;
  category: ScoringCategory;
  requiresAST: boolean;
  applicableLanguages: SupportedLanguage[] | "all";
  /**
   * Bumped when the analyzer's logic changes in a way that would produce
   * different findings for the same input. Used as part of the findings
   * cache key — bumping invalidates stale cached output. Defaults to 1.
   */
  version?: number;
  analyze(ctx: AnalysisContext): Promise<Finding[]>;
}

export type { Finding, FileLocation } from "../core/types.js";
