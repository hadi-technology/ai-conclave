/**
 * QA findings → editor navigation + Problems-panel diagnostics (E4, pure half).
 *
 * Contract (schema 2): each `report --json` qaFinding now carries structured
 * `file` + `line` (parsed by the engine at QA time from the reviewer's cited
 * `path:line`; both null when none was cited). We PREFER that structured location
 * — it makes jump-to-finding reliable — and fall back to the free-text heuristic
 * (`parseLocationFromText` over `evidence`/`claim`) ONLY when the contract omits
 * it (older engines, or a finding with no cited location). Findings with neither a
 * structured nor a recoverable location are still shown in the list but cannot be
 * a jump target or an inline squiggle — that residual limitation is surfaced to
 * the user (a count), not a silent drop.
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
 * run's build target is provenance-KNOWN. The shell supplies that target from
 * {@link resolveBuildTarget} — the session `targets` map OR the engine-reported
 * `target`/`workingDir` (schema 2), both authoritative. When none is available the
 * gate refuses (rather than falling back to conclave.targetDir → the workspace
 * root, where a same-named file would be a SILENT wrong-tree jump). Pure + testable.
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
 *
 * PREFERS the contract's structured `file`/`line` (schema 2) — authoritative, no
 * guessing. Falls back to the heuristic ONLY when the contract omits a location:
 * scans `evidence` first (usually where the reviewer cites the offending line),
 * then `claim`. Absolute paths are kept as-is; relative paths join the target
 * root. Returns null when neither a structured nor a recoverable location exists.
 */
export function findingLocation(finding: QaFinding, targetRoot: string): FindingLocation | null {
  // 1) Structured contract location wins when present.
  if (typeof finding.file === "string" && finding.file.trim()) {
    const line = typeof finding.line === "number" && finding.line > 0 ? finding.line : 1;
    return { fsPath: resolveUnderTarget(finding.file, targetRoot), line, raw: `${finding.file}:${line}` };
  }
  // 2) Fall back to recovering a location from the free-text prose.
  const hit = parseLocationFromText(finding.evidence) ?? parseLocationFromText(finding.claim);
  if (!hit) return null;
  return { fsPath: resolveUnderTarget(hit.file, targetRoot), line: hit.line > 0 ? hit.line : 1, raw: hit.raw };
}

/** Resolve a finding's path against the build target: absolute kept as-is,
 *  relative joined under the target root. Backslashes normalized to `/`. */
function resolveUnderTarget(file: string, targetRoot: string): string {
  const clean = file.replace(/\\/g, "/");
  return isAbsolute(clean) ? normalize(clean) : normalize(join(targetRoot, clean));
}

/**
 * Provenance-correct build-target resolution for a run's PRODUCED CODE.
 *
 * Priority (all authoritative — never an arbitrary same-named tree):
 *   1. `sessionTarget` — the target the extension itself drove this run into
 *      (the `targets` map). Highest trust.
 *   2. `contract.target` — the engine-reported effective build target (schema 2).
 *      Authoritative even for runs this session did NOT drive (attach-only).
 *   3. `contract.workingDir` — the run's working dir, as a last authoritative
 *      fallback when no `--target` was pinned.
 * Returns null when none is available — the caller MUST then refuse (never fall
 * back to the workspace root, which risks a silent wrong-tree jump/squiggle).
 */
export function resolveBuildTarget(
  sessionTarget: string | null | undefined,
  contract: { target?: string | null; workingDir?: string | null } | null | undefined
): string | null {
  if (sessionTarget && sessionTarget.trim()) return sessionTarget;
  const t = contract?.target;
  if (typeof t === "string" && t.trim()) return t;
  const wd = contract?.workingDir;
  if (typeof wd === "string" && wd.trim()) return wd;
  return null;
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
