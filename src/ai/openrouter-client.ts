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

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly logger: Logger;
  private readonly baseUrl: string;

  public constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.retries = options.retries;
    this.logger = options.logger;
    this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  }

  public async createChatCompletion(
    payload: OpenRouterChatCompletionRequest
  ): Promise<OpenRouterChatCompletionResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

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

        clearTimeout(timeout);

        const text = await response.text();
        if (!response.ok) {
          throw new OpenRouterError(
            `OpenRouter request failed with status ${response.status}`,
            response.status,
            text
          );
        }

        const data = JSON.parse(text) as OpenRouterChatCompletionResponse;
        this.logger.info("OpenRouter completion received", {
          model: data.model,
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
          totalCost: data.usage?.total_cost ?? data.usage?.cost
        });

        return data;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;

        const isRetriable =
          error instanceof OpenRouterError
            ? error.status >= 500 || error.status === 429
            : true;

        if (!isRetriable || attempt === this.retries) {
          break;
        }

        const backoffMs = 400 * 2 ** attempt;
        this.logger.warn("OpenRouter request failed, retrying", {
          attempt,
          backoffMs,
          error: error instanceof Error ? error.message : String(error)
        });
        await sleep(backoffMs);
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error("OpenRouter request failed with unknown error");
  }
}
