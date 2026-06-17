import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding } from "../core/types.js";
import { getLineNumber } from "../utils/text.js";

const ENV_PATTERNS = [
  /process\.env\.(\w+)/g,
  /import\.meta\.env\.(\w+)/g,
  /os\.environ(?:\.get)?\(\s*['"](\w+)['"]/g,
  /os\.Getenv\(\s*"(\w+)"\s*\)/g,  // Go
  /env::var\(\s*"(\w+)"\s*\)/g,    // Rust
];

export const configDriftAnalyzer: Analyzer = {
  id: "config-drift",
  name: "Config Drift",
  category: "dependencyHealth",
  requiresAST: false,
  applicableLanguages: "all",
  version: 2,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const envUsages = new Map<string, { file: string; line: number }[]>();

    for (const file of ctx.files) {
      for (const pattern of ENV_PATTERNS) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;
        while ((match = regex.exec(file.content)) !== null) {
          const varName = match[1];
          if (!envUsages.has(varName)) envUsages.set(varName, []);
          envUsages.get(varName)!.push({
            file: file.relativePath,
            line: getLineNumber(file.content, match.index),
          });
        }
      }
    }

    // Direction 1: code uses a var not declared in .env.example.
    if (ctx.envExample) {
      const undocumented: string[] = [];
      for (const [varName, locations] of envUsages) {
        if (!ctx.envExample.has(varName) && !varName.startsWith("NODE_") && varName !== "NODE_ENV") {
          undocumented.push(varName);
          findings.push({
            analyzerId: "config-drift",
            severity: "warning",
            confidence: 0.85,
            message: `Env var ${varName} used in code but missing from .env.example`,
            locations,
            tags: ["config", "env", "undocumented"],
          });
        }
      }
      if (undocumented.length > 0) {
        findings.push({
          analyzerId: "config-drift",
          severity: "warning",
          confidence: 0.85,
          message: `${undocumented.length} env vars used in code but missing from .env.example`,
          locations: [],
          tags: ["config", "summary"],
        });
      }

      // Direction 2 (new): .env.example declares a var that no code reads.
      // Lower severity — a declared-but-unused var is sloppiness, not a bug.
      const declaredButUnused: string[] = [];
      for (const exampleKey of ctx.envExample.keys()) {
        if (!envUsages.has(exampleKey)) {
          declaredButUnused.push(exampleKey);
        }
      }
      if (declaredButUnused.length > 0) {
        findings.push({
          analyzerId: "config-drift",
          severity: "info",
          confidence: 0.7,
          message: `${declaredButUnused.length} env var(s) declared in .env.example but never referenced in code: ${declaredButUnused.slice(0, 5).join(", ")}${declaredButUnused.length > 5 ? "..." : ""}`,
          locations: [],
          tags: ["config", "unused-declaration"],
        });
      }
    } else if (envUsages.size > 3) {
      findings.push({
        analyzerId: "config-drift",
        severity: "info",
        confidence: 0.7,
        message: `${envUsages.size} env vars used but no .env.example file found`,
        locations: [],
        tags: ["config", "missing-example"],
      });
    }

    return findings;
  },
};
