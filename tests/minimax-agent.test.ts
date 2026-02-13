import { describe, expect, it, vi } from "vitest";

import { MinimaxAgent } from "../src/ai/minimax-agent";
import { OpenRouterClient } from "../src/ai/openrouter-client";
import type { Logger } from "../src/utils/logger";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
};

const buildAgent = () => {
  const client = new OpenRouterClient({
    apiKey: "test",
    timeoutMs: 1000,
    retries: 0,
    logger,
    baseUrl: "https://example.invalid"
  });

  return {
    client,
    agent: new MinimaxAgent(client, "minimax/minimax-m2.5")
  };
};

const baseInput = {
  repository: "acme/repo",
  baseRef: "abc123",
  headRef: "def456",
  changedFiles: ["src/index.ts"],
  snapshots: [{ path: "src/index.ts", content: "const x=1;\n" }],
  diff: [
    "diff --git a/src/index.ts b/src/index.ts",
    "--- a/src/index.ts",
    "+++ b/src/index.ts",
    "@@ -1 +1 @@",
    "-const x=1;",
    "+const x = 1;"
  ].join("\n")
};

describe("MinimaxAgent", () => {
  it("returns no_changes when model responds with NO_CHANGES_NEEDED", async () => {
    const { client, agent } = buildAgent();

    vi.spyOn(client, "createChatCompletion").mockResolvedValue({
      id: "resp_1",
      model: "minimax/minimax-m2.5",
      choices: [{ message: { role: "assistant", content: "NO_CHANGES_NEEDED" } }]
    });

    const result = await agent.generatePatch(baseInput);
    expect(result).toEqual({ status: "no_changes", raw: "NO_CHANGES_NEEDED" });
  });

  it("parses valid unified diff", async () => {
    const { client, agent } = buildAgent();

    vi.spyOn(client, "createChatCompletion").mockResolvedValue({
      id: "resp_2",
      model: "minimax/minimax-m2.5",
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              "diff --git a/src/index.ts b/src/index.ts",
              "--- a/src/index.ts",
              "+++ b/src/index.ts",
              "@@ -1 +1 @@",
              "-const x=1;",
              "+const x = 1;"
            ].join("\n")
          }
        }
      ]
    });

    const result = await agent.generatePatch(baseInput);
    expect(result.status).toBe("patch");
    if (result.status === "patch") {
      expect(result.patch).toContain("@@ -1 +1 @@");
    }
  });

  it("rejects /dev/null patch headers", async () => {
    const { client, agent } = buildAgent();

    vi.spyOn(client, "createChatCompletion").mockResolvedValue({
      id: "resp_3",
      model: "minimax/minimax-m2.5",
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              "diff --git a/src/index.ts b/src/index.ts",
              "--- /dev/null",
              "+++ b/src/index.ts",
              "@@ -0,0 +1 @@",
              "+const x = 1;"
            ].join("\n")
          }
        }
      ]
    });

    await expect(agent.generatePatch(baseInput)).rejects.toThrow("Patch must not use /dev/null headers");
  });

  it("rejects non-diff output", async () => {
    const { client, agent } = buildAgent();

    vi.spyOn(client, "createChatCompletion").mockResolvedValue({
      id: "resp_4",
      model: "minimax/minimax-m2.5",
      choices: [{ message: { role: "assistant", content: "I suggest renaming variable x." } }]
    });

    await expect(agent.generatePatch(baseInput)).rejects.toThrow(
      "MiniMax output is invalid: expected unified diff or NO_CHANGES_NEEDED"
    );
  });

  it("uses repair flow and returns patch", async () => {
    const { client, agent } = buildAgent();

    vi.spyOn(client, "createChatCompletion").mockResolvedValue({
      id: "resp_5",
      model: "minimax/minimax-m2.5",
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              "diff --git a/src/index.ts b/src/index.ts",
              "--- a/src/index.ts",
              "+++ b/src/index.ts",
              "@@ -1 +1 @@",
              "-const x=1;",
              "+const x = 1;"
            ].join("\n")
          }
        }
      ]
    });

    const result = await agent.repairPatch({
      ...baseInput,
      failedPatch: "bad patch",
      applyError: "patch does not apply"
    });

    expect(result.status).toBe("patch");
  });
});
