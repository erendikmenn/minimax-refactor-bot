import type { Logger } from "../utils/logger.js";

export interface BotConfig {
  openRouterApiKey: string;
  githubToken: string;
  modelName: string;
  maxDiffSize: number;
  timeoutMs: number;
  repository: string;
  baseBranch: string;
  eventPath: string | undefined;
  maxRetries: number;
  testCommand: string;
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const parsePositiveInt = (name: string, value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer.`);
  }

  return parsed;
};

const requireEnv = (name: keyof NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): string => {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }

  return value;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env, logger?: Logger): BotConfig => {
  const config: BotConfig = {
    openRouterApiKey: requireEnv("OPENROUTER_API_KEY", env),
    githubToken: requireEnv("GITHUB_TOKEN", env),
    modelName: env.MODEL_NAME?.trim() || "minimax/minimax-m2.5",
    maxDiffSize: parsePositiveInt("MAX_DIFF_SIZE", env.MAX_DIFF_SIZE, 80000),
    timeoutMs: parsePositiveInt("TIMEOUT_MS", env.TIMEOUT_MS, 60000),
    repository: requireEnv("GITHUB_REPOSITORY", env),
    baseBranch: env.GITHUB_REF_NAME?.trim() || "main",
    eventPath: env.GITHUB_EVENT_PATH,
    maxRetries: parsePositiveInt("MAX_RETRIES", env.MAX_RETRIES, 2),
    testCommand: env.TEST_COMMAND?.trim() || "npm test"
  };

  logger?.debug("Configuration loaded", {
    modelName: config.modelName,
    maxDiffSize: config.maxDiffSize,
    timeoutMs: config.timeoutMs,
    repository: config.repository,
    baseBranch: config.baseBranch
  });

  return config;
};
