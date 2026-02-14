import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BotConfig } from "./config.js";
import { CommandExecutionError, type CommandExecutor } from "../utils/exec.js";
import type { Logger } from "../utils/logger.js";

export interface WatchEventContext {
  eventPath: string;
  baseSha: string;
  headSha: string;
}

export interface WatcherDependencies {
  config: Pick<BotConfig, "baseBranch" | "watchPollIntervalMs">;
  executor: CommandExecutor;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export type WatchPollResult = "idle" | "processed" | "failed";

const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class PollingPushWatcher {
  private readonly config: WatcherDependencies["config"];
  private readonly executor: CommandExecutor;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private stopped = false;
  private baselineHeadSha: string | null = null;

  public constructor(deps: WatcherDependencies) {
    this.config = deps.config;
    this.executor = deps.executor;
    this.logger = deps.logger;
    this.sleep = deps.sleep ?? sleepDefault;
  }

  public async initialize(): Promise<void> {
    await this.syncBaseBranch({ fetch: true });
    this.baselineHeadSha = await this.readRemoteHeadSha();

    this.logger.info("Watch baseline initialized", {
      baseBranch: this.config.baseBranch,
      pollIntervalMs: this.config.watchPollIntervalMs,
      baselineHeadSha: this.baselineHeadSha
    });
  }

  public async pollOnce(
    onPushEvent: (context: WatchEventContext) => Promise<void>
  ): Promise<WatchPollResult> {
    if (!this.baselineHeadSha) {
      await this.initialize();
    }

    const previousHeadSha = this.baselineHeadSha;
    if (!previousHeadSha) {
      throw new Error("Watch baseline could not be initialized");
    }

    await this.fetchBaseBranch();
    const nextHeadSha = await this.readRemoteHeadSha();
    if (nextHeadSha === previousHeadSha) {
      return "idle";
    }

    const baseSha = await this.resolveBaseSha(previousHeadSha, nextHeadSha);
    const eventPath = await this.writeTemporaryEventPayload(baseSha, nextHeadSha);

    this.logger.info("Detected new commit range on base branch", {
      before: baseSha,
      after: nextHeadSha
    });

    try {
      await this.syncBaseBranch({ fetch: false });
      await onPushEvent({
        eventPath,
        baseSha,
        headSha: nextHeadSha
      });

      this.baselineHeadSha = nextHeadSha;
      return "processed";
    } catch (error) {
      this.logger.warn("Watch iteration failed; same range will be retried", {
        error: error instanceof Error ? error.message : String(error),
        before: baseSha,
        after: nextHeadSha
      });
      return "failed";
    } finally {
      await rm(path.dirname(eventPath), { recursive: true, force: true });
      await this.safeReturnToBaseBranch();
    }
  }

  public async watch(onPushEvent: (context: WatchEventContext) => Promise<void>): Promise<void> {
    await this.initialize();

    const stop = (): void => {
      if (this.stopped) {
        return;
      }

      this.stopped = true;
      this.logger.info("Stop signal received, ending watch loop");
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    try {
      while (!this.stopped) {
        await this.sleep(this.config.watchPollIntervalMs);
        if (this.stopped) {
          break;
        }

        try {
          await this.pollOnce(onPushEvent);
        } catch (error) {
          if (this.stopped) {
            break;
          }

          this.logger.warn("Watch polling loop error", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }

  private async safeReturnToBaseBranch(): Promise<void> {
    try {
      await this.syncBaseBranch({ fetch: false });
    } catch (error) {
      this.logger.warn("Failed to restore base branch after watch iteration", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async resolveBaseSha(previousHeadSha: string, nextHeadSha: string): Promise<string> {
    const previousIsAncestor = await this.isAncestor(previousHeadSha, nextHeadSha);
    if (previousIsAncestor) {
      return previousHeadSha;
    }

    try {
      const mergeBase = await this.executor.run("git", ["merge-base", previousHeadSha, nextHeadSha]);
      if (mergeBase.trim()) {
        return mergeBase.trim();
      }
    } catch {
      // ignore and fall back to parent commit of head
    }

    try {
      return await this.executor.run("git", ["rev-parse", `${nextHeadSha}~1`]);
    } catch {
      return previousHeadSha;
    }
  }

  private async isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean> {
    try {
      await this.executor.run("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha]);
      return true;
    } catch (error) {
      if (error instanceof CommandExecutionError && error.exitCode === 1) {
        return false;
      }

      throw error;
    }
  }

  private async fetchBaseBranch(): Promise<void> {
    await this.executor.run("git", ["fetch", "origin", this.config.baseBranch]);
  }

  private async readRemoteHeadSha(): Promise<string> {
    return this.executor.run("git", ["rev-parse", `origin/${this.config.baseBranch}`]);
  }

  private async syncBaseBranch(options: { fetch: boolean }): Promise<void> {
    await this.executor.run("git", ["checkout", this.config.baseBranch]);

    if (options.fetch) {
      await this.fetchBaseBranch();
    }

    await this.executor.run("git", ["merge", "--ff-only", `origin/${this.config.baseBranch}`]);
  }

  private async writeTemporaryEventPayload(baseSha: string, headSha: string): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "minimax-watch-"));
    const eventPath = path.join(tempDir, "event.json");

    await writeFile(
      eventPath,
      JSON.stringify({
        before: baseSha,
        after: headSha,
        ref: `refs/heads/${this.config.baseBranch}`
      }),
      "utf8"
    );

    return eventPath;
  }
}
