import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding, FileLocation, SupportedLanguage } from "../core/types.js";
import { getLineNumber } from "../utils/text.js";

interface SecurityPattern {
  id: string;
  name: string;
  pattern: RegExp;
  severity: "info" | "warning" | "error";
  confidence: number;
  message: string;
  languages: SupportedLanguage[] | "all";
  tags: string[];
  // If provided, a second regex that must NOT match on the same line (reduces false positives)
  negativeFilter?: RegExp;
  // If provided, the pattern is only flagged when the surrounding ±5 lines
  // contain at least one match for this regex (security context proximity check)
  contextRequired?: RegExp;
}

const SECURITY_PATTERNS: SecurityPattern[] = [
  // === Hardcoded Secrets ===
  {
    id: "hardcoded-api-key",
    name: "Hardcoded API key",
    pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi,
    severity: "error",
    confidence: 0.85,
    message: "Potential hardcoded API key",
    languages: "all",
    tags: ["security", "secrets"],
    negativeFilter: /(?:example|placeholder|your[_-]|xxx|test|dummy|fake|sample)/i,
  },
  // NOTE: `hardcoded-password` removed in Phase 4 — `password = "<4+ chars>"`
  // matched any short string assigned to a password-named var (test fixtures,
  // placeholders, redaction labels), producing more noise than signal. The
  // specific-format secret rules below (token 20+, AWS key, private key) stay.
  {
    id: "hardcoded-token",
    name: "Hardcoded token",
    pattern: /(?:token|bearer|jwt|auth[_-]?token|access[_-]?token|secret[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_.\-]{20,}['"]/gi,
    severity: "error",
    confidence: 0.8,
    message: "Potential hardcoded authentication token",
    languages: "all",
    tags: ["security", "secrets"],
    negativeFilter: /(?:example|placeholder|your[_-]|xxx|test|dummy|fake|sample)/i,
  },
  {
    id: "private-key",
    name: "Private key in source",
    pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    severity: "error",
    confidence: 0.98,
    message: "Private key embedded in source code",
    languages: "all",
    tags: ["security", "secrets", "critical"],
  },
  {
    id: "aws-key",
    name: "AWS access key",
    pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
    severity: "error",
    confidence: 0.95,
    message: "AWS access key ID detected",
    languages: "all",
    tags: ["security", "secrets", "aws"],
  },

  // === Injection Vulnerabilities ===
  {
    id: "sql-injection",
    name: "SQL injection risk",
    pattern: /(?:query|exec|execute|raw)\s*\(\s*[`'"](?:SELECT|INSERT|UPDATE|DELETE|DROP)\b[^`'"]*\$\{/gi,
    severity: "error",
    confidence: 0.8,
    message: "Potential SQL injection: string interpolation in query",
    languages: ["javascript", "typescript"],
    tags: ["security", "injection", "sql"],
  },
  // NOTE: `sql-concat` removed in Phase 4 — overlapped the more precise
  // `sql-injection` (${} interpolation) rule above while false-firing on safe
  // concatenation with whitelisted identifiers.
  {
    id: "go-sql-fmt",
    name: "Go SQL fmt injection",
    pattern: /(?:db\.(?:Query|Exec|QueryRow))\s*\(\s*fmt\.Sprintf\s*\(/g,
    severity: "error",
    confidence: 0.9,
    message: "SQL injection risk: fmt.Sprintf used in database query",
    languages: ["go"],
    tags: ["security", "injection", "sql"],
  },
  // NOTE: `command-injection` removed in Phase 4 — `exec|spawn|execFile(... + ...)`
  // false-fired on safe array-arg forms like `execFile("ls", [a + b])` (array
  // args aren't shell-interpreted). The specific `shell=True` rule below stays.
  {
    id: "python-shell-injection",
    name: "Python shell injection",
    pattern: /subprocess\.(?:call|run|Popen)\s*\([^)]*shell\s*=\s*True/g,
    severity: "error",
    confidence: 0.85,
    message: "Shell injection risk: subprocess with shell=True",
    languages: ["python"],
    tags: ["security", "injection", "command"],
  },

  // === Unsafe Functions ===
  {
    id: "eval-usage",
    name: "eval() usage",
    pattern: /\beval\s*\(/g,
    severity: "error",
    confidence: 0.9,
    message: "Use of eval() — potential code injection vector",
    languages: ["javascript", "typescript", "python"],
    tags: ["security", "unsafe-function"],
    negativeFilter: /(?:eslint|no-eval|# noqa)/i,
  },
  {
    id: "function-constructor",
    name: "Function constructor",
    pattern: /new\s+Function\s*\(/g,
    severity: "error",
    confidence: 0.9,
    message: "Use of Function constructor — equivalent to eval()",
    languages: ["javascript", "typescript"],
    tags: ["security", "unsafe-function"],
  },
  {
    id: "innerHTML-assignment",
    name: "innerHTML assignment",
    pattern: /\.innerHTML\s*=/g,
    severity: "warning",
    confidence: 0.7,
    message: "Direct innerHTML assignment — potential XSS vector",
    languages: ["javascript", "typescript"],
    tags: ["security", "xss"],
  },
  {
    id: "dangerously-set-html",
    name: "dangerouslySetInnerHTML",
    pattern: /dangerouslySetInnerHTML/g,
    severity: "warning",
    confidence: 0.8,
    message: "dangerouslySetInnerHTML used — ensure input is sanitized",
    languages: ["javascript", "typescript"],
    tags: ["security", "xss", "react"],
  },

  // === Insecure Crypto ===
  {
    id: "weak-hash-md5",
    name: "MD5 hash usage",
    pattern: /(?:createHash|hashlib\.md5|md5\.New|Md5::new)\s*\(\s*['"]?md5['"]?\s*\)/gi,
    severity: "warning",
    confidence: 0.85,
    message: "MD5 is cryptographically broken — use SHA-256 or better",
    languages: "all",
    tags: ["security", "crypto"],
  },
  {
    id: "weak-hash-sha1",
    name: "SHA1 hash usage",
    pattern: /(?:createHash|hashlib\.sha1|sha1\.New|Sha1::new)\s*\(\s*['"]?sha1['"]?\s*\)/gi,
    severity: "warning",
    confidence: 0.8,
    message: "SHA-1 is deprecated for security — use SHA-256 or better",
    languages: "all",
    tags: ["security", "crypto"],
  },
  {
    id: "math-random-crypto",
    name: "Math.random for security",
    pattern: /Math\.random\s*\(\)/g,
    severity: "warning",
    confidence: 0.5,
    message: "Math.random() is not cryptographically secure — use crypto.randomUUID()",
    languages: ["javascript", "typescript"],
    tags: ["security", "crypto"],
    negativeFilter: /(?:test|mock|seed|shuffle|animation|color|position|offset|delay|jitter)/i,
    // Only flag near security-relevant code — UI shuffles/animations are not a risk
    contextRequired: /(?:token|secret|password|key|nonce|salt|hash|crypto|auth|session|jwt|api.?key|credential)/i,
  },

  // === Path Traversal ===
  {
    id: "path-traversal",
    name: "Path traversal risk",
    pattern: /(?:readFile|readFileSync|createReadStream|open)\s*\([^)]*\+/g,
    severity: "warning",
    confidence: 0.6,
    message: "Potential path traversal: dynamic value in file operation",
    languages: ["javascript", "typescript"],
    tags: ["security", "path-traversal"],
  },

  // === SSRF ===
  {
    id: "ssrf-risk",
    name: "SSRF risk",
    pattern: /(?:fetch|axios\.get|http\.get|requests\.get|httpClient)\s*\(\s*(?:[`'"].*\$\{|[^'"]*\+)/g,
    severity: "info",
    confidence: 0.4,
    message: "URL constructed from variable — review if the source is user-controlled",
    languages: "all",
    tags: ["security", "ssrf"],
    negativeFilter: /(?:API_URL|BASE_URL|apiUrl|baseUrl|base\s*\+|endpoint|config\.|process\.env)/i,
  },

  // === Python-specific ===
  {
    id: "python-pickle",
    name: "Unsafe pickle.load",
    pattern: /pickle\.loads?\s*\(/g,
    severity: "error",
    confidence: 0.85,
    message: "pickle.load can execute arbitrary code — use json or safer alternatives",
    languages: ["python"],
    tags: ["security", "deserialization"],
  },
  {
    id: "python-yaml-unsafe",
    name: "Unsafe YAML load",
    pattern: /yaml\.load\s*\([^)]*(?!\bLoader\b)/g,
    severity: "error",
    confidence: 0.8,
    message: "yaml.load without SafeLoader can execute arbitrary code",
    languages: ["python"],
    tags: ["security", "deserialization"],
    negativeFilter: /SafeLoader|FullLoader|BaseLoader/,
  },

  // === Go-specific ===
  {
    id: "go-tls-skip-verify",
    name: "Go TLS skip verify",
    pattern: /InsecureSkipVerify\s*:\s*true/g,
    severity: "error",
    confidence: 0.95,
    message: "TLS certificate verification disabled",
    languages: ["go"],
    tags: ["security", "tls"],
  },

  // === Rust-specific ===
  {
    id: "rust-unsafe",
    name: "Rust unsafe blocks",
    pattern: /\bunsafe\s*\{/g,
    severity: "warning",
    confidence: 0.7,
    message: "Unsafe block — ensure memory safety invariants are upheld",
    languages: ["rust"],
    tags: ["security", "memory-safety"],
  },
];

// Pre-screen: a union of literal keywords lifted from the patterns above.
// If none of these appear anywhere in a file, skip the 26-pattern sweep
// entirely. Cheap O(n) first pass that filters most files.
const SECURITY_PREFILTER = /password|passwd|pwd|apikey|api[_-]?key|api[_-]?secret|\btoken\b|bearer|\bjwt\b|access[_-]?token|secret[_-]?key|BEGIN (?:RSA |EC |DSA )?PRIVATE KEY|AKIA|ASIA|\bquery\s*\(|\bexec\b|\bexecSync\b|\bspawn\b|fmt\.Sprintf|subprocess\.|\beval\s*\(|new\s+Function\s*\(|innerHTML|dangerouslySetInnerHTML|\bmd5\b|\bsha1\b|Math\.random|readFile|fetch\s*\(|axios\.|http\.(?:Get|Post)|pickle\.load|yaml\.load|InsecureSkipVerify|unsafe\s*\{|-----BEGIN/i;

export const securityAnalyzer: Analyzer = {
  id: "security",
  name: "Security Posture",
  category: "securityPosture",
  requiresAST: false,
  applicableLanguages: "all",
  version: 2,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    const PATTERN_DEF = /(?:pattern\s*:|regex\s*:|RegExp\s*\(|name\s*:|message\s*:|id\s*:|label\s*:)/;

    for (const file of ctx.files) {
      // Skip fixture paths AND general test files — hardcoded "secret-
      // looking" strings in test bodies are deliberate (the test is
      // verifying that the security analyzer catches them). Running
      // the analyzer on its own tests creates noise + false-positive
      // findings against the scanner's own repo.
      if (/(?:fixtures?|testdata|__fixtures__|__mocks__)[/\\]/i.test(file.relativePath)) continue;
      if (/(?:^|[/\\])test[/\\]|\.(?:test|spec)\.[a-z]+$/i.test(file.relativePath)) continue;

      // Prefilter: skip files with no security-relevant keywords at all.
      // Roughly 5–10× speedup on large codebases where most files don't
      // touch auth/crypto/IO.
      if (!SECURITY_PREFILTER.test(file.content)) continue;

      for (const pattern of SECURITY_PATTERNS) {
        if (pattern.languages !== "all") {
          if (!file.language || !pattern.languages.includes(file.language)) continue;
        }

        const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
        let match;
        while ((match = regex.exec(file.content)) !== null) {
          const lineStart = file.content.lastIndexOf("\n", match.index) + 1;
          const lineEnd = file.content.indexOf("\n", match.index);
          const line = file.content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);

          if (PATTERN_DEF.test(line)) continue;
          if (pattern.negativeFilter && pattern.negativeFilter.test(line)) continue;

          if (pattern.contextRequired) {
            const lines = file.content.split("\n");
            const matchLine = file.content.slice(0, match.index).split("\n").length - 1;
            const start = Math.max(0, matchLine - 5);
            const end = Math.min(lines.length, matchLine + 6);
            const context = lines.slice(start, end).join("\n");
            if (!pattern.contextRequired.test(context)) continue;
          }

          const lineNum = getLineNumber(file.content, match.index);
          const snippet = line.trim();

          findings.push({
            analyzerId: "security",
            severity: pattern.severity,
            confidence: pattern.confidence,
            message: `${pattern.message} in ${file.relativePath}:${lineNum}`,
            locations: [{
              file: file.relativePath,
              line: lineNum,
              snippet: snippet.length > 120 ? snippet.slice(0, 120) + "..." : snippet,
            }],
            tags: pattern.tags,
          });
        }
      }
    }

    return bayesianStackFindings(findings);
  },
};

/**
 * Bayesian-combine findings that fired on the same file:line.
 *
 * Old behavior: keep only the highest-confidence finding per line, discard
 * the rest. That throws away corroborating evidence.
 *
 * New behavior: combine independent-evidence confidences via odds:
 *     odds(H|E1…En) = odds(H) · Π  LR(Ei)      with LR(Ei) = c_i / (1 − c_i)
 *     combined_confidence = odds / (1 + odds)
 *
 * Each individual c_i is clamped ≤ 0.99 so a single near-certain pattern
 * doesn't force infinite odds. In practice this means three hits at
 * 0.75/0.80/0.95 combine to ~0.997 — sharper than any single one alone.
 */
function bayesianStackFindings(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const loc = f.locations[0];
    const key = `${loc?.file ?? ""}:${loc?.line ?? 0}`;
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }

  const out: Finding[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    // Sum log-odds to avoid overflow on many patterns.
    let logOdds = 0;
    for (const f of group) {
      const c = Math.min(0.99, Math.max(0.01, f.confidence));
      logOdds += Math.log(c / (1 - c));
    }
    const odds = Math.exp(logOdds);
    const combined = Math.min(0.999, odds / (1 + odds));
    const top = group.reduce((a, b) => (a.confidence > b.confidence ? a : b));
    const tags = [...new Set(group.flatMap((f) => f.tags))];
    out.push({
      ...top,
      confidence: combined,
      tags: [...tags, "corroborated"],
      message: `${top.message} [${group.length} patterns corroborate, combined confidence ${(combined * 100).toFixed(1)}%]`,
    });
  }
  return out;
}
