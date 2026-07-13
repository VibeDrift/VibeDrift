import { deflateRawSync } from "zlib";
import type { ScanResult } from "../core/types.js";
import { getVersion } from "../core/version.js";
import { formatCount } from "./format.js";
import { getAnalyzerKind } from "../scoring/categories.js";

// ──── Minimal ZIP generator (OOXML requires ZIP container) ────

interface ZipEntry {
  name: string;
  data: Buffer;
}

function buildZip(entries: ZipEntry[]): Buffer {
  const centralDir: Buffer[] = [];
  const localFiles: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data);
    const nameBytes = Buffer.from(entry.name, "utf-8");
    const crc = crc32(entry.data);

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);   // signature
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(8, 8);             // compression: deflate
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0, 12);            // mod date
    local.writeUInt32LE(crc, 14);          // crc32
    local.writeUInt32LE(compressed.length, 18);  // compressed size
    local.writeUInt32LE(entry.data.length, 22);  // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);   // name length
    local.writeUInt16LE(0, 28);            // extra length
    nameBytes.copy(local, 30);

    localFiles.push(local);
    localFiles.push(compressed);

    // Central directory header
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);  // signature
    central.writeUInt16LE(20, 4);           // version made by
    central.writeUInt16LE(20, 6);           // version needed
    central.writeUInt16LE(0, 8);            // flags
    central.writeUInt16LE(8, 10);           // compression
    central.writeUInt16LE(0, 12);           // mod time
    central.writeUInt16LE(0, 14);           // mod date
    central.writeUInt32LE(crc, 16);         // crc32
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);           // extra length
    central.writeUInt16LE(0, 32);           // comment length
    central.writeUInt16LE(0, 34);           // disk number
    central.writeUInt16LE(0, 36);           // internal attrs
    central.writeUInt32LE(0, 38);           // external attrs
    central.writeUInt32LE(offset, 42);      // relative offset
    nameBytes.copy(central, 46);

    centralDir.push(central);
    offset += local.length + compressed.length;
  }

  const centralDirBuf = Buffer.concat(centralDir);
  const centralDirOffset = offset;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);        // signature
  eocd.writeUInt16LE(0, 4);                  // disk number
  eocd.writeUInt16LE(0, 6);                  // disk of central dir
  eocd.writeUInt16LE(entries.length, 8);     // entries on disk
  eocd.writeUInt16LE(entries.length, 10);    // total entries
  eocd.writeUInt32LE(centralDirBuf.length, 12); // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16);  // central dir offset
  eocd.writeUInt16LE(0, 20);                 // comment length

  return Buffer.concat([...localFiles, centralDirBuf, eocd]);
}

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ──── OOXML Document Parts ────

function contentTypes(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
}

function rootRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function docRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function styles(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/><w:color w:val="00D4FF"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="400" w:after="200"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="E2E8F0"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="300" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="8B9DB8"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:before="60" w:after="60"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr></w:style>
</w:styles>`;
}

// ──── XML Helpers ────

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function para(text: string, style?: string, props?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/>${props ?? ""}</w:pPr>` : (props ? `<w:pPr>${props}</w:pPr>` : "");
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function boldPara(text: string, color?: string): string {
  const rPr = `<w:rPr><w:b/>${color ? `<w:color w:val="${color}"/>` : ""}</w:rPr>`;
  return `<w:p><w:r>${rPr}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function colorRun(text: string, color: string, bold?: boolean): string {
  const rPr = `<w:rPr>${bold ? "<w:b/>" : ""}<w:color w:val="${color}"/></w:rPr>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

function multiRunPara(runs: string[]): string {
  return `<w:p>${runs.join("")}</w:p>`;
}

function tableCellSimple(text: string, shade?: string, bold?: boolean): string {
  const shd = shade ? `<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${shade}"/></w:tcPr>` : "";
  const rPr = bold ? "<w:rPr><w:b/></w:rPr>" : "";
  return `<w:tc>${shd}<w:p><w:r>${rPr}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p></w:tc>`;
}

function tableRow(cells: string[]): string {
  return `<w:tr>${cells.join("")}</w:tr>`;
}

function hr(): string {
  return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>`;
}

// ──── Document Body Builder (helpers) ────

const TABLE_BORDERS = `<w:tblBorders><w:top w:val="single" w:sz="4" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:color="E0E0E0"/><w:insideV w:val="single" w:sz="4" w:color="E0E0E0"/></w:tblBorders>`;

function wrapTable(rows: string): string {
  return `<w:tbl><w:tblPr>${TABLE_BORDERS}<w:tblW w:w="5000" w:type="pct"/></w:tblPr>${rows}</w:tbl>`;
}

function buildDocxTitlePage(result: ScanResult): string {
  const parts: string[] = [];
  const name = result.context.rootDir.split("/").pop() ?? "project";
  const date = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  parts.push(para("VIBEDRIFT REPORT", "Title"));
  parts.push(para(`${name}`, "Heading1"));
  parts.push(para(`Generated: ${date} | Files: ${result.context.files.length} | Lines: ${formatCount(result.context.totalLines)} | Scan: ${(result.scanTimeMs / 1000).toFixed(1)}s`));
  const langs = [...result.context.languageBreakdown.entries()].map(([l, s]) => `${l}: ${s.files} files`).join(", ");
  parts.push(para(`Languages: ${langs}`));
  parts.push(hr());
  return parts.join("\n    ");
}

function buildDocxScoreTable(result: ScanResult): string {
  const parts: string[] = [];
  const pct = result.maxCompositeScore > 0 ? (result.compositeScore / result.maxCompositeScore) * 100 : 0;
  const grade = pct >= 90 ? "A" : pct >= 75 ? "B" : pct >= 50 ? "C" : pct >= 25 ? "D" : "F";

  parts.push(para("1. SCORE SUMMARY", "Heading1"));
  parts.push(boldPara(`Composite Score: ${result.compositeScore} / ${result.maxCompositeScore} (Grade ${grade})`));
  parts.push(para(""));

  const ds = result.driftScores ?? {};
  // securityPosture N/A on the floored composite (result.scores) means every
  // security drift finding was below the peer floor and demoted to advisory.
  // The driftScores breakdown credits an empty category full health
  // (security_posture -> 14/14, 0 findings), so render that row as N/A to match
  // the composite instead of a scored-looking value.
  const securityIsNa = result.scores.securityPosture?.applicable === false;
  const catRows: { name: string; cs: any; na: boolean }[] = [
    { name: "Architectural Consistency", cs: ds.architectural_consistency, na: false },
    { name: "Security Consistency", cs: ds.security_posture, na: securityIsNa },
    { name: "Semantic Duplication", cs: ds.semantic_duplication, na: false },
    { name: "Convention Drift", cs: ds.naming_conventions, na: false },
    { name: "Phantom Scaffolding", cs: ds.phantom_scaffolding, na: false },
  ];

  const headerRow = tableRow([
    tableCellSimple("Category", "D9E2F3", true),
    tableCellSimple("Score", "D9E2F3", true),
    tableCellSimple("Max", "D9E2F3", true),
    tableCellSimple("Findings", "D9E2F3", true),
  ]);
  const dataRows = catRows.map(({ name, cs, na }) => {
    return tableRow([
      tableCellSimple(name),
      tableCellSimple(na ? "N/A" : String(cs?.score ?? 0)),
      tableCellSimple(na ? "N/A" : String(cs?.maxScore ?? 0)),
      tableCellSimple(na ? "N/A" : String(cs?.findings ?? 0)),
    ]);
  }).join("");

  parts.push(wrapTable(headerRow + dataRows));
  parts.push(hr());
  return parts.join("\n    ");
}

function buildDocxIntentSection(result: ScanResult): string {
  const parts: string[] = [];
  parts.push(para("2. CODEBASE INTENT", "Heading1"));
  parts.push(para("The following patterns represent the dominant approach established by the majority of files in this codebase."));
  parts.push(para(""));

  // result.driftFindings already excludes below-floor security findings
  // (scoredDriftView at the scan source), so a thin finding's pattern is never
  // presented as established codebase intent while its category scores N/A.
  const driftFindings = result.driftFindings ?? [];
  const intentSeen = new Set<string>();
  for (const d of driftFindings) {
    const key = d.driftCategory + "::" + d.dominantPattern;
    if (intentSeen.has(key)) continue;
    intentSeen.add(key);
    parts.push(boldPara(`${d.driftCategory.replace(/_/g, " ").toUpperCase()}: ${d.dominantPattern}`));
    parts.push(para(`  ${d.dominantCount} of ${d.totalRelevantFiles} files follow this pattern (${d.consistencyScore}% consistency)`));
  }
  if (intentSeen.size === 0) parts.push(para("No dominant patterns detected — codebase may be too small or highly consistent."));
  parts.push(hr());
  return parts.join("\n    ");
}

function buildDocxDriftSection(result: ScanResult): string {
  const parts: string[] = [];
  parts.push(para("3. DRIFT FINDINGS", "Heading1"));
  // result.driftFindings already excludes below-floor security findings
  // (scoredDriftView at the scan source), so a thin finding is never listed as
  // a scored drift finding here and the count matches what is listed.
  const driftFindings = result.driftFindings ?? [];
  parts.push(para(`${driftFindings.length} cross-file contradictions detected.`));
  parts.push(para(""));

  for (const d of driftFindings) {
    const sevStr = d.severity === "error" ? "CRITICAL" : d.severity === "warning" ? "WARNING" : "INFO";
    parts.push(para(`[${sevStr}] ${d.finding}`, "Heading2"));
    parts.push(para(`Category: ${d.driftCategory.replace(/_/g, " ")} | Consistency: ${d.consistencyScore}% | Confidence: ${Math.round(d.confidence * 100)}%`));
    parts.push(para(""));

    parts.push(boldPara("INTENT (DOMINANT PATTERN)", "10B981"));
    parts.push(para(`Pattern: ${d.dominantPattern} — used by ${d.dominantCount} of ${d.totalRelevantFiles} files`));
    parts.push(para(""));

    parts.push(boldPara("DEVIATING FILES", "F97316"));
    for (const df of d.deviatingFiles) {
      parts.push(para(`  File: ${df.path}`));
      parts.push(para(`  Pattern: ${df.detectedPattern}`));
      for (const ev of df.evidence.slice(0, 3)) {
        parts.push(para(`    Line ${ev.line}: ${ev.code.slice(0, 100)}`, "Code"));
      }
      parts.push(para(""));
    }

    parts.push(boldPara("Pattern Distribution:"));
    parts.push(para(`  ${d.dominantPattern}: ${d.dominantCount} files (${Math.round((d.dominantCount / d.totalRelevantFiles) * 100)}%)`));
    parts.push(para(`  Deviating: ${d.totalRelevantFiles - d.dominantCount} files (${Math.round(((d.totalRelevantFiles - d.dominantCount) / d.totalRelevantFiles) * 100)}%)`));
    parts.push(para(""));

    if (d.recommendation) {
      parts.push(boldPara("RECOMMENDATION:", "00D4FF"));
      parts.push(para(`  ${d.recommendation}`));
    }
    parts.push(hr());
  }
  return parts.join("\n    ");
}

function docxDnaDuplicates(dna: any): string[] {
  if (!dna.duplicateGroups?.length) return [];
  const parts: string[] = [];
  parts.push(para("Semantic Fingerprint Duplicates", "Heading2"));
  for (const g of dna.duplicateGroups) {
    const fns = g.functions.map((f: any) => `${f.name}() in ${f.relativePath || f.file}`).join(", ");
    parts.push(para(`  Group: ${fns}`));
  }
  parts.push(para(""));
  return parts;
}

function docxDnaSequences(dna: any): string[] {
  if (!dna.sequenceSimilarities?.length) return [];
  const parts: string[] = [];
  parts.push(para("Operation Sequence Matches", "Heading2"));
  for (const s of dna.sequenceSimilarities) {
    parts.push(para(`  ${Math.round(s.similarity * 100)}% match: ${s.functionA.name}() in ${s.functionA.relativePath || s.functionA.file} ↔ ${s.functionB.name}() in ${s.functionB.relativePath || s.functionB.file}`));
  }
  parts.push(para(""));
  return parts;
}

function docxDnaTaintFlows(dna: any): string[] {
  if (!dna.taintFlows?.length) return [];
  const parts: string[] = [];
  parts.push(para("Taint Flows", "Heading2"));
  for (const t of dna.taintFlows) {
    parts.push(para(`  [${t.sink.severity.toUpperCase()}] ${t.functionName}() in ${t.relativePath || t.file}: ${t.source.type} (line ${t.source.line}) → ${t.sink.type} (line ${t.sink.line}) — ${t.sanitized ? "SANITIZED" : "UNSANITIZED"}`));
  }
  parts.push(para(""));
  return parts;
}

function docxDnaDeviations(dna: any): string[] {
  if (!dna.deviationJustifications?.length) return [];
  const parts: string[] = [];
  parts.push(para("Deviation Justification Analysis", "Heading2"));
  for (const dj of dna.deviationJustifications) {
    const verdict = dj.verdict === "likely_justified" ? "JUSTIFIED" : dj.verdict === "likely_accidental" ? "ACCIDENTAL" : "UNCERTAIN";
    parts.push(para(`  [${verdict}] ${dj.relativePath || dj.file}: uses ${dj.deviatingPattern} vs project ${dj.dominantPattern} (score: ${Math.round(dj.justificationScore * 100)}%)`));
  }
  parts.push(para(""));
  return parts;
}

function docxDnaPatterns(dna: any): string[] {
  if (!dna.patternDistributions?.length) return [];
  const parts: string[] = [];
  parts.push(para("Pattern Classification", "Heading2"));
  for (const pd of dna.patternDistributions) {
    const mixed = pd.isInternallyInconsistent ? " [MIXED]" : "";
    parts.push(para(`  ${pd.relativePath || pd.file}: ${pd.dominantPattern} (${Math.round(pd.confidence * 100)}% confidence)${mixed}`));
  }
  parts.push(para(""));
  return parts;
}

function buildDocxCodeDnaSection(result: ScanResult): string {
  const dna = result.codeDnaResult;
  if (!dna) return "";

  const parts: string[] = [];
  parts.push(para("4. CODE DNA ANALYSIS", "Heading1"));
  parts.push(para(`${dna.functions?.length ?? 0} functions analyzed in ${dna.timings?.totalMs ?? 0}ms. ${dna.findings?.length ?? 0} findings.`));
  parts.push(para(""));

  parts.push(
    ...docxDnaDuplicates(dna),
    ...docxDnaSequences(dna),
    ...docxDnaTaintFlows(dna),
    ...docxDnaDeviations(dna),
    ...docxDnaPatterns(dna),
  );
  parts.push(hr());
  return parts.join("\n    ");
}

function buildDocxPerFileTable(result: ScanResult): string {
  const parts: string[] = [];
  parts.push(para("5. FILE RANKING", "Heading1"));
  const fileSorted = [...result.perFileScores.entries()].sort((a, b) => a[1].score - b[1].score);
  parts.push(para(`${fileSorted.length} files scanned. Ranked worst to best.`));
  parts.push(para(""));

  const fileHeaderRow = tableRow([
    tableCellSimple("File", "D9E2F3", true),
    tableCellSimple("Score", "D9E2F3", true),
    tableCellSimple("Drift", "D9E2F3", true),
    tableCellSimple("Static", "D9E2F3", true),
  ]);
  const fileDataRows = fileSorted.slice(0, 40).map(([path, data]) => {
    const driftCount = data.findings.filter((f) => f.tags?.includes("drift") || f.tags?.includes("codedna")).length;
    const staticCount = data.findings.length - driftCount;
    return tableRow([
      tableCellSimple(path),
      tableCellSimple(`${data.score}/100`),
      tableCellSimple(String(driftCount)),
      tableCellSimple(String(staticCount)),
    ]);
  }).join("");

  parts.push(wrapTable(fileHeaderRow + fileDataRows));
  parts.push(hr());
  return parts.join("\n    ");
}

function buildDocxFindingsTable(result: ScanResult): string {
  const parts: string[] = [];
  parts.push(para("6. STATIC ANALYSIS FINDINGS", "Heading1"));
  // This is DOCX's only general (non-drift) findings section. Include every
  // hygiene-kind finding here, even one that carries a legacy "drift" tag: a
  // route-consistency security finding demoted below the peer floor is now
  // hygiene-kind (analyzerId security_posture-advisory) but still tagged
  // "drift" from its origin, and it is (correctly) excluded from the drift
  // sections above. Without this kind-aware clause it would be filtered out
  // here too and vanish from the DOCX entirely, going silent on exactly the
  // small insecure repos this floor exists to keep visible.
  const statics = result.findings.filter((f) =>
    getAnalyzerKind(f.analyzerId) === "hygiene" ||
    (!f.tags?.includes("drift") && !f.tags?.includes("codedna")),
  );
  parts.push(para(`${statics.length} findings from ${13} static analyzers.`));
  parts.push(para(""));

  for (const f of statics.slice(0, 50)) {
    const loc = f.locations[0];
    const sevStr = f.severity === "error" ? "ERROR" : f.severity === "warning" ? "WARNING" : "INFO";
    parts.push(para(`[${sevStr}] [${f.analyzerId}] ${f.message}`));
    if (loc) parts.push(para(`  File: ${loc.file}${loc.line ? `:${loc.line}` : ""} | Confidence: ${Math.round(f.confidence * 100)}%`));
  }
  if (statics.length > 50) parts.push(para(`... and ${statics.length - 50} more findings.`));
  parts.push(hr());
  return parts.join("\n    ");
}

function buildDocxDeepInsights(result: ScanResult): string {
  if ((result.deepInsights ?? []).length === 0) return "";

  const parts: string[] = [];
  parts.push(para("7. DEEP ANALYSIS INSIGHTS (AI-POWERED)", "Heading1"));
  for (const ins of result.deepInsights) {
    const sevStr = ins.severity === "error" ? "CRITICAL" : ins.severity === "warning" ? "WARNING" : "INFO";
    parts.push(para(`[${sevStr}] ${ins.title}`, "Heading2"));
    parts.push(para(ins.description));
    if (ins.relatedFiles.length > 0) parts.push(para(`  Files: ${ins.relatedFiles.join(", ")}`));
    if (ins.recommendation) {
      parts.push(boldPara("Recommendation:", "00D4FF"));
      parts.push(para(`  ${ins.recommendation}`));
    }
    parts.push(para(""));
  }
  parts.push(hr());
  return parts.join("\n    ");
}

function buildDocxFooter(result: ScanResult): string {
  const parts: string[] = [];
  parts.push(para(""));
  parts.push(para(`Generated by VibeDrift v${getVersion()} | ${result.context.files.length} files | ${formatCount(result.context.totalLines)} lines | ${(result.scanTimeMs / 1000).toFixed(1)}s | Your source code never leaves your machine`));
  parts.push(para("Re-scan: npx vibedrift ."));
  return parts.join("\n    ");
}

// ──── Document Body Builder ────

function buildDocumentXml(result: ScanResult): string {
  const sections = [
    buildDocxTitlePage(result),
    buildDocxScoreTable(result),
    buildDocxIntentSection(result),
    buildDocxDriftSection(result),
    buildDocxCodeDnaSection(result),
    buildDocxPerFileTable(result),
    buildDocxFindingsTable(result),
    buildDocxDeepInsights(result),
    buildDocxFooter(result),
  ].filter(Boolean);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>
    ${sections.join("\n    ")}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

// ──── Public API ────

export function renderDocxReport(result: ScanResult): Buffer {
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes(), "utf-8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels(), "utf-8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(docRels(), "utf-8") },
    { name: "word/styles.xml", data: Buffer.from(styles(), "utf-8") },
    { name: "word/document.xml", data: Buffer.from(buildDocumentXml(result), "utf-8") },
  ];
  return buildZip(entries);
}
