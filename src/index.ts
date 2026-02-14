#!/usr/bin/env node
import { loadConfig } from "./core/config.js";
import { PatchGenerator } from "./core/patch-generator.js";
import { RefactorPipeline, type PipelineResult } from "./core/pipeline.js";
import { PollingPushWatcher } from "./core/watch.js";
import { MinimaxAgent } from "./ai/minimax-agent.js";
import { OpenRouterClient, type OpenRouterUsageStats } from "./ai/openrouter-client.js";
import { GitApplyEngine } from "./git/apply.js";
import { GitBranchManager } from "./git/branch.js";
import { GitDiffExtractor } from "./git/diff.js";
import { GitRepositoryScanner } from "./git/repo-scanner.js";
import { GitHubPullRequestCreator } from "./github/create-pr.js";
import { NodeCommandExecutor } from "./utils/exec.js";
import { consoleLogger } from "./utils/logger.js";

const usage = (): void => {
  // eslint-disable-next-line no-console
  console.log("Usage: minimax-refactor-bot <run|watch>");
};

const formatDuration = (durationMs: number): string => `${(durationMs / 1000).toFixed(1)}s`;

const formatUsd = (amount: number): string => `$${amount.toFixed(6)}`;

const describeValue = (result: PipelineResult): string => {
  if (result.status === "created") {
    return "Automated safe cleanup completed and a PR was opened.";
  }

  switch (result.reason) {
    case "no_diff":
      return "No new commit diff detected, so no API cost beyond setup.";
    case "no_patch":
      return "No safe/meaningful refactor found; unnecessary PR noise was avoided.";
    case "test_failure":
      return "Patch failed tests, so behavior-risk changes were blocked.";
    case "model_failure":
      return "Invalid model output was rejected to protect repository integrity.";
    case "patch_apply_failure":
      return "Unappliable patch was blocked before any branch/PR mutation.";
    default:
      return "Run completed.";
  }
};

const printRunSummary = (params: {
  mode: "run" | "watch";
  repository: string;
  baseBranch: string;
  result: PipelineResult;
  usage: OpenRouterUsageStats;
  durationMs: number;
  range?: {
    before: string;
    after: string;
  };
}): void => {
  const { mode, repository, baseBranch, result, usage, durationMs, range } = params;

  const outcome =
    result.status === "created"
      ? `created (${result.files.length} files)`
      : `skipped (${result.reason})`;

  const lines: string[] = [
    "",
    "=== MiniMax Run Summary ===",
    `mode: ${mode}`,
    `repository: ${repository}`,
    `base_branch: ${baseBranch}`,
    `duration: ${formatDuration(durationMs)}`,
    `outcome: ${outcome}`
  ];

  if (range) {
    lines.push(`range: ${range.before} -> ${range.after}`);
  }

  if (result.status === "created") {
    lines.push(`pr_url: ${result.pullRequestUrl}`);
    lines.push(`branch: ${result.branchName}`);
    lines.push(`change_summary: ${result.changeSummary}`);
    lines.push(`files: ${result.files.join(", ")}`);
  }

  lines.push(
    "",
    "OpenRouter usage:",
    `- http_requests: ${usage.httpRequests}`,
    `- retries: ${usage.retryCount}`,
    `- successful_responses: ${usage.successfulResponses}`,
    `- prompt_tokens: ${usage.promptTokens}`,
    `- completion_tokens: ${usage.completionTokens}`,
    `- total_tokens: ${usage.totalTokens}`,
    `- total_cost_usd: ${formatUsd(usage.totalCostUsd)}`,
    `- avg_latency_ms: ${usage.averageLatencyMs}`,
    `- max_latency_ms: ${usage.maxLatencyMs}`,
    "",
    "Value:",
    `- ${describeValue(result)}`,
    "===========================",
    ""
  );

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
};

const main = async (): Promise<void> => {
  const [command] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(0);
  }

  if (command !== "run" && command !== "watch") {
    usage();
    process.exit(1);
  }

  const logger = consoleLogger;
  const config = loadConfig(process.env, logger);
  const executor = new NodeCommandExecutor();

  const openRouterClient = new OpenRouterClient({
    apiKey: config.openRouterApiKey,
    timeoutMs: config.timeoutMs,
    retries: config.maxRetries,
    logger
  });

  const minimaxAgent = new MinimaxAgent(openRouterClient, config.modelName);
  const pipeline = new RefactorPipeline({
    config,
    logger,
    diffExtractor: new GitDiffExtractor(executor, config.maxDiffSize, config.maxFilesPerChunk),
    patchGenerator: new PatchGenerator(minimaxAgent, logger),
    applyEngine: new GitApplyEngine(executor),
    branchManager: new GitBranchManager(executor),
    repoScanner: new GitRepositoryScanner(executor),
    prCreator: new GitHubPullRequestCreator(config.githubToken),
    executor
  });

  if (command === "run") {
    const startedAt = Date.now();
    openRouterClient.resetUsageStats();
    const result = await pipeline.run();
    logger.info("Pipeline finished", result);
    printRunSummary({
      mode: "run",
      repository: config.repository,
      baseBranch: config.baseBranch,
      result,
      usage: openRouterClient.getUsageStats(),
      durationMs: Date.now() - startedAt
    });
    return;
  }

  const watcher = new PollingPushWatcher({
    config,
    executor,
    logger
  });

  logger.info("Starting watch mode");
  await watcher.watch(async ({ eventPath, baseSha, headSha }) => {
    const previousEventPath = config.eventPath;
    config.eventPath = eventPath;
    const startedAt = Date.now();
    openRouterClient.resetUsageStats();

    try {
      const result = await pipeline.run();
      logger.info("Watch pipeline finished", {
        before: baseSha,
        after: headSha,
        result
      });
      printRunSummary({
        mode: "watch",
        repository: config.repository,
        baseBranch: config.baseBranch,
        result,
        usage: openRouterClient.getUsageStats(),
        durationMs: Date.now() - startedAt,
        range: {
          before: baseSha,
          after: headSha
        }
      });
    } finally {
      config.eventPath = previousEventPath;
    }
  });
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
