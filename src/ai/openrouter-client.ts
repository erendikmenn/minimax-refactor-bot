import type { Logger } from "../utils/logger.js";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface OpenRouterChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
}

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  total_cost?: number;
}

export interface OpenRouterChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason?: string;
  }>;
  usage?: OpenRouterUsage;
}

export interface OpenRouterUsageStats {
  httpRequests: number;
  successfulResponses: number;
  retryCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
}

export class OpenRouterError extends Error {
  public readonly status: number;
  public readonly payload: string;

  public constructor(message: string, status: number, payload: string) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.payload = payload;
  }
}

export interface OpenRouterClientOptions {
  apiKey: string;
  timeoutMs: number;
  retries: number;
  logger: Logger;
  baseUrl?: string;
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const toFiniteNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return 0;
};

const createInitialStats = (): Omit<OpenRouterUsageStats, "averageLatencyMs"> => ({
  httpRequests: 0,
  successfulResponses: 0,
  retryCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  totalLatencyMs: 0,
  maxLatencyMs: 0
});

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly logger: Logger;
  private readonly baseUrl: string;
  private stats: Omit<OpenRouterUsageStats, "averageLatencyMs">;

  public constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.retries = options.retries;
    this.logger = options.logger;
    this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
    this.stats = createInitialStats();
  }

  public resetUsageStats(): void {
    this.stats = createInitialStats();
  }

  public getUsageStats(): OpenRouterUsageStats {
    const averageLatencyMs =
      this.stats.successfulResponses > 0
        ? Math.round(this.stats.totalLatencyMs / this.stats.successfulResponses)
        : 0;

    return {
      ...this.stats,
      averageLatencyMs
    };
  }

  public async createChatCompletion(
    payload: OpenRouterChatCompletionRequest
  ): Promise<OpenRouterChatCompletionResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const startedAt = Date.now();
      this.stats.httpRequests += 1;

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        const text = await response.text();
        if (!response.ok) {
          throw new OpenRouterError(
            `OpenRouter request failed with status ${response.status}`,
            response.status,
            text
          );
        }

        const data = JSON.parse(text) as OpenRouterChatCompletionResponse;
        const latencyMs = Date.now() - startedAt;
        const promptTokens = toFiniteNumber(data.usage?.prompt_tokens);
        const completionTokens = toFiniteNumber(data.usage?.completion_tokens);
        const totalTokens = toFiniteNumber(data.usage?.total_tokens);
        const totalCostUsd = toFiniteNumber(data.usage?.total_cost ?? data.usage?.cost);

        this.stats.successfulResponses += 1;
        this.stats.promptTokens += promptTokens;
        this.stats.completionTokens += completionTokens;
        this.stats.totalTokens += totalTokens;
        this.stats.totalCostUsd += totalCostUsd;
        this.stats.totalLatencyMs += latencyMs;
        this.stats.maxLatencyMs = Math.max(this.stats.maxLatencyMs, latencyMs);

        this.logger.info("OpenRouter completion received", {
          model: data.model,
          promptTokens,
          completionTokens,
          totalTokens,
          totalCostUsd,
          latencyMs
        });

        return data;
      } catch (error) {
        lastError = error;

        const isRetriable =
          error instanceof OpenRouterError
            ? error.status >= 500 || error.status === 429
            : true;

        if (!isRetriable || attempt === this.retries) {
          break;
        }

        const backoffMs = 400 * 2 ** attempt;
        this.stats.retryCount += 1;
        this.logger.warn("OpenRouter request failed, retrying", {
          attempt: attempt + 1,
          maxAttempts: this.retries + 1,
          backoffMs,
          latencyMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        });
        clearTimeout(timeout);
        await sleep(backoffMs);
      } finally {
        clearTimeout(timeout);
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error("OpenRouter request failed with unknown error");
  }
}
