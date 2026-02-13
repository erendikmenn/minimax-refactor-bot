#!/usr/bin/env node
import { loadConfig } from "./core/config.js";
import { PatchGenerator } from "./core/patch-generator.js";
import { RefactorPipeline } from "./core/pipeline.js";
import { MinimaxAgent } from "./ai/minimax-agent.js";
import { OpenRouterClient } from "./ai/openrouter-client.js";
import { GitApplyEngine } from "./git/apply.js";
import { GitBranchManager } from "./git/branch.js";
import { GitDiffExtractor } from "./git/diff.js";
import { GitRepositoryScanner } from "./git/repo-scanner.js";
import { GitHubPullRequestCreator } from "./github/create-pr.js";
import { NodeCommandExecutor } from "./utils/exec.js";
import { consoleLogger } from "./utils/logger.js";

const usage = (): void => {
  // eslint-disable-next-line no-console
  console.log("Usage: minimax-refactor-bot run");
};

const main = async (): Promise<void> => {
  const [command] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(0);
  }

  if (command !== "run") {
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
    diffExtractor: new GitDiffExtractor(executor, config.maxDiffSize),
    patchGenerator: new PatchGenerator(minimaxAgent, logger),
    applyEngine: new GitApplyEngine(executor),
    branchManager: new GitBranchManager(executor),
    repoScanner: new GitRepositoryScanner(executor),
    prCreator: new GitHubPullRequestCreator(config.githubToken),
    executor
  });

  const result = await pipeline.run();
  logger.info("Pipeline finished", result);
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
