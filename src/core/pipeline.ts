import type { BotConfig } from "./config.js";
import type { CommandExecutor } from "../utils/exec.js";
import type { Logger } from "../utils/logger.js";
import type { DiffChunk } from "../git/diff.js";
import { assessPatchBehaviorRisk } from "./behavior-guard.js";

export interface DiffExtractor {
  resolveRangeFromEvent(eventPath?: string): Promise<{ baseSha: string; headSha: string }>;
  extract(
    baseSha: string,
    headSha: string
  ): Promise<{
    baseSha: string;
    headSha: string;
    changedFiles: string[];
    excludedFiles: string[];
    fullDiff: string;
    chunks: DiffChunk[];
  } | null>;
}

export interface PatchGeneratorPort {
  generate(input: {
    repository: string;
    baseRef: string;
    headRef: string;
    chunks: DiffChunk[];
  }): Promise<{
    patches: Array<{
      patch: string;
      chunk: DiffChunk;
    }>;
    skippedChunks: number;
    failedChunks: number;
    failureBreakdown: {
      timeout: number;
      invalid_output: number;
      api_error: number;
      unknown: number;
    };
  }>;
  repairPatch(input: {
    repository: string;
    baseRef: string;
    headRef: string;
    chunk: DiffChunk;
    failedPatch: string;
    applyError: string;
  }): Promise<string | null>;
}

export interface ApplyEngine {
  applyUnifiedDiff(patch: string): Promise<void>;
  hasStagedChanges(): Promise<boolean>;
  listStagedFiles(): Promise<string[]>;
}

export interface BranchManager {
  configureIdentity(identity: { name: string; email: string }): Promise<void>;
  createBranch(branchName: string): Promise<void>;
  commitAll(message: string): Promise<void>;
  pushBranch(branchName: string): Promise<void>;
}

export interface RepoScanner {
  scanSummary(): Promise<{
    trackedFileCount: number;
    topLevelDirectories: string[];
  }>;
}

export interface PullRequestCreator {
  create(request: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ url: string; number: number }>;
}

export interface UsageStatsSnapshot {
  httpRequests: number;
  successfulResponses: number;
  retryCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
}

export interface PipelineDependencies {
  config: BotConfig;
  logger: Logger;
  diffExtractor: DiffExtractor;
  patchGenerator: PatchGeneratorPort;
  applyEngine: ApplyEngine;
  branchManager: BranchManager;
  repoScanner: RepoScanner;
  prCreator: PullRequestCreator;
  executor: CommandExecutor;
  usageStatsProvider?: () => UsageStatsSnapshot;
}

export type PipelineResult =
  | {
      status: "skipped";
      reason: "no_diff" | "no_patch" | "test_failure" | "patch_apply_failure";
    }
  | {
      status: "skipped";
      reason: "model_failure";
      modelFailureSubtype: "timeout" | "invalid_output" | "api_error" | "unknown" | "mixed";
      failedChunks: number;
      totalChunks: number;
    }
  | {
      status: "created";
      branchName: string;
      pullRequestUrl: string;
      files: string[];
      changeSummary: string;
    };

const parseRepository = (repository: string): { owner: string; repo: string } => {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
  }

  return { owner, repo };
};

const timestampForBranch = (): string => {
  const iso = new Date().toISOString();
  return iso.replace(/[-:T]/g, "").slice(0, 14);
};

const normalizePatchedPath = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") {
    return trimmed;
  }

  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }

  return trimmed;
};

const extractPatchedFiles = (patch: string): string[] => {
  const files = new Set<string>();
  const lines = patch.split("\n");

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(" ");
      const right = parts[3];
      if (right) {
        const normalized = normalizePatchedPath(right);
        if (normalized !== "/dev/null") {
          files.add(normalized);
        }
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const file = line.slice(4);
      const normalized = normalizePatchedPath(file);
      if (normalized !== "/dev/null") {
        files.add(normalized);
      }
    }
  }

  return [...files];
};

const SOURCE_FILE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".php",
  ".rb",
  ".cs",
  ".cpp",
  ".c",
  ".h"
];

interface StagedFileStat {
  path: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

interface ChunkSelectionStats {
  totalChunks: number;
  analyzedChunks: number;
}

interface PatchLifecycleStats {
  generatedPatchCount: number;
  appliedPatchCount: number;
  behaviorGuardBlocked: number;
  scopeGuardBlocked: number;
  repairAttempts: number;
  repairNoPatch: number;
  failedChunks: number;
  skippedChunks: number;
}

interface PrBodyContext {
  files: string[];
  fileStats: StagedFileStat[];
  changeSummary: string;
  testCommand: string;
  baseSha: string;
  headSha: string;
  chunkSelection: ChunkSelectionStats;
  patchStats: PatchLifecycleStats;
  usageStats?: UsageStatsSnapshot;
}

const formatUsd = (value: number): string => `$${value.toFixed(6)}`;

const getExtension = (filePath: string): string => {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex < 0) {
    return "";
  }

  return filePath.slice(dotIndex).toLowerCase();
};

const isTestFilePath = (filePath: string): boolean => {
  const normalized = filePath.toLowerCase();
  return (
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith(".spec.js")
  );
};

const isDocFilePath = (filePath: string): boolean => {
  const normalized = filePath.toLowerCase();
  return normalized.endsWith(".md") || normalized.endsWith(".mdx") || normalized.endsWith(".txt") || normalized.endsWith(".rst");
};

const isConfigFilePath = (filePath: string): boolean => {
  const normalized = filePath.toLowerCase();
  return (
    normalized.endsWith(".json") ||
    normalized.endsWith(".yml") ||
    normalized.endsWith(".yaml") ||
    normalized.endsWith(".toml")
  );
};

const isSourceFilePath = (filePath: string): boolean => SOURCE_FILE_EXTENSIONS.includes(getExtension(filePath));

const looksGeneratedOrLowSignal = (filePath: string): boolean => {
  const normalized = filePath.toLowerCase();
  return (
    /(^|\/)(dist|build|coverage|node_modules|vendor|generated)\//.test(normalized) ||
    /(^|\/)rule-\d+\.[a-z0-9]+$/.test(normalized) ||
    normalized.endsWith(".min.js") ||
    normalized.endsWith(".map")
  );
};

const scoreFileForSelection = (filePath: string, behaviorGuardMode: "strict" | "off"): number => {
  if (isTestFilePath(filePath)) {
    return 100;
  }

  if (isDocFilePath(filePath) || isConfigFilePath(filePath)) {
    return 80;
  }

  if (looksGeneratedOrLowSignal(filePath)) {
    return 10;
  }

  if (behaviorGuardMode === "strict" && isSourceFilePath(filePath)) {
    return 40;
  }

  if (isSourceFilePath(filePath)) {
    return 70;
  }

  return 50;
};

const scoreChunkForSelection = (chunk: DiffChunk, behaviorGuardMode: "strict" | "off"): number => {
  if (chunk.files.length === 0) {
    return 0;
  }

  return chunk.files.reduce((max, file) => {
    const score = scoreFileForSelection(file, behaviorGuardMode);
    return Math.max(max, score);
  }, 0);
};

const prioritizeChunks = (chunks: DiffChunk[], behaviorGuardMode: "strict" | "off"): DiffChunk[] => {
  return [...chunks].sort((left, right) => {
    const scoreDiff = scoreChunkForSelection(right, behaviorGuardMode) - scoreChunkForSelection(left, behaviorGuardMode);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    // Prefer smaller chunks when scores tie to reduce per-request latency.
    return left.diff.length - right.diff.length;
  });
};

const parseNumStat = (raw: string): StagedFileStat[] => {
  if (!raw.trim()) {
    return [];
  }

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [additionsRaw, deletionsRaw, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t").trim();
      const isBinary = additionsRaw === "-" || deletionsRaw === "-";
      const additions = isBinary ? 0 : Number.parseInt(additionsRaw ?? "0", 10);
      const deletions = isBinary ? 0 : Number.parseInt(deletionsRaw ?? "0", 10);

      return {
        path,
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
        isBinary
      };
    });
};

const inferImpactNotes = (files: string[]): string[] => {
  if (files.length === 0) {
    return ["No changed files were staged."];
  }

  const hasSource = files.some((file) => isSourceFilePath(file) && !isTestFilePath(file));
  const hasTests = files.some((file) => isTestFilePath(file));
  const hasDocsOrConfig = files.some((file) => isDocFilePath(file) || isConfigFilePath(file));

  if (!hasSource && hasTests) {
    return [
      "Runtime behavior risk is low because only tests/docs/config were changed.",
      "Primary value is readability and maintainability of supporting files."
    ];
  }

  if (hasSource) {
    return [
      "Source files changed with refactor-only intent; behavior guard and tests are used as safety rails.",
      "Expected impact: improved readability/structure, with potential minor performance/maintenance gains."
    ];
  }

  if (hasDocsOrConfig) {
    return ["Changes are scoped to docs/configuration; runtime behavior is expected to remain unchanged."];
  }

  return ["Changes are expected to be behavior-preserving based on patch guardrails and test verification."];
};

const buildPrBody = (context: PrBodyContext): string => {
  const {
    files,
    fileStats,
    changeSummary,
    testCommand,
    baseSha,
    headSha,
    chunkSelection,
    patchStats,
    usageStats
  } = context;

  const statByFile = new Map(fileStats.map((item) => [item.path, item]));
  const fileLines =
    files.length > 0
      ? files.map((file) => {
          const stat = statByFile.get(file);
          if (!stat) {
            return `- ${file}`;
          }
          if (stat.isBinary) {
            return `- ${file} (binary diff)`;
          }
          return `- ${file} (+${stat.additions} / -${stat.deletions})`;
        })
      : ["- (none)"];

  const impactLines = inferImpactNotes(files).map((line) => `- ${line}`);
  const chunkCoverageLine =
    chunkSelection.analyzedChunks < chunkSelection.totalChunks
      ? `- Model analyzed ${chunkSelection.analyzedChunks}/${chunkSelection.totalChunks} prioritized chunks (tune with \`MAX_CHUNKS_PER_RUN\`).`
      : `- Model analyzed all ${chunkSelection.totalChunks} diff chunks.`;

  const usageLines = usageStats
    ? [
        `- HTTP requests: ${usageStats.httpRequests} (${usageStats.retryCount} retries)`,
        `- Tokens: ${usageStats.totalTokens} (prompt ${usageStats.promptTokens}, completion ${usageStats.completionTokens})`,
        `- Cost: ${formatUsd(usageStats.totalCostUsd)}`,
        `- Latency: avg ${usageStats.averageLatencyMs}ms, max ${usageStats.maxLatencyMs}ms`
      ]
    : ["- Usage stats unavailable in this run context."];

  return [
    "## Summary",
    "",
    "Automated refactor and optimization suggestions generated by MiniMax.",
    "",
    "## Why These Changes",
    chunkCoverageLine,
    `- MiniMax generated ${patchStats.generatedPatchCount} candidate patches; ${patchStats.appliedPatchCount} passed all safeguards and were applied.`,
    `- Chunk outcomes: ${patchStats.skippedChunks} no-change, ${patchStats.failedChunks} model failures.`,
    "",
    "## What Changed",
    ...fileLines,
    `- Change footprint: ${changeSummary}`,
    "",
    "## Potential Impact",
    ...impactLines,
    "",
    "## Safety Checks",
    `- Behavior guard blocked: ${patchStats.behaviorGuardBlocked}`,
    `- Scope guard blocked: ${patchStats.scopeGuardBlocked}`,
    `- Patch repair attempts: ${patchStats.repairAttempts} (no-patch outcomes: ${patchStats.repairNoPatch})`,
    `- Post-apply validation: \`${testCommand}\` passed before PR creation.`,
    "",
    "## Run Cost",
    ...usageLines,
    "",
    "## Source Range",
    `- Base: ${baseSha}`,
    `- Head: ${headSha}`,
    "",
    "No intended behavior changes."
  ].join("\n");
};

const deriveModelFailureSubtype = (failureBreakdown: {
  timeout: number;
  invalid_output: number;
  api_error: number;
  unknown: number;
}): "timeout" | "invalid_output" | "api_error" | "unknown" | "mixed" => {
  const entries = Object.entries(failureBreakdown).filter(([, count]) => count > 0);
  if (entries.length === 0) {
    return "unknown";
  }

  if (entries.length > 1) {
    return "mixed";
  }

  const subtype = entries[0]?.[0];
  if (
    subtype === "timeout" ||
    subtype === "invalid_output" ||
    subtype === "api_error" ||
    subtype === "unknown"
  ) {
    return subtype;
  }

  return "unknown";
};

export class RefactorPipeline {
  private readonly deps: PipelineDependencies;

  public constructor(deps: PipelineDependencies) {
    this.deps = deps;
  }

  public async run(): Promise<PipelineResult> {
    const {
      config,
      logger,
      diffExtractor,
      patchGenerator,
      applyEngine,
      branchManager,
      repoScanner,
      prCreator,
      executor
    } = this.deps;

    const range = await diffExtractor.resolveRangeFromEvent(config.eventPath);
    const diffContext = await diffExtractor.extract(range.baseSha, range.headSha);

    if (!diffContext) {
      logger.info("Skipping run because no diff was detected");
      return { status: "skipped", reason: "no_diff" };
    }

    if (diffContext.excludedFiles.length > 0) {
      logger.info("Excluded files from AI analysis", {
        excludedFileCount: diffContext.excludedFiles.length,
        excludedFiles: diffContext.excludedFiles
      });
    }

    const repoSummary = await repoScanner.scanSummary();
    logger.debug("Repository scanned", repoSummary);

    const prioritizedChunks = prioritizeChunks(diffContext.chunks, config.behaviorGuardMode);
    const selectedChunks = prioritizedChunks.slice(0, config.maxChunksPerRun);
    if (selectedChunks.length < diffContext.chunks.length) {
      logger.info("Applying chunk cap for faster model execution", {
        selectedChunks: selectedChunks.length,
        totalChunks: diffContext.chunks.length,
        maxChunksPerRun: config.maxChunksPerRun
      });
    }

    const patchResult = await patchGenerator.generate({
      repository: config.repository,
      baseRef: diffContext.baseSha,
      headRef: diffContext.headSha,
      chunks: selectedChunks
    });

    const patchStats: PatchLifecycleStats = {
      generatedPatchCount: patchResult.patches.length,
      appliedPatchCount: 0,
      behaviorGuardBlocked: 0,
      scopeGuardBlocked: 0,
      repairAttempts: 0,
      repairNoPatch: 0,
      failedChunks: patchResult.failedChunks,
      skippedChunks: patchResult.skippedChunks
    };

    if (patchResult.failedChunks > 0) {
      logger.warn("Some MiniMax chunks failed and were skipped", {
        failedChunks: patchResult.failedChunks,
        totalChunks: selectedChunks.length,
        failureBreakdown: patchResult.failureBreakdown
      });
    }

    if (patchResult.failedChunks > 0 && patchResult.patches.length === 0) {
      const modelFailureSubtype = deriveModelFailureSubtype(patchResult.failureBreakdown);
      logger.warn("No usable patches generated and model failures occurred, skipping PR creation", {
        modelFailureSubtype,
        failedChunks: patchResult.failedChunks,
        totalChunks: selectedChunks.length
      });

      return {
        status: "skipped",
        reason: "model_failure",
        modelFailureSubtype,
        failedChunks: patchResult.failedChunks,
        totalChunks: selectedChunks.length
      };
    }

    if (patchResult.patches.length === 0) {
      logger.info("MiniMax reported no patch changes for this diff", {
        skippedChunks: patchResult.skippedChunks,
        failedChunks: patchResult.failedChunks
      });
      return { status: "skipped", reason: "no_patch" };
    }

    try {
      let appliedPatchCount = 0;
      for (const generated of patchResult.patches) {
        let currentPatch = generated.patch;
        let applySucceeded = false;
        let lastError = "";

        for (let attempt = 0; attempt <= config.patchRepairAttempts; attempt += 1) {
          try {
            const touchedFiles = extractPatchedFiles(currentPatch);
            const unauthorizedFiles = touchedFiles.filter((file) => !generated.chunk.files.includes(file));

            if (unauthorizedFiles.length > 0) {
              throw new Error(
                `Patch touched files outside chunk scope: ${unauthorizedFiles.join(", ")}`
              );
            }

            if (config.behaviorGuardMode === "strict") {
              const guard = assessPatchBehaviorRisk(currentPatch);
              if (!guard.safe) {
                throw new Error(`Behavior guard blocked patch: ${guard.reasons.join("; ")}`);
              }
            }

            await applyEngine.applyUnifiedDiff(currentPatch);
            applySucceeded = true;
            appliedPatchCount += 1;
            patchStats.appliedPatchCount += 1;
            break;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);

            if (attempt === config.patchRepairAttempts) {
              break;
            }

            logger.warn("Patch apply failed, requesting repair patch", {
              attempt: attempt + 1,
              maxAttempts: config.patchRepairAttempts,
              applyError: lastError
            });
            patchStats.repairAttempts += 1;

            const repairedPatch = await patchGenerator.repairPatch({
              repository: config.repository,
              baseRef: diffContext.baseSha,
              headRef: diffContext.headSha,
              chunk: generated.chunk,
              failedPatch: currentPatch,
              applyError: lastError
            });

            if (!repairedPatch) {
              lastError = "MiniMax repair did not produce a patch";
              patchStats.repairNoPatch += 1;
              break;
            }

            currentPatch = repairedPatch;
          }
        }

        if (!applySucceeded) {
          if (
            lastError.startsWith("Behavior guard blocked patch") ||
            lastError.startsWith("Patch touched files outside chunk scope") ||
            lastError === "MiniMax repair did not produce a patch"
          ) {
            if (lastError.startsWith("Behavior guard blocked patch")) {
              patchStats.behaviorGuardBlocked += 1;
            }
            if (lastError.startsWith("Patch touched files outside chunk scope")) {
              patchStats.scopeGuardBlocked += 1;
            }
            logger.info("Skipping patch after behavior guard/retry evaluation", { reason: lastError });
            continue;
          }

          throw new Error(lastError || "Patch apply failed");
        }
      }

      if (appliedPatchCount === 0) {
        logger.info("No patches were applied after behavior guard and repair attempts");
        return { status: "skipped", reason: "no_patch" };
      }
    } catch (error) {
      logger.warn("Patch application failed, skipping PR creation", {
        error: error instanceof Error ? error.message : String(error)
      });
      return { status: "skipped", reason: "patch_apply_failure" };
    }

    const hasChanges = await applyEngine.hasStagedChanges();
    if (!hasChanges) {
      logger.info("No staged changes after applying MiniMax patches");
      return { status: "skipped", reason: "no_patch" };
    }

    try {
      const [testCommand, ...testArgs] = config.testCommand.split(" ").filter(Boolean);
      if (!testCommand) {
        throw new Error("TEST_COMMAND resolved to an empty command");
      }
      await executor.run(testCommand, testArgs, { timeoutMs: config.timeoutMs });
    } catch (error) {
      logger.warn("Tests failed after applying patch, skipping PR creation", {
        error: error instanceof Error ? error.message : String(error)
      });
      return { status: "skipped", reason: "test_failure" };
    }

    const files = await applyEngine.listStagedFiles();
    let changeSummary = "staged changes";
    let fileStats: StagedFileStat[] = [];
    try {
      const shortStat = (await executor.run("git", ["diff", "--cached", "--shortstat"])).trim();
      if (shortStat) {
        changeSummary = shortStat;
      }
    } catch (error) {
      logger.warn("Failed to compute staged change summary", {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      const numStat = await executor.run("git", ["diff", "--cached", "--numstat"]);
      fileStats = parseNumStat(numStat);
    } catch (error) {
      logger.warn("Failed to compute staged per-file stats", {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const usageStats = this.deps.usageStatsProvider?.();
    const branchName = `refactor/minimax-${timestampForBranch()}`;
    await branchManager.configureIdentity({
      name: process.env.GIT_AUTHOR_NAME ?? "minimax-refactor-bot",
      email: process.env.GIT_AUTHOR_EMAIL ?? "bot@users.noreply.github.com"
    });
    await branchManager.createBranch(branchName);
    await branchManager.commitAll("auto: minimax refactor & optimization");
    await branchManager.pushBranch(branchName);

    const parsed = parseRepository(config.repository);
    const pullRequest = await prCreator.create({
      owner: parsed.owner,
      repo: parsed.repo,
      title: "auto: minimax refactor & optimization",
      body: buildPrBody({
        files,
        fileStats,
        changeSummary,
        testCommand: config.testCommand,
        baseSha: diffContext.baseSha,
        headSha: diffContext.headSha,
        chunkSelection: {
          totalChunks: diffContext.chunks.length,
          analyzedChunks: selectedChunks.length
        },
        patchStats,
        ...(usageStats ? { usageStats } : {})
      }),
      head: branchName,
      base: config.baseBranch
    });

    logger.info("Created refactor PR", { url: pullRequest.url, branchName, filesChanged: files.length });

    return {
      status: "created",
      branchName,
      pullRequestUrl: pullRequest.url,
      files,
      changeSummary
    };
  }
}
