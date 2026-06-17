import type { Analyzer } from "./base.js";
import { namingAnalyzer } from "./naming.js";
import { importsAnalyzer } from "./imports.js";
import { errorHandlingAnalyzer } from "./error-handling.js";
import { dependenciesAnalyzer } from "./dependencies.js";
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
    // Security Posture
    securityAnalyzer,
    // Intent Clarity
    intentClarityAnalyzer,
    complexityAnalyzer,
    implementationGapAnalyzer,
  ];
}
