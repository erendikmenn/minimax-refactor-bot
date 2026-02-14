import type { MinimaxAgent } from "../ai/minimax-agent.js";
import type { DiffChunk } from "../git/diff.js";
import type { Logger } from "../utils/logger.js";

export interface PatchGenerationInput {
  repository: string;
  baseRef: string;
  headRef: string;
  chunks: DiffChunk[];
}

export interface PatchGenerationResult {
  patches: Array<{
    patch: string;
    chunk: DiffChunk;
  }>;
  skippedChunks: number;
  failedChunks: number;
  failureBreakdown: {
    timeout: number;
    invalid_output: number;
    api_error: number;
    unknown: number;
  };
}

export interface PatchRepairInput {
  repository: string;
  baseRef: string;
  headRef: string;
  chunk: DiffChunk;
  failedPatch: string;
  applyError: string;
}

export type ChunkFailureType = "timeout" | "invalid_output" | "api_error" | "unknown";

const classifyChunkFailure = (error: unknown): ChunkFailureType => {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (message.includes("aborted") || message.includes("timeout")) {
    return "timeout";
  }

  if (
    message.includes("invalid unified diff") ||
    message.includes("invalid: expected unified diff") ||
    message.includes("not a valid unified diff")
  ) {
    return "invalid_output";
  }

  if (message.includes("openrouter request failed") || message.includes("status 429") || message.includes("status 5")) {
    return "api_error";
  }

  return "unknown";
};

export class PatchGenerator {
  private readonly agent: MinimaxAgent;
  private readonly logger: Logger;

  public constructor(agent: MinimaxAgent, logger: Logger) {
    this.agent = agent;
    this.logger = logger;
  }

  public async generate(input: PatchGenerationInput): Promise<PatchGenerationResult> {
    const patches: Array<{ patch: string; chunk: DiffChunk }> = [];
    let skippedChunks = 0;
    let failedChunks = 0;
    const failureBreakdown = {
      timeout: 0,
      invalid_output: 0,
      api_error: 0,
      unknown: 0
    };
    const totalChunks = input.chunks.length;

    for (const [index, chunk] of input.chunks.entries()) {
      this.logger.info("Requesting MiniMax patch", {
        chunk: `${index + 1}/${totalChunks}`,
        fileCount: chunk.files.length,
        diffSize: chunk.diff.length
      });

      let result;
      try {
        result = await this.agent.generatePatch({
          repository: input.repository,
          baseRef: input.baseRef,
          headRef: input.headRef,
          changedFiles: chunk.files,
          diff: chunk.diff,
          snapshots: chunk.snapshots
        });
      } catch (error) {
        const failureType = classifyChunkFailure(error);
        failureBreakdown[failureType] += 1;
        failedChunks += 1;

        this.logger.warn("MiniMax chunk generation failed; skipping chunk", {
          chunk: `${index + 1}/${totalChunks}`,
          failureType,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      if (result.status === "no_changes") {
        this.logger.info("MiniMax returned NO_CHANGES_NEEDED for chunk", {
          chunk: `${index + 1}/${totalChunks}`
        });
        skippedChunks += 1;
        continue;
      }

      this.logger.info("MiniMax returned patch for chunk", {
        chunk: `${index + 1}/${totalChunks}`,
        patchSize: result.patch.length
      });
      patches.push({ patch: result.patch, chunk });
    }

    return { patches, skippedChunks, failedChunks, failureBreakdown };
  }

  public async repairPatch(input: PatchRepairInput): Promise<string | null> {
    this.logger.warn("Attempting MiniMax patch repair", {
      fileCount: input.chunk.files.length
    });

    const result = await this.agent.repairPatch({
      repository: input.repository,
      baseRef: input.baseRef,
      headRef: input.headRef,
      changedFiles: input.chunk.files,
      diff: input.chunk.diff,
      snapshots: input.chunk.snapshots,
      failedPatch: input.failedPatch,
      applyError: input.applyError
    });

    if (result.status === "no_changes") {
      return null;
    }

    return result.patch;
  }
}
