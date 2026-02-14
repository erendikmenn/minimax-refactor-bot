import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenRouterClient } from "../src/ai/openrouter-client";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
};

describe("OpenRouterClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries on invalid JSON and succeeds on next attempt", async () => {
    const fetchMock = vi.fn();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "{"
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            id: "resp_1",
            model: "minimax/minimax-m2.5",
            choices: [{ message: { role: "assistant", content: "NO_CHANGES_NEEDED" } }],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 30,
              total_tokens: 150,
              total_cost: 0.0002
            }
          })
      });

    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient({
      apiKey: "test-key",
      timeoutMs: 1000,
      retries: 1,
      logger
    });

    const response = await client.createChatCompletion({
      model: "minimax/minimax-m2.5",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(response.id).toBe("resp_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const stats = client.getUsageStats();
    expect(stats.httpRequests).toBe(2);
    expect(stats.retryCount).toBe(1);
    expect(stats.successfulResponses).toBe(1);
    expect(stats.promptTokens).toBe(120);
    expect(stats.completionTokens).toBe(30);
    expect(stats.totalTokens).toBe(150);
    expect(stats.totalCostUsd).toBeCloseTo(0.0002, 8);
    expect(stats.averageLatencyMs).toBeGreaterThanOrEqual(0);
    expect(stats.maxLatencyMs).toBeGreaterThanOrEqual(stats.averageLatencyMs);

    client.resetUsageStats();
    expect(client.getUsageStats()).toMatchObject({
      httpRequests: 0,
      retryCount: 0,
      successfulResponses: 0,
      totalTokens: 0,
      totalCostUsd: 0
    });
  });

  it("aborts when response body hangs longer than timeout", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;

      return {
        ok: true,
        text: async () =>
          new Promise<string>((resolve, reject) => {
            const onAbort = () => {
              signal.removeEventListener("abort", onAbort);
              reject(new Error("aborted"));
            };

            signal.addEventListener("abort", onAbort);
            setTimeout(() => {
              signal.removeEventListener("abort", onAbort);
              resolve(
                JSON.stringify({
                  id: "late",
                  model: "minimax/minimax-m2.5",
                  choices: [{ message: { role: "assistant", content: "NO_CHANGES_NEEDED" } }]
                })
              );
            }, 200);
          })
      };
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient({
      apiKey: "test-key",
      timeoutMs: 30,
      retries: 0,
      logger
    });

    await expect(
      client.createChatCompletion({
        model: "minimax/minimax-m2.5",
        messages: [{ role: "user", content: "hello" }]
      })
    ).rejects.toThrow("aborted");

    const stats = client.getUsageStats();
    expect(stats.httpRequests).toBe(1);
    expect(stats.successfulResponses).toBe(0);
    expect(stats.totalCostUsd).toBe(0);
  });
});
