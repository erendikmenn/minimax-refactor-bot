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
  patches: string[];
  skippedChunks: number;
}

export class PatchGenerator {
  private readonly agent: MinimaxAgent;
  private readonly logger: Logger;

  public constructor(agent: MinimaxAgent, logger: Logger) {
    this.agent = agent;
    this.logger = logger;
  }

  public async generate(input: PatchGenerationInput): Promise<PatchGenerationResult> {
    const patches: string[] = [];
    let skippedChunks = 0;

    for (const [index, chunk] of input.chunks.entries()) {
      this.logger.info("Requesting MiniMax patch for chunk", {
        chunkIndex: index,
        fileCount: chunk.files.length,
        diffSize: chunk.diff.length
      });

      const result = await this.agent.generatePatch({
        repository: input.repository,
        baseRef: input.baseRef,
        headRef: input.headRef,
        changedFiles: chunk.files,
        diff: chunk.diff
      });

      if (result.status === "no_changes") {
        skippedChunks += 1;
        continue;
      }

      patches.push(result.patch);
    }

    return { patches, skippedChunks };
  }
}
