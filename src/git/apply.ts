import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CommandExecutionError, type CommandExecutor } from "../utils/exec.js";

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
        throw new Error(
          `Failed to apply patch with git apply: ${error.stderr || error.stdout || error.message}`
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
