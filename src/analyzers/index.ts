import type { Analyzer } from "./base.js";
import { namingAnalyzer } from "./naming.js";
import { importsAnalyzer } from "./imports.js";
import { errorHandlingAnalyzer } from "./error-handling.js";
import { dependenciesAnalyzer } from "./dependencies.js";
import { dependencyDriftAnalyzer } from "./dependency-drift.js";
import { duplicatesAnalyzer } from "./duplicates.js";
import { todoDensityAnalyzer } from "./todo-density.js";
import { configDriftAnalyzer } from "./config-drift.js";
import { securityAnalyzer } from "./security.js";
import { complexityAnalyzer } from "./complexity.js";
import { intentClarityAnalyzer } from "./intent-clarity.js";
import { deadCodeAnalyzer } from "./dead-code.js";
import { languageSpecificAnalyzer } from "./language-specific.js";
import { implementationGapAnalyzer } from "./implementation-gap.js";

export function createAnalyzerRegistry(): Analyzer[] {
  return [
    // Architectural Consistency
    namingAnalyzer,
    importsAnalyzer,
    errorHandlingAnalyzer,
    languageSpecificAnalyzer,
    // Redundancy
    duplicatesAnalyzer,
    todoDensityAnalyzer,
    deadCodeAnalyzer,
    // Dependency Health
    dependenciesAnalyzer,
    configDriftAnalyzer,
    // Dependency-drift: FINDINGS-ONLY. analyzerId "dependency-drift" is
    // deliberately NOT in CATEGORY_CONFIG, so its findings appear in scan
    // output / --json but feed neither the composite nor the hygiene score
    // (validating discrimination on a corpus before scoring — see the file
    // header in ./dependency-drift.ts).
    dependencyDriftAnalyzer,
    // Security Posture
    securityAnalyzer,
    // Intent Clarity
    intentClarityAnalyzer,
    complexityAnalyzer,
    implementationGapAnalyzer,
  ];
}
