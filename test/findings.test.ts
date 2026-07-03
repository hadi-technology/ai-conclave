/**
 * Headless unit tests for the E4 QA-findings pure logic: recovering a file:line
 * from finding text (which the contract does NOT carry structurally), resolving it
 * against the build target, and mapping findings → diagnostics.
 */
import { describe, expect, it } from "vitest";

import {
  parseLocationFromText,
  findingLocation,
  findingSeverity,
  findingMessage,
  findingToDiagnostic,
  findingsToDiagnostics,
  navigableTarget,
  resolveBuildTarget
} from "../src/viewmodels/findings.js";
import type { QaFinding } from "../src/engine/contract.js";

const finding = (over: Partial<QaFinding>): QaFinding => ({
  unitSeq: 1,
  verdict: "fail",
  severity: "high",
  reviewer: "b",
  claim: "",
  evidence: "",
  ...over
});

describe("parseLocationFromText", () => {
  it("recovers file:line", () => {
    expect(parseLocationFromText("bug at src/parser.ts:42 in the loop")).toEqual({
      file: "src/parser.ts",
      line: 42,
      raw: "src/parser.ts:42"
    });
  });

  it("recovers file:line:col (drops col)", () => {
    expect(parseLocationFromText("see lib/util.js:10:5")).toMatchObject({ file: "lib/util.js", line: 10 });
  });

  it("recovers 'file (line N)' prose form", () => {
    expect(parseLocationFromText("the guard in src/a.ts line 7 is wrong")).toMatchObject({
      file: "src/a.ts",
      line: 7
    });
  });

  it("returns null when no location is present", () => {
    expect(parseLocationFromText("the plan is missing an acceptance criterion")).toBeNull();
    expect(parseLocationFromText("")).toBeNull();
  });

  it("does not false-match a bare sentence with a dot", () => {
    expect(parseLocationFromText("This is fine. Nothing to see.")).toBeNull();
  });
});

describe("findingLocation", () => {
  it("resolves a relative path against the build target", () => {
    const loc = findingLocation(finding({ evidence: "off-by-one at src/x.ts:5" }), "/tmp/build-run");
    expect(loc).toEqual({ fsPath: "/tmp/build-run/src/x.ts", line: 5, raw: "src/x.ts:5" });
  });

  it("keeps an absolute path as-is", () => {
    const loc = findingLocation(finding({ evidence: "at /abs/y.ts:9" }), "/tmp/build");
    expect(loc?.fsPath).toBe("/abs/y.ts");
  });

  it("prefers evidence, falls back to claim", () => {
    const loc = findingLocation(finding({ claim: "src/from-claim.ts:3", evidence: "no location here" }), "/t");
    expect(loc?.fsPath).toBe("/t/src/from-claim.ts");
  });

  it("returns null for a non-locatable finding", () => {
    expect(findingLocation(finding({ claim: "vague", evidence: "also vague" }), "/t")).toBeNull();
  });

  it("clamps a zero/negative line to 1", () => {
    const loc = findingLocation(finding({ evidence: "src/z.ts:0" }), "/t");
    expect(loc?.line).toBe(1);
  });
});

describe("findingLocation — prefers structured contract file/line (schema 2)", () => {
  it("uses the structured file/line directly, resolving a relative path under the target", () => {
    const loc = findingLocation(finding({ file: "src/parser.ts", line: 42 }), "/tmp/build-run");
    expect(loc).toEqual({ fsPath: "/tmp/build-run/src/parser.ts", line: 42, raw: "src/parser.ts:42" });
  });

  it("keeps a structured absolute path as-is", () => {
    const loc = findingLocation(finding({ file: "/abs/y.ts", line: 9 }), "/tmp/build");
    expect(loc?.fsPath).toBe("/abs/y.ts");
    expect(loc?.line).toBe(9);
  });

  it("structured file WINS over a different location cited in the prose", () => {
    // evidence prose points at src/prose.ts:99, but the structured field is authoritative.
    const loc = findingLocation(
      finding({ file: "src/structured.ts", line: 7, evidence: "actually see src/prose.ts:99" }),
      "/t"
    );
    expect(loc).toEqual({ fsPath: "/t/src/structured.ts", line: 7, raw: "src/structured.ts:7" });
  });

  it("structured file with null/zero line clamps to line 1", () => {
    expect(findingLocation(finding({ file: "src/x.ts", line: null }), "/t")?.line).toBe(1);
    expect(findingLocation(finding({ file: "src/x.ts", line: 0 }), "/t")?.line).toBe(1);
  });

  it("FALLS BACK to the prose heuristic when the contract omits file/line", () => {
    // file/line null (engine cited no path:line) → recover from evidence text.
    const loc = findingLocation(finding({ file: null, line: null, evidence: "off-by-one at src/x.ts:5" }), "/tmp/b");
    expect(loc).toEqual({ fsPath: "/tmp/b/src/x.ts", line: 5, raw: "src/x.ts:5" });
  });

  it("returns null when neither structured nor prose location exists", () => {
    expect(findingLocation(finding({ file: null, line: null, claim: "vague", evidence: "vague" }), "/t")).toBeNull();
  });
});

describe("resolveBuildTarget — provenance-correct target (session OR engine contract)", () => {
  it("prefers the session target over the engine-reported one", () => {
    expect(resolveBuildTarget("/session/target", { target: "/engine/target", workingDir: "/wd" })).toBe(
      "/session/target"
    );
  });

  it("uses the engine-reported target for a run NOT driven this session", () => {
    expect(resolveBuildTarget(null, { target: "/engine/target", workingDir: "/wd" })).toBe("/engine/target");
  });

  it("falls back to workingDir when no session target and no engine target", () => {
    expect(resolveBuildTarget(null, { target: null, workingDir: "/run/working_dir" })).toBe("/run/working_dir");
  });

  it("refuses (null) when nothing authoritative is available — never an arbitrary tree", () => {
    expect(resolveBuildTarget(null, { target: null, workingDir: null })).toBeNull();
    expect(resolveBuildTarget(undefined, undefined)).toBeNull();
    expect(resolveBuildTarget(null, null)).toBeNull();
  });

  it("ignores blank/whitespace values at every level", () => {
    expect(resolveBuildTarget("   ", { target: "  ", workingDir: "/real" })).toBe("/real");
    expect(resolveBuildTarget("", { target: "", workingDir: "" })).toBeNull();
  });

  it("resolved contract target then navigates a finding under THAT tree", () => {
    const target = resolveBuildTarget(null, { target: "/attached/build", workingDir: "/wd" });
    expect(target).toBe("/attached/build");
    const loc = findingLocation(finding({ file: "src/a.ts", line: 3 }), target as string);
    expect(loc?.fsPath).toBe("/attached/build/src/a.ts");
  });
});

describe("findingSeverity", () => {
  it("high/critical → error", () => {
    expect(findingSeverity({ severity: "high", verdict: "fail" })).toBe("error");
    expect(findingSeverity({ severity: "critical", verdict: "fail" })).toBe("error");
  });
  it("medium → warning", () => {
    expect(findingSeverity({ severity: "medium", verdict: "fail" })).toBe("warning");
  });
  it("low+fail → warning (a failure is never merely info)", () => {
    expect(findingSeverity({ severity: "low", verdict: "fail" })).toBe("warning");
  });
  it("low+pass → info", () => {
    expect(findingSeverity({ severity: "low", verdict: "pass" })).toBe("info");
  });
});

describe("findingMessage", () => {
  it("joins verdict + claim + evidence", () => {
    expect(findingMessage(finding({ claim: "leaks fd", evidence: "src/a.ts:1 no close" }))).toBe(
      "FAIL: leaks fd — src/a.ts:1 no close"
    );
  });
  it("omits duplicate evidence", () => {
    expect(findingMessage(finding({ claim: "same", evidence: "same" }))).toBe("FAIL: same");
  });
});

describe("navigableTarget — provenance gate (prevents silent wrong-tree jump)", () => {
  it("refuses navigation when the run's target is not known this session", () => {
    // A run NOT driven this session → knownBuildTargetFor(run) === null.
    for (const notKnown of [null, undefined, "", "   "]) {
      const res = navigableTarget(notKnown);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected refusal");
      expect(res.reason).toContain("only knows the build target of runs it drove");
      expect(res.hint).toContain("Drive this run");
    }
  });

  it("allows navigation for a driven run (known target) and the finding resolves under it", () => {
    const res = navigableTarget("/tmp/build-driven-run");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.target).toBe("/tmp/build-driven-run");
    // and the finding then resolves a real path under THAT tree (not an arbitrary one)
    const loc = findingLocation(finding({ evidence: "bug at src/a.ts:3" }), res.target);
    expect(loc?.fsPath).toBe("/tmp/build-driven-run/src/a.ts");
  });

  it("a non-driven-run finding never yields a file to open (gate short-circuits before findingLocation)", () => {
    const knownTarget: string | null = null; // non-driven run
    const gate = navigableTarget(knownTarget);
    // The shell returns the clear error here and NEVER calls findingLocation/open.
    expect(gate.ok).toBe(false);
  });
});

describe("findingToDiagnostic / findingsToDiagnostics", () => {
  it("builds a descriptor for a locatable finding", () => {
    const d = findingToDiagnostic(finding({ severity: "high", evidence: "src/a.ts:12 bad" }), "/root");
    expect(d).toMatchObject({ fsPath: "/root/src/a.ts", line: 12, severity: "error", source: "unit 1 · b" });
  });

  it("returns null for a non-locatable finding", () => {
    expect(findingToDiagnostic(finding({ claim: "vague", evidence: "vague" }), "/root")).toBeNull();
  });

  it("groups by file and counts the unlocatable ones", () => {
    const findings: QaFinding[] = [
      finding({ unitSeq: 1, evidence: "src/a.ts:1 x" }),
      finding({ unitSeq: 2, evidence: "src/a.ts:9 y" }),
      finding({ unitSeq: 3, evidence: "src/b.ts:2 z" }),
      finding({ unitSeq: 4, claim: "no location", evidence: "still none" })
    ];
    const { byFile, unlocated } = findingsToDiagnostics(findings, "/root");
    expect(unlocated).toBe(1);
    expect(byFile.get("/root/src/a.ts")).toHaveLength(2);
    expect(byFile.get("/root/src/b.ts")).toHaveLength(1);
  });
});
