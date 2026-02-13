import type { CommandExecutor } from "../utils/exec.js";

export interface RepositorySummary {
  trackedFileCount: number;
  topLevelDirectories: string[];
}

export class GitRepositoryScanner {
  private readonly executor: CommandExecutor;

  public constructor(executor: CommandExecutor) {
    this.executor = executor;
  }

  public async scanSummary(): Promise<RepositorySummary> {
    const trackedFilesRaw = await this.executor.run("git", ["ls-files"]);
    const trackedFiles = trackedFilesRaw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const directories = new Set<string>();
    for (const file of trackedFiles) {
      const [top] = file.split("/");
      if (top) {
        directories.add(top);
      }
    }

    return {
      trackedFileCount: trackedFiles.length,
      topLevelDirectories: [...directories].sort()
    };
  }
}
