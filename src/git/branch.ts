import type { CommandExecutor } from "../utils/exec.js";

export interface GitIdentity {
  name: string;
  email: string;
}

export class GitBranchManager {
  private readonly executor: CommandExecutor;

  public constructor(executor: CommandExecutor) {
    this.executor = executor;
  }

  public async configureIdentity(identity: GitIdentity): Promise<void> {
    await this.executor.run("git", ["config", "user.name", identity.name]);
    await this.executor.run("git", ["config", "user.email", identity.email]);
  }

  public async createBranch(branchName: string): Promise<void> {
    await this.executor.run("git", ["checkout", "-B", branchName]);
  }

  public async commitAll(message: string): Promise<void> {
    await this.executor.run("git", ["add", "-A"]);
    await this.executor.run("git", ["commit", "-m", message]);
  }

  public async pushBranch(branchName: string): Promise<void> {
    await this.executor.run("git", ["push", "--set-upstream", "origin", branchName]);
  }
}
