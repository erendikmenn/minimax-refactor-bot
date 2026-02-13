import { readFile } from "node:fs/promises";

import { CommandExecutionError, type CommandExecutor } from "../utils/exec.js";

export interface DiffChunk {
  files: string[];
  diff: string;
}

export interface DiffContext {
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  fullDiff: string;
  chunks: DiffChunk[];
}

export interface PushEventPayload {
  before?: string;
  after?: string;
  ref?: string;
}

export const readPushEventPayload = async (eventPath?: string): Promise<PushEventPayload | null> => {
  if (!eventPath) {
    return null;
  }

  const raw = await readFile(eventPath, "utf8");
  const payload = JSON.parse(raw) as PushEventPayload;
  return payload;
};

export class GitDiffExtractor {
  private readonly executor: CommandExecutor;
  private readonly maxDiffSize: number;

  public constructor(executor: CommandExecutor, maxDiffSize: number) {
    this.executor = executor;
    this.maxDiffSize = maxDiffSize;
  }

  public async resolveRangeFromEvent(eventPath?: string): Promise<{ baseSha: string; headSha: string }> {
    const payload = await readPushEventPayload(eventPath);

    if (payload?.before && payload.after && payload.before !== "0000000000000000000000000000000000000000") {
      return {
        baseSha: payload.before,
        headSha: payload.after
      };
    }

    const headSha = await this.executor.run("git", ["rev-parse", "HEAD"]);
    const baseSha = await this.executor.run("git", ["rev-parse", "HEAD~1"]);

    return {
      baseSha,
      headSha
    };
  }

  public async extract(baseSha: string, headSha: string): Promise<DiffContext | null> {
    const changedFilesRaw = await this.executor.run("git", ["diff", "--name-only", baseSha, headSha]);
    const changedFiles = changedFilesRaw
      .split("\n")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (changedFiles.length === 0) {
      return null;
    }

    const fullDiff = await this.executor.run("git", ["diff", "--unified=3", baseSha, headSha]);
    if (!fullDiff.trim()) {
      return null;
    }

    const chunks =
      fullDiff.length <= this.maxDiffSize
        ? [{ files: changedFiles, diff: fullDiff }]
        : await this.splitDiffByFile(baseSha, headSha, changedFiles);

    return {
      baseSha,
      headSha,
      changedFiles,
      fullDiff,
      chunks
    };
  }

  private async splitDiffByFile(baseSha: string, headSha: string, files: string[]): Promise<DiffChunk[]> {
    const chunks: DiffChunk[] = [];
    let currentDiff = "";
    let currentFiles: string[] = [];

    for (const file of files) {
      const fileDiff = await this.executor.run("git", ["diff", "--unified=3", baseSha, headSha, "--", file]);
      if (!fileDiff.trim()) {
        continue;
      }

      const nextLength = currentDiff.length + fileDiff.length + 1;
      if (nextLength > this.maxDiffSize && currentDiff.length > 0) {
        chunks.push({ files: currentFiles, diff: currentDiff.trimEnd() });
        currentDiff = "";
        currentFiles = [];
      }

      currentDiff += `${fileDiff.trimEnd()}\n`;
      currentFiles.push(file);
    }

    if (currentDiff.trim()) {
      chunks.push({ files: currentFiles, diff: currentDiff.trimEnd() });
    }

    if (chunks.length === 0) {
      throw new CommandExecutionError({
        command: "git",
        args: ["diff", "--unified=3", baseSha, headSha],
        stdout: "",
        stderr: "Diff split produced no chunks while changes existed",
        exitCode: undefined
      });
    }

    return chunks;
  }
}
