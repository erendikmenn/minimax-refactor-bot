import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class CommandExecutionError extends Error {
  public readonly command: string;
  public readonly args: string[];
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly exitCode: number | undefined;

  public constructor(params: {
    command: string;
    args: string[];
    stdout: string;
    stderr: string;
    exitCode: number | undefined;
    message?: string;
  }) {
    super(params.message ?? `Command failed: ${params.command} ${params.args.join(" ")}`);
    this.name = "CommandExecutionError";
    this.command = params.command;
    this.args = params.args;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.exitCode = params.exitCode;
  }
}

export interface CommandExecutor {
  run(command: string, args: string[], options?: ExecOptions): Promise<string>;
}

export class NodeCommandExecutor implements CommandExecutor {
  public async run(command: string, args: string[], options?: ExecOptions): Promise<string> {
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd: options?.cwd,
        env: options?.env,
        timeout: options?.timeoutMs,
        maxBuffer: 10 * 1024 * 1024
      });

      return stdout.trimEnd();
    } catch (error) {
      const typed = error as {
        stdout?: string;
        stderr?: string;
        code?: number;
        message: string;
      };

      throw new CommandExecutionError({
        command,
        args,
        stdout: typed.stdout ?? "",
        stderr: typed.stderr ?? "",
        exitCode: typeof typed.code === "number" ? typed.code : undefined,
        message: typed.message
      });
    }
  }
}
