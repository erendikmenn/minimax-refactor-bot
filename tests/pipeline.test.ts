import { describe, expect, it, vi } from "vitest";

import type { BotConfig } from "../src/core/config";
import { RefactorPipeline, type PipelineDependencies } from "../src/core/pipeline";

const baseConfig: BotConfig = {
  openRouterApiKey: "test-key",
  githubToken: "ghs_test",
  modelName: "minimax/minimax-m2.5",
  maxDiffSize: 10000,
  maxFilesPerChunk: 1,
  maxChunksPerRun: 20,
  timeoutMs: 1000,
  watchPollIntervalMs: 1000,
  fileExcludePatterns: ["(^|/)package-lock\\.json$"],
  repository: "acme/project",
  baseBranch: "main",
  eventPath: "/tmp/event.json",
  maxRetries: 1,
  patchRepairAttempts: 2,
  behaviorGuardMode: "strict",
  testCommand: "npm test"
};

const createLogger = (): PipelineDependencies["logger"] => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
});

const buildDependencies = (): PipelineDependencies => ({
  config: { ...baseConfig },
  logger: createLogger(),
  diffExtractor: {
    resolveRangeFromEvent: vi.fn().mockResolvedValue({
      baseSha: "abc123",
      headSha: "def456"
    }),
    extract: vi.fn().mockResolvedValue({
      baseSha: "abc123",
      headSha: "def456",
      changedFiles: ["src/index.ts"],
      excludedFiles: [],
      fullDiff: "diff --git a/src/index.ts b/src/index.ts",
      chunks: [
        {
          files: ["src/index.ts"],
          snapshots: [{ path: "src/index.ts", content: "const a=1;\n" }],
          diff: [
            "diff --git a/src/index.ts b/src/index.ts",
            "--- a/src/index.ts",
            "+++ b/src/index.ts",
            "@@ -1 +1 @@",
            "-const a=1;",
            "+const a = 1;"
          ].join("\n")
        }
      ]
    })
  },
  patchGenerator: {
    generate: vi.fn().mockResolvedValue({
      patches: [
        {
          patch: [
            "diff --git a/src/index.ts b/src/index.ts",
            "--- a/src/index.ts",
            "+++ b/src/index.ts",
            "@@ -1 +1 @@",
            "-const a=1;",
            "+const a = 1;"
          ].join("\n"),
          chunk: {
            files: ["src/index.ts"],
            snapshots: [{ path: "src/index.ts", content: "const a=1;\n" }],
            diff: [
              "diff --git a/src/index.ts b/src/index.ts",
              "--- a/src/index.ts",
              "+++ b/src/index.ts",
              "@@ -1 +1 @@",
              "-const a=1;",
              "+const a = 1;"
            ].join("\n")
          }
        }
      ],
      skippedChunks: 0,
      failedChunks: 0,
      failureBreakdown: {
        timeout: 0,
        invalid_output: 0,
        api_error: 0,
        unknown: 0
      }
    }),
    repairPatch: vi.fn().mockResolvedValue(null)
  },
  applyEngine: {
    applyUnifiedDiff: vi.fn().mockResolvedValue(undefined),
    hasStagedChanges: vi.fn().mockResolvedValue(true),
    listStagedFiles: vi.fn().mockResolvedValue(["src/index.ts"])
  },
  branchManager: {
    configureIdentity: vi.fn().mockResolvedValue(undefined),
    createBranch: vi.fn().mockResolvedValue(undefined),
    commitAll: vi.fn().mockResolvedValue(undefined),
    pushBranch: vi.fn().mockResolvedValue(undefined)
  },
  repoScanner: {
    scanSummary: vi.fn().mockResolvedValue({
      trackedFileCount: 10,
      topLevelDirectories: ["src", "tests"]
    })
  },
  prCreator: {
    create: vi.fn().mockResolvedValue({
      url: "https://github.com/acme/project/pull/42",
      number: 42
    })
  },
  executor: {
    run: vi.fn().mockResolvedValue("")
  },
  usageStatsProvider: () => ({
    httpRequests: 3,
    successfulResponses: 3,
    retryCount: 0,
    promptTokens: 300,
    completionTokens: 200,
    totalTokens: 500,
    totalCostUsd: 0.0012,
    averageLatencyMs: 500,
    maxLatencyMs: 700
  })
});

describe("RefactorPipeline", () => {
  it("returns skipped when no diff exists", async () => {
    const deps = buildDependencies();
    const extract = deps.diffExtractor.extract as ReturnType<typeof vi.fn>;
    extract.mockResolvedValueOnce(null);

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({ status: "skipped", reason: "no_diff" });
    expect(deps.patchGenerator.generate).not.toHaveBeenCalled();
    expect(deps.branchManager.createBranch).not.toHaveBeenCalled();
  });

  it("skips PR creation when MiniMax reports no patch", async () => {
    const deps = buildDependencies();
    const generate = deps.patchGenerator.generate as ReturnType<typeof vi.fn>;
    generate.mockResolvedValueOnce({
      patches: [],
      skippedChunks: 1,
      failedChunks: 0,
      failureBreakdown: {
        timeout: 0,
        invalid_output: 0,
        api_error: 0,
        unknown: 0
      }
    });

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({ status: "skipped", reason: "no_patch" });
    expect(deps.applyEngine.applyUnifiedDiff).not.toHaveBeenCalled();
    expect(deps.branchManager.createBranch).not.toHaveBeenCalled();
    expect(deps.prCreator.create).not.toHaveBeenCalled();
  });

  it("returns model_failure when all chunks fail at generation stage", async () => {
    const deps = buildDependencies();
    const generate = deps.patchGenerator.generate as ReturnType<typeof vi.fn>;
    generate.mockResolvedValueOnce({
      patches: [],
      skippedChunks: 0,
      failedChunks: 1,
      failureBreakdown: {
        timeout: 1,
        invalid_output: 0,
        api_error: 0,
        unknown: 0
      }
    });

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({
      status: "skipped",
      reason: "model_failure",
      modelFailureSubtype: "timeout",
      failedChunks: 1,
      totalChunks: 1
    });
    expect(deps.applyEngine.applyUnifiedDiff).not.toHaveBeenCalled();
    expect(deps.branchManager.createBranch).not.toHaveBeenCalled();
  });

  it("returns model_failure when partial chunk failures occur and no usable patches exist", async () => {
    const deps = buildDependencies();
    const extract = deps.diffExtractor.extract as ReturnType<typeof vi.fn>;
    const generate = deps.patchGenerator.generate as ReturnType<typeof vi.fn>;

    extract.mockResolvedValueOnce({
      baseSha: "abc123",
      headSha: "def456",
      changedFiles: ["src/index.ts", "src/other.ts"],
      excludedFiles: [],
      fullDiff: "diff --git a/src/index.ts b/src/index.ts",
      chunks: [
        {
          files: ["src/index.ts"],
          snapshots: [{ path: "src/index.ts", content: "const a=1;\n" }],
          diff: "diff --git a/src/index.ts b/src/index.ts"
        },
        {
          files: ["src/other.ts"],
          snapshots: [{ path: "src/other.ts", content: "const b=1;\n" }],
          diff: "diff --git a/src/other.ts b/src/other.ts"
        }
      ]
    });

    generate.mockResolvedValueOnce({
      patches: [],
      skippedChunks: 1,
      failedChunks: 1,
      failureBreakdown: {
        timeout: 1,
        invalid_output: 0,
        api_error: 0,
        unknown: 0
      }
    });

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({
      status: "skipped",
      reason: "model_failure",
      modelFailureSubtype: "timeout",
      failedChunks: 1,
      totalChunks: 2
    });
    expect(deps.branchManager.createBranch).not.toHaveBeenCalled();
    expect(deps.prCreator.create).not.toHaveBeenCalled();
  });

  it("creates branch and PR when MiniMax returns a valid patch", async () => {
    const deps = buildDependencies();
    const pipeline = new RefactorPipeline(deps);

    const result = await pipeline.run();

    expect(result.status).toBe("created");
    expect(deps.applyEngine.applyUnifiedDiff).toHaveBeenCalledTimes(1);
    expect(deps.branchManager.createBranch).toHaveBeenCalledTimes(1);
    const branchName = (deps.branchManager.createBranch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(branchName).toMatch(/^refactor\/minimax-\d{14}$/);
    expect(deps.prCreator.create).toHaveBeenCalledTimes(1);
  });

  it("prioritizes test chunks when chunk cap is reached", async () => {
    const deps = buildDependencies();
    deps.config.maxChunksPerRun = 1;
    const extract = deps.diffExtractor.extract as ReturnType<typeof vi.fn>;
    const generate = deps.patchGenerator.generate as ReturnType<typeof vi.fn>;

    extract.mockResolvedValueOnce({
      baseSha: "abc123",
      headSha: "def456",
      changedFiles: ["src/index.ts", "test/index.test.js"],
      excludedFiles: [],
      fullDiff: "diff --git a/src/index.ts b/src/index.ts",
      chunks: [
        {
          files: ["src/index.ts"],
          snapshots: [{ path: "src/index.ts", content: "const a=1;\n" }],
          diff: "diff --git a/src/index.ts b/src/index.ts"
        },
        {
          files: ["test/index.test.js"],
          snapshots: [{ path: "test/index.test.js", content: "test('x',()=>{});\n" }],
          diff: "diff --git a/test/index.test.js b/test/index.test.js"
        }
      ]
    });

    generate.mockResolvedValueOnce({
      patches: [],
      skippedChunks: 1,
      failedChunks: 0,
      failureBreakdown: {
        timeout: 0,
        invalid_output: 0,
        api_error: 0,
        unknown: 0
      }
    });

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({ status: "skipped", reason: "no_patch" });
    const generateArgs = generate.mock.calls[0]?.[0] as { chunks: Array<{ files: string[] }> };
    expect(generateArgs.chunks).toHaveLength(1);
    expect(generateArgs.chunks[0]?.files).toEqual(["test/index.test.js"]);
  });

  it("writes detailed PR body with rationale, safety checks, and run cost", async () => {
    const deps = buildDependencies();
    const runCommand = deps.executor.run as ReturnType<typeof vi.fn>;
    runCommand.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes("--shortstat")) {
        return "1 file changed, 5 insertions(+), 3 deletions(-)";
      }
      if (args.includes("--numstat")) {
        return "5\t3\tsrc/index.ts";
      }
      return "";
    });

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result.status).toBe("created");
    const prCreateCall = (deps.prCreator.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      body: string;
    };
    expect(prCreateCall.body).toContain("## Why These Changes");
    expect(prCreateCall.body).toContain("## What Changed");
    expect(prCreateCall.body).toContain("## Potential Impact");
    expect(prCreateCall.body).toContain("## Safety Checks");
    expect(prCreateCall.body).toContain("## Run Cost");
    expect(prCreateCall.body).toContain("Cost: $0.001200");
  });

  it("repairs patch and still creates branch/PR when first apply fails", async () => {
    const deps = buildDependencies();
    const applyPatch = deps.applyEngine.applyUnifiedDiff as ReturnType<typeof vi.fn>;
    const repairPatch = deps.patchGenerator.repairPatch as ReturnType<typeof vi.fn>;

    applyPatch
      .mockRejectedValueOnce(new Error("Failed to apply patch with git apply: corrupt patch"))
      .mockResolvedValueOnce(undefined);
    repairPatch.mockResolvedValueOnce(
      [
        "diff --git a/src/index.ts b/src/index.ts",
        "--- a/src/index.ts",
        "+++ b/src/index.ts",
        "@@ -1 +1 @@",
        "-const a=1;",
        "+const a = 1;"
      ].join("\n")
    );

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result.status).toBe("created");
    expect(repairPatch).toHaveBeenCalledTimes(1);
    expect(deps.branchManager.createBranch).toHaveBeenCalledTimes(1);
    expect(deps.prCreator.create).toHaveBeenCalledTimes(1);
  });

  it("skips patch when apply fails and repair returns no replacement patch", async () => {
    const deps = buildDependencies();
    const applyPatch = deps.applyEngine.applyUnifiedDiff as ReturnType<typeof vi.fn>;
    const repairPatch = deps.patchGenerator.repairPatch as ReturnType<typeof vi.fn>;

    applyPatch.mockRejectedValue(new Error("Failed to apply patch with git apply: corrupt patch"));
    repairPatch.mockResolvedValue(null);

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({ status: "skipped", reason: "no_patch" });
    expect(repairPatch).toHaveBeenCalledTimes(1);
    expect(deps.branchManager.createBranch).not.toHaveBeenCalled();
    expect(deps.prCreator.create).not.toHaveBeenCalled();
  });

  it("returns patch_apply_failure when apply keeps failing even after repair patch", async () => {
    const deps = buildDependencies();
    const applyPatch = deps.applyEngine.applyUnifiedDiff as ReturnType<typeof vi.fn>;
    const repairPatch = deps.patchGenerator.repairPatch as ReturnType<typeof vi.fn>;

    applyPatch.mockRejectedValue(new Error("Failed to apply patch with git apply: corrupt patch"));
    repairPatch.mockResolvedValue(
      [
        "diff --git a/src/index.ts b/src/index.ts",
        "--- a/src/index.ts",
        "+++ b/src/index.ts",
        "@@ -1 +1 @@",
        "-const a=1;",
        "+const a = 1;"
      ].join("\n")
    );

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({ status: "skipped", reason: "patch_apply_failure" });
    expect(repairPatch).toHaveBeenCalledTimes(2);
    expect(deps.branchManager.createBranch).not.toHaveBeenCalled();
    expect(deps.prCreator.create).not.toHaveBeenCalled();
  });

  it("skips PR creation when tests fail after patch apply", async () => {
    const deps = buildDependencies();
    const runCommand = deps.executor.run as ReturnType<typeof vi.fn>;
    runCommand.mockRejectedValueOnce(new Error("Tests failed"));

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({ status: "skipped", reason: "test_failure" });
    expect(deps.applyEngine.applyUnifiedDiff).toHaveBeenCalledTimes(1);
    expect(deps.branchManager.createBranch).not.toHaveBeenCalled();
    expect(deps.prCreator.create).not.toHaveBeenCalled();
  });

  it("skips PR creation when patch applies but no staged changes remain", async () => {
    const deps = buildDependencies();
    const hasStagedChanges = deps.applyEngine.hasStagedChanges as ReturnType<typeof vi.fn>;
    hasStagedChanges.mockResolvedValueOnce(false);

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({ status: "skipped", reason: "no_patch" });
    expect(deps.branchManager.createBranch).not.toHaveBeenCalled();
    expect(deps.prCreator.create).not.toHaveBeenCalled();
  });

  it("repairs patch when model touches files outside chunk scope", async () => {
    const deps = buildDependencies();
    const generate = deps.patchGenerator.generate as ReturnType<typeof vi.fn>;
    const repairPatch = deps.patchGenerator.repairPatch as ReturnType<typeof vi.fn>;
    const applyPatch = deps.applyEngine.applyUnifiedDiff as ReturnType<typeof vi.fn>;

    generate.mockResolvedValueOnce({
      patches: [
        {
          patch: [
            "diff --git a/src/other.ts b/src/other.ts",
            "--- a/src/other.ts",
            "+++ b/src/other.ts",
            "@@ -1 +1 @@",
            "-const b=1;",
            "+const b = 1;"
          ].join("\n"),
          chunk: {
            files: ["src/index.ts"],
            snapshots: [{ path: "src/index.ts", content: "const a=1;\n" }],
            diff: [
              "diff --git a/src/index.ts b/src/index.ts",
              "--- a/src/index.ts",
              "+++ b/src/index.ts",
              "@@ -1 +1 @@",
              "-const a=1;",
              "+const a = 1;"
            ].join("\n")
          }
        }
      ],
      skippedChunks: 0,
      failedChunks: 0,
      failureBreakdown: {
        timeout: 0,
        invalid_output: 0,
        api_error: 0,
        unknown: 0
      }
    });

    repairPatch.mockResolvedValueOnce(
      [
        "diff --git a/src/index.ts b/src/index.ts",
        "--- a/src/index.ts",
        "+++ b/src/index.ts",
        "@@ -1 +1 @@",
        "-const a=1;",
        "+const a = 1;"
      ].join("\n")
    );
    applyPatch.mockResolvedValue(undefined);

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result.status).toBe("created");
    expect(repairPatch).toHaveBeenCalledTimes(1);
    expect(applyPatch).toHaveBeenCalledTimes(1);
  });

  it("skips source patch when repaired patch keeps touching files outside chunk scope", async () => {
    const deps = buildDependencies();
    const generate = deps.patchGenerator.generate as ReturnType<typeof vi.fn>;
    const repairPatch = deps.patchGenerator.repairPatch as ReturnType<typeof vi.fn>;
    const applyPatch = deps.applyEngine.applyUnifiedDiff as ReturnType<typeof vi.fn>;

    generate.mockResolvedValueOnce({
      patches: [
        {
          patch: [
            "diff --git a/src/other.ts b/src/other.ts",
            "--- a/src/other.ts",
            "+++ b/src/other.ts",
            "@@ -1 +1 @@",
            "-const b=1;",
            "+const b = 1;"
          ].join("\n"),
          chunk: {
            files: ["src/index.ts"],
            snapshots: [{ path: "src/index.ts", content: "const a=1;\n" }],
            diff: [
              "diff --git a/src/index.ts b/src/index.ts",
              "--- a/src/index.ts",
              "+++ b/src/index.ts",
              "@@ -1 +1 @@",
              "-const a=1;",
              "+const a = 1;"
            ].join("\n")
          }
        }
      ],
      skippedChunks: 0,
      failedChunks: 0,
      failureBreakdown: {
        timeout: 0,
        invalid_output: 0,
        api_error: 0,
        unknown: 0
      }
    });

    repairPatch.mockResolvedValue(
      [
        "diff --git a/src/other.ts b/src/other.ts",
        "--- a/src/other.ts",
        "+++ b/src/other.ts",
        "@@ -1 +1 @@",
        "-const b=1;",
        "+const b = 1;"
      ].join("\n")
    );

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({ status: "skipped", reason: "no_patch" });
    expect(repairPatch).toHaveBeenCalledTimes(2);
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("skips source patch when behavior guard rejects semantic token changes", async () => {
    const deps = buildDependencies();
    const generate = deps.patchGenerator.generate as ReturnType<typeof vi.fn>;
    const repairPatch = deps.patchGenerator.repairPatch as ReturnType<typeof vi.fn>;
    const applyPatch = deps.applyEngine.applyUnifiedDiff as ReturnType<typeof vi.fn>;

    generate.mockResolvedValueOnce({
      patches: [
        {
          patch: [
            "diff --git a/src/index.ts b/src/index.ts",
            "--- a/src/index.ts",
            "+++ b/src/index.ts",
            "@@ -1 +1 @@",
            "-const a=1;",
            "+const a=2;"
          ].join("\n"),
          chunk: {
            files: ["src/index.ts"],
            snapshots: [{ path: "src/index.ts", content: "const a=1;\n" }],
            diff: [
              "diff --git a/src/index.ts b/src/index.ts",
              "--- a/src/index.ts",
              "+++ b/src/index.ts",
              "@@ -1 +1 @@",
              "-const a=1;",
              "+const a = 1;"
            ].join("\n")
          }
        }
      ],
      skippedChunks: 0,
      failedChunks: 0,
      failureBreakdown: {
        timeout: 0,
        invalid_output: 0,
        api_error: 0,
        unknown: 0
      }
    });
    repairPatch.mockResolvedValue(null);

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({ status: "skipped", reason: "no_patch" });
    expect(repairPatch).toHaveBeenCalledTimes(1);
    expect(applyPatch).not.toHaveBeenCalled();
    expect(deps.branchManager.createBranch).not.toHaveBeenCalled();
  });
});
