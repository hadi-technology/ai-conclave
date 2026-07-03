/**
 * Headless unit tests for E4 native-diff ref resolution — deriving the git refs a
 * native diff should show from report.units[].commit and report.merges[], and the
 * pure git argv builders.
 */
import { describe, expect, it } from "vitest";

import {
  resolveUnitDiffRefs,
  resolveIntegrationDiffRefs,
  gitShowArgs,
  gitDiffNameOnlyArgs,
  gitRevParseArgs,
  parseNameOnly
} from "../src/viewmodels/diffref.js";
import type { Report } from "../src/engine/contract.js";

describe("resolveUnitDiffRefs", () => {
  it("diffs a unit's commit against its parent", () => {
    const refs = resolveUnitDiffRefs({ seq: 3, title: "add parser", commit: "abc12345", status: "done" });
    expect(refs).toMatchObject({ left: "abc12345^", right: "abc12345", label: "unit 3: add parser" });
  });

  it("returns null when the unit has no commit yet", () => {
    expect(resolveUnitDiffRefs({ seq: 1, title: "queued", commit: null, status: "queued" })).toBeNull();
    expect(resolveUnitDiffRefs({ seq: 1, title: "blank", commit: "  ", status: "building" })).toBeNull();
  });
});

describe("resolveIntegrationDiffRefs", () => {
  const base = "origin/main";

  it("returns null when there are no merges", () => {
    expect(resolveIntegrationDiffRefs([], base)).toBeNull();
  });

  it("prefers a reconciled merge commit", () => {
    const merges: Report["merges"] = [
      { kind: "clean", branch: "unit-1", commit: null },
      { kind: "reconciled", branch: "integration", commit: "def67890" }
    ];
    const refs = resolveIntegrationDiffRefs(merges, base);
    expect(refs).toMatchObject({ left: "origin/main", right: "def67890" });
  });

  it("falls back to the last merge branch when no commit is present", () => {
    const merges: Report["merges"] = [{ kind: "clean", branch: "integration", commit: null }];
    const refs = resolveIntegrationDiffRefs(merges, base);
    expect(refs).toMatchObject({ left: "origin/main", right: "integration" });
  });
});

describe("git argv builders", () => {
  it("gitShowArgs", () => {
    expect(gitShowArgs("abc^", "src/a.ts")).toEqual(["show", "abc^:src/a.ts"]);
  });
  it("gitDiffNameOnlyArgs", () => {
    expect(gitDiffNameOnlyArgs("abc^", "abc")).toEqual(["diff", "--name-only", "abc^", "abc"]);
  });
  it("gitRevParseArgs", () => {
    expect(gitRevParseArgs("abc^")).toEqual(["rev-parse", "--verify", "--quiet", "abc^"]);
  });
  it("parseNameOnly trims and drops blanks", () => {
    expect(parseNameOnly("src/a.ts\n  src/b.ts \n\n")).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
