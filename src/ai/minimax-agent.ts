import { OpenRouterClient } from "./openrouter-client.js";

export interface MinimaxInput {
  repository: string;
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  diff: string;
}

export type MinimaxResult =
  | {
      status: "no_changes";
      raw: string;
    }
  | {
      status: "patch";
      patch: string;
      raw: string;
    };

const NO_CHANGES_SIGNAL = "NO_CHANGES_NEEDED";

const systemPrompt = [
  "You are a senior staff engineer.",
  "Refactor and optimize the provided diff.",
  "",
  "Rules:",
  "- no behavior change",
  "- improve clarity",
  "- reduce duplication",
  "- improve performance if obvious",
  "- keep public APIs",
  "- NEVER modify database schema",
  "- return ONLY unified diff or NO_CHANGES_NEEDED"
].join("\n");

const buildUserPrompt = (input: MinimaxInput): string => {
  const changedFiles = input.changedFiles.length > 0 ? input.changedFiles.join("\n") : "(none)";

  return [
    `Repository: ${input.repository}`,
    `Base: ${input.baseRef}`,
    `Head: ${input.headRef}`,
    "",
    "Changed files:",
    changedFiles,
    "",
    "Unified diff:",
    input.diff,
    "",
    `If no meaningful refactor exists, output exactly: ${NO_CHANGES_SIGNAL}`
  ].join("\n");
};

const extractDiffFromResponse = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed === NO_CHANGES_SIGNAL) {
    return null;
  }

  const diffCodeFence = trimmed.match(/```diff\n([\s\S]*?)```/i);
  if (diffCodeFence?.[1]) {
    return diffCodeFence[1].trim();
  }

  const plainCodeFence = trimmed.match(/```\n([\s\S]*?)```/i);
  if (plainCodeFence?.[1] && /(^diff --git|^---\s)/m.test(plainCodeFence[1])) {
    return plainCodeFence[1].trim();
  }

  if (/(^diff --git|^---\s)/m.test(trimmed)) {
    return trimmed;
  }

  return null;
};

const isUnifiedDiff = (text: string): boolean => {
  const hasHeader = /(^diff --git|^---\s.+\n\+\+\+\s.+)/m.test(text);
  const hasHunk = /^@@\s.+\s@@/m.test(text);
  return hasHeader && hasHunk;
};

export class MinimaxAgent {
  private readonly client: OpenRouterClient;
  private readonly modelName: string;

  public constructor(client: OpenRouterClient, modelName: string) {
    this.client = client;
    this.modelName = modelName;
  }

  public async generatePatch(input: MinimaxInput): Promise<MinimaxResult> {
    const response = await this.client.createChatCompletion({
      model: this.modelName,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: buildUserPrompt(input)
        }
      ]
    });

    const rawOutput = response.choices[0]?.message.content?.trim();
    if (!rawOutput) {
      throw new Error("MiniMax response did not include content");
    }

    const diff = extractDiffFromResponse(rawOutput);
    if (!diff) {
      if (rawOutput.includes(NO_CHANGES_SIGNAL)) {
        return { status: "no_changes", raw: rawOutput };
      }

      throw new Error("MiniMax output is invalid: expected unified diff or NO_CHANGES_NEEDED");
    }

    if (!isUnifiedDiff(diff)) {
      throw new Error("MiniMax output is not a valid unified diff");
    }

    return {
      status: "patch",
      patch: diff,
      raw: rawOutput
    };
  }
}
