import { describe, expect, it } from "vitest";

import { assessPatchBehaviorRisk } from "../src/core/behavior-guard";

describe("assessPatchBehaviorRisk", () => {
  it("allows formatting-only changes in source files", () => {
    const patch = [
      "diff --git a/src/sum.js b/src/sum.js",
      "--- a/src/sum.js",
      "+++ b/src/sum.js",
      "@@ -1 +1 @@",
      "-export function sum(a,b){return a+b;}",
      "+export function sum(a, b) { return a + b; }"
    ].join("\n");

    const result = assessPatchBehaviorRisk(patch);
    expect(result.safe).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("blocks semantic token changes in source files", () => {
    const patch = [
      "diff --git a/src/sum.js b/src/sum.js",
      "--- a/src/sum.js",
      "+++ b/src/sum.js",
      "@@ -1 +1 @@",
      "-export function sum(a, b) { return a + b; }",
      "+export function sum(a, b) { return a - b; }"
    ].join("\n");

    const result = assessPatchBehaviorRisk(patch);
    expect(result.safe).toBe(false);
    expect(result.reasons[0]).toContain("semantic token changes");
  });

  it("allows test-file semantic changes", () => {
    const patch = [
      "diff --git a/test/sum.test.js b/test/sum.test.js",
      "--- a/test/sum.test.js",
      "+++ b/test/sum.test.js",
      "@@ -1 +1 @@",
      "-assert.equal(sum(1, 2), 3)",
      "+assert.strictEqual(sum(1, 2), 3)"
    ].join("\n");

    const result = assessPatchBehaviorRisk(patch);
    expect(result.safe).toBe(true);
  });

  it("blocks unsupported non-doc non-test file types", () => {
    const patch = [
      "diff --git a/scripts/migrate.sql b/scripts/migrate.sql",
      "--- a/scripts/migrate.sql",
      "+++ b/scripts/migrate.sql",
      "@@ -1 +1 @@",
      "-SELECT 1;",
      "+SELECT 2;"
    ].join("\n");

    const result = assessPatchBehaviorRisk(patch);
    expect(result.safe).toBe(false);
    expect(result.reasons[0]).toContain("unsupported source file type");
  });
});
