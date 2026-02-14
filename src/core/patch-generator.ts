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
}

export interface PatchRepairInput {
  repository: string;
  baseRef: string;
  headRef: string;
  chunk: DiffChunk;
  failedPatch: string;
  applyError: string;
}

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
    const totalChunks = input.chunks.length;

    for (const [index, chunk] of input.chunks.entries()) {
      this.logger.info("Requesting MiniMax patch", {
        chunk: `${index + 1}/${totalChunks}`,
        fileCount: chunk.files.length,
        diffSize: chunk.diff.length
      });

      const result = await this.agent.generatePatch({
        repository: input.repository,
        baseRef: input.baseRef,
        headRef: input.headRef,
        changedFiles: chunk.files,
        diff: chunk.diff,
        snapshots: chunk.snapshots
      });

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

    return { patches, skippedChunks };
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
