import { OpenRouterClient, type ChatMessage } from "./openrouter-client.js";

export interface MinimaxInput {
  repository: string;
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  diff: string;
}

export interface MinimaxRepairInput extends MinimaxInput {
  failedPatch: string;
  applyError: string;
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

const commonRules = [
  "- no behavior change",
  "- improve clarity",
  "- reduce duplication",
  "- improve performance if obvious",
  "- keep public APIs",
  "- NEVER modify database schema",
  "- output MUST be directly consumable by `git apply --index --3way --recount`",
  "- each changed file must include: diff --git, --- a/..., +++ b/..., and @@ hunks",
  "- inside hunks, every non-empty line must start with exactly one prefix: space, +, or -",
  "- do not use markdown fences",
  "- return ONLY unified diff or NO_CHANGES_NEEDED"
].join("\n");

const generationSystemPrompt = [
  "You are a senior staff engineer.",
  "Refactor and optimize the provided diff.",
  "",
  "Rules:",
  commonRules
].join("\n");

const repairSystemPrompt = [
  "You are a senior staff engineer fixing an invalid patch.",
  "Generate a corrected unified diff that applies cleanly.",
  "",
  "Rules:",
  commonRules
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

const buildRepairPrompt = (input: MinimaxRepairInput): string => {
  const changedFiles = input.changedFiles.length > 0 ? input.changedFiles.join("\n") : "(none)";

  return [
    `Repository: ${input.repository}`,
    `Base: ${input.baseRef}`,
    `Head: ${input.headRef}`,
    "",
    "Changed files:",
    changedFiles,
    "",
    "Original source diff:",
    input.diff,
    "",
    "Previously generated patch (failed to apply):",
    input.failedPatch,
    "",
    "git apply error:",
    input.applyError,
    "",
    "Return a corrected patch only. If no safe fix is possible, output NO_CHANGES_NEEDED."
  ].join("\n");
};

const normalizeText = (value: string): string => value.replace(/\r\n?/g, "\n").trim();

const containsNoChangesSignal = (value: string): boolean => {
  return value
    .split("\n")
    .map((line) => line.trim())
    .includes(NO_CHANGES_SIGNAL);
};

const extractDiffFromResponse = (raw: string): string | null => {
  const normalized = normalizeText(raw);
  if (!normalized) {
    return null;
  }

  if (normalized === NO_CHANGES_SIGNAL || containsNoChangesSignal(normalized)) {
    return null;
  }

  const fencedDiff = normalized.match(/```diff\n([\s\S]*?)```/i);
  if (fencedDiff?.[1]) {
    return normalizeText(fencedDiff[1]);
  }

  const fenced = normalized.match(/```\n([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return normalizeText(fenced[1]);
  }

  const lines = normalized.split("\n");
  const patchStart = lines.findIndex((line) => line.startsWith("diff --git ") || line.startsWith("--- "));
  if (patchStart < 0) {
    return null;
  }

  const patchLines = lines.slice(patchStart);
  const fenceIndex = patchLines.findIndex((line) => line.trim() === "```");
  const clipped = fenceIndex >= 0 ? patchLines.slice(0, fenceIndex) : patchLines;

  return normalizeText(clipped.join("\n"));
};

const isMetadataLine = (line: string): boolean => {
  return (
    /^index [0-9a-f]+\.[0-9a-f]+(?: [0-7]{6})?$/.test(line) ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ") ||
    line.startsWith("Binary files ")
  );
};

const sanitizeExtractedDiff = (value: string): string => {
  const lines = normalizeText(value).split("\n");
  const output: string[] = [];
  let inHunk = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trimStart();

    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(trimmed)) {
      inHunk = true;
      output.push(trimmed);
      continue;
    }

    if (trimmed.startsWith("diff --git ") || trimmed.startsWith("--- ") || trimmed.startsWith("+++ ") || isMetadataLine(trimmed)) {
      inHunk = false;
      output.push(trimmed);
      continue;
    }

    if (inHunk) {
      if (trimmed === "\\ No newline at end of file") {
        output.push("\\ No newline at end of file");
        continue;
      }

      const directPrefix = rawLine[0];
      if (directPrefix === " " || directPrefix === "+" || directPrefix === "-") {
        output.push(rawLine);
        continue;
      }

      const normalizedPrefix = trimmed[0];
      if (normalizedPrefix === " " || normalizedPrefix === "+" || normalizedPrefix === "-") {
        output.push(trimmed);
        continue;
      }
    }

    if (trimmed.length > 0) {
      output.push(trimmed);
    }
  }

  return normalizeText(output.join("\n"));
};

const validateUnifiedDiff = (value: string): { valid: boolean; reason?: string } => {
  const lines = normalizeText(value).split("\n");

  let inHunk = false;
  let hasHeader = false;
  let hunks = 0;

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }

    const trimmed = line.trimStart();

    if (trimmed.startsWith("diff --git ")) {
      inHunk = false;
      hasHeader = true;
      continue;
    }

    if (trimmed.startsWith("--- ") || trimmed.startsWith("+++ ")) {
      inHunk = false;
      hasHeader = true;
      continue;
    }

    if (isMetadataLine(trimmed)) {
      continue;
    }

    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(trimmed)) {
      inHunk = true;
      hunks += 1;
      continue;
    }

    if (inHunk) {
      if (trimmed === "\\ No newline at end of file") {
        continue;
      }

      const prefix = line[0];
      if (prefix === " " || prefix === "+" || prefix === "-") {
        continue;
      }

      return {
        valid: false,
        reason: `Invalid hunk line at ${index + 1}: ${trimmed.slice(0, 120)}`
      };
    }
  }

  if (!hasHeader) {
    return { valid: false, reason: "Patch is missing file headers" };
  }

  if (hunks === 0) {
    return { valid: false, reason: "Patch is missing @@ hunk sections" };
  }

  return { valid: true };
};

export class MinimaxAgent {
  private readonly client: OpenRouterClient;
  private readonly modelName: string;

  public constructor(client: OpenRouterClient, modelName: string) {
    this.client = client;
    this.modelName = modelName;
  }

  public async generatePatch(input: MinimaxInput): Promise<MinimaxResult> {
    return this.requestPatch([
      {
        role: "system",
        content: generationSystemPrompt
      },
      {
        role: "user",
        content: buildUserPrompt(input)
      }
    ]);
  }

  public async repairPatch(input: MinimaxRepairInput): Promise<MinimaxResult> {
    return this.requestPatch([
      {
        role: "system",
        content: repairSystemPrompt
      },
      {
        role: "user",
        content: buildRepairPrompt(input)
      }
    ]);
  }

  private async requestPatch(messages: ChatMessage[]): Promise<MinimaxResult> {
    const response = await this.client.createChatCompletion({
      model: this.modelName,
      temperature: 0,
      messages
    });

    const rawOutput = response.choices[0]?.message.content?.trim();
    if (!rawOutput) {
      throw new Error("MiniMax response did not include content");
    }

    if (containsNoChangesSignal(rawOutput)) {
      return { status: "no_changes", raw: rawOutput };
    }

    const extracted = extractDiffFromResponse(rawOutput);
    const diff = extracted ? sanitizeExtractedDiff(extracted) : null;
    if (!diff) {
      throw new Error("MiniMax output is invalid: expected unified diff or NO_CHANGES_NEEDED");
    }

    const validation = validateUnifiedDiff(diff);
    if (!validation.valid) {
      throw new Error(`MiniMax output is not a valid unified diff: ${validation.reason ?? "unknown reason"}`);
    }

    return {
      status: "patch",
      patch: diff,
      raw: rawOutput
    };
  }
}
