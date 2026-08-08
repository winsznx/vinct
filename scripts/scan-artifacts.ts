/**
 * Nothing in an artifact may be a secret.
 *
 * Artifacts are committed, so anything written into one is published. Two categories matter and
 * they fail differently.
 *
 * A credential is a live cost. A paid RPC carries its key in the URL, and a run that records its
 * own configuration writes that key down. Redacting the endpoints field was not enough: one run
 * printed its configuration at the top and the key arrived through the transcript instead, which
 * is why redaction now happens where text is retained rather than at each place somebody
 * remembered.
 *
 * Private incident material is the product's central claim. A claim, a decision, or a submission
 * nonce in a committed file would contradict the thing the whole design exists to hold, and no
 * amount of on-chain correctness would fix it.
 *
 *   pnpm scan-artifacts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["artifacts", "packages/test-vectors", "docs"];

interface Rule {
  name: string;
  pattern: RegExp;
  why: string;
  /**
   * Where the rule applies.
   *
   * Credential rules apply everywhere. Private-incident rules apply only to run records,
   * because `packages/test-vectors` holds fixtures generated from the reference model's
   * deterministic stand-ins. Nothing writes run data there, so a decision in a vector is a
   * fixture by construction, and a scanner that cannot say so is one people learn to ignore.
   */
  roots?: string[];
}

const RULES: Rule[] = [
  {
    name: "provider api key",
    // Anchored to a URL, because the shapes providers use overlap with things that are not
    // secrets. An unanchored 32-hex rule matched the System Program address, which is the most
    // public value in Solana.
    pattern:
      /https?:\/\/[^\s"']*\/(alch_[A-Za-z0-9_-]{16,}|hel_[A-Za-z0-9_-]{16,}|[a-f0-9]{32})\b|\/v2\/(?!<redacted>)[A-Za-z0-9_-]{20,}/,
    why: "a credential in a URL is spendable by anyone who reads this file",
  },
  {
    name: "api key parameter",
    pattern: /[?&](api[-_]?key|apikey|access[-_]?token|auth)=(?!<redacted>)[A-Za-z0-9_-]{8,}/i,
    why: "a credential in a query string",
  },
  {
    name: "private key material",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk_live_[A-Za-z0-9]{8,}/,
    why: "key material",
  },
  {
    name: "json web token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
    why: "a bearer token",
  },
  {
    name: "incident canary",
    pattern: /VINCT-[A-Z0-9]*-?(CLAIM|NOTES|CANARY)[A-Z0-9-]*/,
    why: "private incident text from a proof run",
    roots: ["artifacts"],
  },
  {
    name: "recorded decision",
    pattern: /"(decision|vote|ballot)"\s*:\s*"?(approve|reject|abstain)/i,
    why: "a member's decision, which is private to that member",
    roots: ["artifacts"],
  },
];

/**
 * Text that looks like a finding and is not.
 *
 * Documentation quotes these shapes on purpose, and a scanner that cannot be told so is a
 * scanner people start ignoring. Each exception is narrow and names the file it applies to.
 */
function isDocumentedExample(file: string, line: string): boolean {
  const inDocs = file.startsWith("docs/");
  if (!inDocs) return false;
  // The decision log and the audit quote redacted forms and error text verbatim.
  return line.includes("<redacted>") || line.includes("`") || line.trimStart().startsWith(">");
}

function walk(directory: string, files: string[]): void {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      // Playwright output is regenerated and gitignored; it holds videos, not evidence.
      if (entry === "test-results" || entry === "report" || entry === "node_modules") continue;
      walk(path, files);
    } else if (/\.(json|md|txt|log)$/.test(entry)) {
      files.push(path);
    }
  }
}

const files: string[] = [];
for (const root of ROOTS) walk(join(REPO_ROOT, root), files);

const findings: { file: string; line: number; rule: string; why: string; excerpt: string }[] = [];

for (const path of files) {
  const relativePath = relative(REPO_ROOT, path);
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.roots && !rule.roots.some((root) => relativePath.startsWith(root))) continue;
      const match = rule.pattern.exec(line);
      if (!match) continue;
      if (isDocumentedExample(relativePath, line)) continue;
      findings.push({
        file: relativePath,
        line: index + 1,
        rule: rule.name,
        why: rule.why,
        excerpt: match[0].slice(0, 60),
      });
    }
  });
}

console.log(`scanned ${files.length} committed files under ${ROOTS.join(", ")}`);

if (findings.length === 0) {
  console.log("no credential and no private incident material in any of them");
  process.exit(0);
}

console.error(`\n${findings.length} finding(s):`);
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}  ${finding.rule}`);
  console.error(`    ${finding.why}`);
  console.error(`    ${finding.excerpt}`);
}
process.exit(1);
