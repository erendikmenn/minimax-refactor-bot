import { readFile } from "node:fs/promises";

import { CommandExecutionError, type CommandExecutor } from "../utils/exec.js";

export interface DiffChunk {
  files: string[];
  diff: string;
  snapshots: Array<{
    path: string;
    content: string;
  }>;
}

export interface DiffContext {
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  excludedFiles: string[];
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
  private readonly maxFilesPerChunk: number;
  private readonly excludedFileRegexes: RegExp[];

  public constructor(
    executor: CommandExecutor,
    maxDiffSize: number,
    maxFilesPerChunk = 1,
    fileExcludePatterns: string[] = []
  ) {
    this.executor = executor;
    this.maxDiffSize = maxDiffSize;
    this.maxFilesPerChunk = Math.max(1, maxFilesPerChunk);
    this.excludedFileRegexes = fileExcludePatterns.map((pattern) => new RegExp(pattern, "i"));
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

    const includedFiles = changedFiles.filter((file) => this.shouldIncludeFile(file));
    const excludedFiles = changedFiles.filter((file) => !this.shouldIncludeFile(file));

    if (includedFiles.length === 0) {
      return null;
    }

    const fullDiff = await this.executor.run("git", [
      "diff",
      "--unified=3",
      baseSha,
      headSha,
      "--",
      ...includedFiles
    ]);
    if (!fullDiff.trim()) {
      return null;
    }

    const chunks = await this.splitDiffByFile(baseSha, headSha, includedFiles);

    return {
      baseSha,
      headSha,
      changedFiles: includedFiles,
      excludedFiles,
      fullDiff,
      chunks
    };
  }

  private shouldIncludeFile(file: string): boolean {
    return !this.excludedFileRegexes.some((pattern) => pattern.test(file));
  }

  private async splitDiffByFile(baseSha: string, headSha: string, files: string[]): Promise<DiffChunk[]> {
    const chunks: DiffChunk[] = [];
    let currentDiff = "";
    let currentFiles: string[] = [];
    let currentSnapshots: Array<{ path: string; content: string }> = [];

    for (const file of files) {
      const fileDiff = await this.executor.run("git", ["diff", "--unified=3", baseSha, headSha, "--", file]);
      if (!fileDiff.trim()) {
        continue;
      }

      const nextLength = currentDiff.length + fileDiff.length + 1;
      const chunkWouldOverflow = nextLength > this.maxDiffSize && currentDiff.length > 0;
      const fileLimitReached = currentFiles.length >= this.maxFilesPerChunk && currentDiff.length > 0;

      if (chunkWouldOverflow || fileLimitReached) {
        chunks.push({ files: currentFiles, diff: currentDiff.trimEnd(), snapshots: currentSnapshots });
        currentDiff = "";
        currentFiles = [];
        currentSnapshots = [];
      }

      const snapshot = await this.readHeadFileSnapshot(file);
      currentDiff += `${fileDiff.trimEnd()}\n`;
      currentFiles.push(file);
      currentSnapshots.push({ path: file, content: snapshot });
    }

    if (currentDiff.trim()) {
      chunks.push({ files: currentFiles, diff: currentDiff.trimEnd(), snapshots: currentSnapshots });
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

  private async readHeadFileSnapshot(file: string): Promise<string> {
    try {
      return await this.executor.run("git", ["show", `HEAD:${file}`]);
    } catch {
      return "";
    }
  }
}
