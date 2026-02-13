import { describe, expect, it, vi } from "vitest";

import type { BotConfig } from "../src/core/config";
import { RefactorPipeline, type PipelineDependencies } from "../src/core/pipeline";

const baseConfig: BotConfig = {
  openRouterApiKey: "test-key",
  githubToken: "ghs_test",
  modelName: "minimax/minimax-m2.5",
  maxDiffSize: 10000,
  maxFilesPerChunk: 1,
  timeoutMs: 1000,
  repository: "acme/project",
  baseBranch: "main",
  eventPath: "/tmp/event.json",
  maxRetries: 1,
  patchRepairAttempts: 2,
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
      skippedChunks: 0
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
  }
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

  it("returns patch_apply_failure when apply fails and repair cannot recover", async () => {
    const deps = buildDependencies();
    const applyPatch = deps.applyEngine.applyUnifiedDiff as ReturnType<typeof vi.fn>;
    const repairPatch = deps.patchGenerator.repairPatch as ReturnType<typeof vi.fn>;

    applyPatch.mockRejectedValue(new Error("Failed to apply patch with git apply: corrupt patch"));
    repairPatch.mockResolvedValue(null);

    const pipeline = new RefactorPipeline(deps);
    const result = await pipeline.run();

    expect(result).toEqual({ status: "skipped", reason: "patch_apply_failure" });
    expect(repairPatch).toHaveBeenCalledTimes(1);
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
      skippedChunks: 0
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
});
