import type { Logger } from "../utils/logger.js";

export interface BotConfig {
  openRouterApiKey: string;
  githubToken: string;
  modelName: string;
  maxDiffSize: number;
  maxFilesPerChunk: number;
  timeoutMs: number;
  watchPollIntervalMs: number;
  fileExcludePatterns: string[];
  repository: string;
  baseBranch: string;
  eventPath: string | undefined;
  maxRetries: number;
  patchRepairAttempts: number;
  behaviorGuardMode: "strict" | "off";
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

const defaultFileExcludePatterns = [
  "(^|/)package-lock\\.json$",
  "(^|/)npm-shrinkwrap\\.json$",
  "(^|/)pnpm-lock\\.ya?ml$",
  "(^|/)yarn\\.lock$",
  "(^|/)bun\\.lockb$",
  "(^|/)(dist|build|coverage|node_modules)/",
  "\\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|mp3|mp4|mov|woff2?|ttf|eot|otf|map)$"
];

const parseRegexList = (name: string, value: string | undefined, fallback: string[]): string[] => {
  const patterns = value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : fallback;

  if (patterns.length === 0) {
    throw new ConfigError(`${name} must contain at least one regex pattern.`);
  }

  for (const pattern of patterns) {
    try {
      // Validate regex patterns at config load time for faster feedback.
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch (error) {
      throw new ConfigError(
        `${name} contains an invalid regex pattern "${pattern}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return patterns;
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
    maxFilesPerChunk: parsePositiveInt("MAX_FILES_PER_CHUNK", env.MAX_FILES_PER_CHUNK, 1),
    timeoutMs: parsePositiveInt("TIMEOUT_MS", env.TIMEOUT_MS, 30000),
    watchPollIntervalMs: parsePositiveInt("WATCH_POLL_INTERVAL_MS", env.WATCH_POLL_INTERVAL_MS, 30000),
    fileExcludePatterns: parseRegexList(
      "FILE_EXCLUDE_PATTERNS",
      env.FILE_EXCLUDE_PATTERNS,
      defaultFileExcludePatterns
    ),
    repository: requireEnv("GITHUB_REPOSITORY", env),
    baseBranch: env.GITHUB_REF_NAME?.trim() || "main",
    eventPath: env.GITHUB_EVENT_PATH,
    maxRetries: parsePositiveInt("MAX_RETRIES", env.MAX_RETRIES, 1),
    patchRepairAttempts: parsePositiveInt("PATCH_REPAIR_ATTEMPTS", env.PATCH_REPAIR_ATTEMPTS, 2),
    behaviorGuardMode: env.BEHAVIOR_GUARD_MODE === "off" ? "off" : "strict",
    testCommand: env.TEST_COMMAND?.trim() || "npm test"
  };

  logger?.debug("Configuration loaded", {
    modelName: config.modelName,
    maxDiffSize: config.maxDiffSize,
    maxFilesPerChunk: config.maxFilesPerChunk,
    timeoutMs: config.timeoutMs,
    watchPollIntervalMs: config.watchPollIntervalMs,
    fileExcludePatterns: config.fileExcludePatterns.length,
    maxRetries: config.maxRetries,
    patchRepairAttempts: config.patchRepairAttempts,
    behaviorGuardMode: config.behaviorGuardMode,
    repository: config.repository,
    baseBranch: config.baseBranch
  });

  return config;
};
