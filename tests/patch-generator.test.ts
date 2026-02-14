import { describe, expect, it, vi } from "vitest";

import { MinimaxOutputValidationError } from "../src/ai/minimax-agent";
import { OpenRouterError } from "../src/ai/openrouter-client";
import { PatchGenerator } from "../src/core/patch-generator";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
};

const buildChunks = () => [
  {
    files: ["src/a.ts"],
    diff: "diff --git a/src/a.ts b/src/a.ts",
    snapshots: [{ path: "src/a.ts", content: "a" }]
  },
  {
    files: ["src/b.ts"],
    diff: "diff --git a/src/b.ts b/src/b.ts",
    snapshots: [{ path: "src/b.ts", content: "b" }]
  },
  {
    files: ["src/c.ts"],
    diff: "diff --git a/src/c.ts b/src/c.ts",
    snapshots: [{ path: "src/c.ts", content: "c" }]
  }
];

const defaultGenerateOptions = {
  repository: "acme/repo",
  baseRef: "abc",
  headRef: "def"
};

describe("PatchGenerator", () => {
  it("continues processing other chunks when one chunk generation fails", async () => {
    const agent = {
      generatePatch: vi
        .fn()
        .mockRejectedValueOnce(new Error("This operation was aborted"))
        .mockResolvedValueOnce({ status: "no_changes", raw: "NO_CHANGES_NEEDED" })
        .mockResolvedValueOnce({
          status: "patch",
          patch: "diff --git a/src/c.ts b/src/c.ts\n--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1 @@\n-c\n+c ",
          raw: "patch"
        }),
      repairPatch: vi.fn()
    };

    const generator = new PatchGenerator(agent as never, logger);
    const result = await generator.generate({ ...defaultGenerateOptions, chunks: buildChunks() });

    expect(result.patches).toHaveLength(1);
    expect(result.skippedChunks).toBe(1);
    expect(result.failedChunks).toBe(1);
    expect(result.failureBreakdown.timeout).toBe(1);
    expect(result.failureBreakdown.invalid_output).toBe(0);
    expect(agent.generatePatch).toHaveBeenCalledTimes(3);
  });

  it("classifies invalid diff output failures", async () => {
    const agent = {
      generatePatch: vi
        .fn()
        .mockRejectedValue(new MinimaxOutputValidationError("MiniMax output is not a valid unified diff")),
      repairPatch: vi.fn()
    };

    const generator = new PatchGenerator(agent as never, logger);
    const result = await generator.generate({ ...defaultGenerateOptions, chunks: buildChunks().slice(0, 1) });

    expect(result.patches).toHaveLength(0);
    expect(result.failedChunks).toBe(1);
    expect(result.failureBreakdown.invalid_output).toBe(1);
  });

  it("classifies OpenRouter HTTP failures as api_error", async () => {
    const agent = {
      generatePatch: vi
        .fn()
        .mockRejectedValue(new OpenRouterError("OpenRouter request failed with status 500", 500, "boom")),
      repairPatch: vi.fn()
    };

    const generator = new PatchGenerator(agent as never, logger);
    const result = await generator.generate({ ...defaultGenerateOptions, chunks: buildChunks().slice(0, 1) });

    expect(result.patches).toHaveLength(0);
    expect(result.failedChunks).toBe(1);
    expect(result.failureBreakdown.api_error).toBe(1);
  });
});
