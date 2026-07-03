/**
 * QA findings → editor navigation + Problems-panel diagnostics (E4, pure half).
 *
 * IMPORTANT contract nuance: the engine's `report --json` qaFindings carry
 * `{unitSeq, verdict, severity, reviewer, claim, evidence}` — they do NOT carry an
 * explicit `file` or `line` field (verified against wrk2gthr
 * src/orchestrator/report.ts `reportData`). So a navigable location has to be
 * recovered heuristically from the free-text `claim`/`evidence` (e.g. a
 * "src/foo.ts:42" token). Findings with no recoverable location are still shown
 * in the findings list but cannot be a jump target or an inline squiggle — that
 * limitation is a documented engine gap (docs/ENGINE-GAPS.md), not a bug here.
 *
 * All functions here are pure (no vscode, no fs) so they are unit-testable
 * headlessly. The vscode shell (src/findings.ts) turns these descriptors into
 * showTextDocument + a DiagnosticCollection.
 */
import { isAbsolute, join, normalize } from "node:path";

import type { QaFinding } from "../engine/contract.js";

/** A recovered source location (1-based line, matching editor/gutter convention). */
export interface FindingLocation {
  /** Absolute filesystem path, resolved against the run's build target. */
  fsPath: string;
  /** 1-based line number (as written in the finding text). */
  line: number;
  /** The raw "file:line" token we matched, for tooltips/debug. */
  raw: string;
}

/** Severity buckets the shell maps to vscode.DiagnosticSeverity. */
export type FindingSeverity = "error" | "warning" | "info";

/** A pure, vscode-free description of one diagnostic. */
export interface DiagnosticDescriptor {
  fsPath: string;
  /** 1-based line (shell converts to 0-based Range). */
  line: number;
  severity: FindingSeverity;
  message: string;
  /** "unit N · reviewer" — rendered as the diagnostic source. */
  source: string;
}

/**
 * Provenance gate for NAVIGATION: a finding may only open/squiggle a file when the
 * run's build target is KNOWN (a run driven this session, tracked in the `targets`
 * map). For a run whose target we don't know, `buildTargetFor` falls back to
 * conclave.targetDir → the workspace root — and a same-named file there would be a
 * SILENT wrong-tree jump. So navigation resolves only against a provenance-known
 * target; otherwise it refuses with the same clear message the diff path uses.
 * Pure + testable; the shell supplies `knownTarget = targets.get(run) ?? null`.
 */
export function navigableTarget(
  knownTarget: string | null | undefined
): { ok: true; target: string } | { ok: false; reason: string; hint: string } {
  if (knownTarget && knownTarget.trim()) return { ok: true, target: knownTarget };
  return {
    ok: false,
    reason: "Conclave only knows the build target of runs it drove this session",
    hint: "Drive this run from here (or set conclave.targetDir) so findings resolve against the run's produced code — not an arbitrary same-named file in another tree."
  };
}

// A file token: a path segment ending in `.ext`, optionally `:line` / `:line:col`.
// Anchored on a path-like run of chars so prose words with dots don't false-match.
const FILE_LINE_RE = /([A-Za-z0-9_.\-/\\]*[A-Za-z0-9_\-/\\]\.[A-Za-z0-9]+):(\d+)(?::\d+)?/;
// Secondary: "src/foo.ts (line 42)" or "src/foo.ts line 42".
const FILE_THEN_LINE_RE = /([A-Za-z0-9_.\-/\\]*[A-Za-z0-9_\-/\\]\.[A-Za-z0-9]+)\s*\(?\bline\s+(\d+)/i;

/**
 * Recover a `{ file, line }` from arbitrary finding text. Returns the file token
 * (verbatim, still relative or absolute as written) + a 1-based line, or null.
 * Pure string work — resolution against the build target happens in
 * {@link findingLocation}.
 */
export function parseLocationFromText(text: string): { file: string; line: number; raw: string } | null {
  if (!text) return null;
  const direct = FILE_LINE_RE.exec(text);
  if (direct) {
    return { file: direct[1], line: Number(direct[2]), raw: direct[0] };
  }
  const spaced = FILE_THEN_LINE_RE.exec(text);
  if (spaced) {
    return { file: spaced[1], line: Number(spaced[2]), raw: spaced[0] };
  }
  return null;
}

/**
 * Resolve a finding to an absolute file location under the run's build target.
 * Scans `evidence` first (usually where the reviewer cites the offending line),
 * then `claim`. Absolute paths are kept as-is; relative paths join the target
 * root. Returns null when no location is recoverable (non-navigable finding).
 */
export function findingLocation(finding: QaFinding, targetRoot: string): FindingLocation | null {
  const hit = parseLocationFromText(finding.evidence) ?? parseLocationFromText(finding.claim);
  if (!hit) return null;
  const file = hit.file.replace(/\\/g, "/");
  const fsPath = isAbsolute(file) ? normalize(file) : normalize(join(targetRoot, file));
  return { fsPath, line: hit.line > 0 ? hit.line : 1, raw: hit.raw };
}

/** Map a finding's severity/verdict to a diagnostic bucket. A failing verdict is
 *  at least a warning even if the recorded severity reads "low". */
export function findingSeverity(finding: Pick<QaFinding, "severity" | "verdict">): FindingSeverity {
  const sev = (finding.severity ?? "").toLowerCase();
  const failed = (finding.verdict ?? "").toLowerCase() !== "pass";
  if (sev === "high" || sev === "critical" || sev === "blocker") return "error";
  if (sev === "medium" || sev === "moderate") return "warning";
  if (failed) return "warning";
  return "info";
}

/** A human-readable one-line message for a finding. */
export function findingMessage(finding: QaFinding): string {
  const verdict = finding.verdict ? `${finding.verdict.toUpperCase()}: ` : "";
  const claim = finding.claim?.trim() || "(no claim recorded)";
  const evidence = finding.evidence?.trim();
  return evidence && evidence !== claim ? `${verdict}${claim} — ${evidence}` : `${verdict}${claim}`;
}

/**
 * Build a pure Diagnostic descriptor for a finding, or null if it has no
 * recoverable file location (can't squiggle a file we can't point at).
 */
export function findingToDiagnostic(finding: QaFinding, targetRoot: string): DiagnosticDescriptor | null {
  const loc = findingLocation(finding, targetRoot);
  if (!loc) return null;
  return {
    fsPath: loc.fsPath,
    line: loc.line,
    severity: findingSeverity(finding),
    message: findingMessage(finding),
    source: `unit ${finding.unitSeq} · ${finding.reviewer}`
  };
}

/**
 * Group findings into per-file diagnostic descriptors (the shape a
 * DiagnosticCollection wants). Returns the grouped map plus the count of findings
 * that had no recoverable location (surfaced to the user honestly).
 */
export function findingsToDiagnostics(
  findings: QaFinding[],
  targetRoot: string
): { byFile: Map<string, DiagnosticDescriptor[]>; unlocated: number } {
  const byFile = new Map<string, DiagnosticDescriptor[]>();
  let unlocated = 0;
  for (const f of findings) {
    const d = findingToDiagnostic(f, targetRoot);
    if (!d) {
      unlocated++;
      continue;
    }
    const arr = byFile.get(d.fsPath) ?? [];
    arr.push(d);
    byFile.set(d.fsPath, arr);
  }
  return { byFile, unlocated };
}
