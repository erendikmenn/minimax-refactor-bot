import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CommandExecutionError, type CommandExecutor } from "../utils/exec.js";

const summarizeRepeatedLines = (lines: string[], maxOutputLines: number): string[] => {
  const summarized: string[] = [];
  let index = 0;

  while (index < lines.length && summarized.length < maxOutputLines) {
    const line = lines[index];
    if (typeof line !== "string") {
      break;
    }

    let repeatCount = 1;

    while (index + repeatCount < lines.length && lines[index + repeatCount] === line) {
      repeatCount += 1;
    }

    if (repeatCount > 1) {
      summarized.push(`${line} (repeated ${repeatCount}x)`);
    } else {
      summarized.push(line);
    }

    index += repeatCount;
  }

  if (index < lines.length) {
    summarized.push(`... (${lines.length - index} more lines omitted)`);
  }

  return summarized;
};

const summarizeGitApplyError = (raw: string): string => {
  const lines = raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "unknown git apply error";
  }

  if (lines.length <= 20) {
    return lines.join("\n");
  }

  return summarizeRepeatedLines(lines, 20).join("\n");
};

export class GitApplyEngine {
  private readonly executor: CommandExecutor;

  public constructor(executor: CommandExecutor) {
    this.executor = executor;
  }

  public async applyUnifiedDiff(patch: string): Promise<void> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "minimax-refactor-"));
    const patchPath = path.join(tempDir, "patch.diff");

    try {
      await writeFile(patchPath, `${patch.trimEnd()}\n`, "utf8");
      await this.executor.run("git", ["apply", "--check", "--index", "--recount", patchPath]);
      await this.executor.run("git", ["apply", "--index", "--recount", patchPath]);
    } catch (error) {
      if (error instanceof CommandExecutionError) {
        const summarizedError = summarizeGitApplyError(error.stderr || error.stdout || error.message);
        throw new Error(
          `Failed to apply patch with git apply: ${summarizedError}`
        );
      }
      throw error;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  public async hasStagedChanges(): Promise<boolean> {
    const output = await this.executor.run("git", ["diff", "--cached", "--name-only"]);
    return output.trim().length > 0;
  }

  public async listStagedFiles(): Promise<string[]> {
    const output = await this.executor.run("git", ["diff", "--cached", "--name-only"]);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
}
