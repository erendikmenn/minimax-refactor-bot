import { access, readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { PollingPushWatcher } from "../src/core/watch";
import { CommandExecutionError, type CommandExecutor } from "../src/utils/exec";

class FakeExecutor implements CommandExecutor {
  public remoteHeadSha = "sha1";
  public mergeBaseSha = "mergebase";
  public ancestorCheck = true;

  public async run(command: string, args: string[]): Promise<string> {
    if (command !== "git") {
      throw new Error(`Unexpected command: ${command}`);
    }

    if (args[0] === "checkout") {
      return "";
    }

    if (args[0] === "fetch") {
      return "";
    }

    if (args[0] === "merge" && args[1] === "--ff-only") {
      return "";
    }

    if (args[0] === "rev-parse" && args[1] === "origin/main") {
      return this.remoteHeadSha;
    }

    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      if (this.ancestorCheck) {
        return "";
      }

      throw new CommandExecutionError({
        command,
        args,
        stdout: "",
        stderr: "",
        exitCode: 1,
        message: "not an ancestor"
      });
    }

    if (args[0] === "merge-base" && args.length === 3) {
      return this.mergeBaseSha;
    }

    if (args[0] === "rev-parse" && typeof args[1] === "string" && args[1].endsWith("~1")) {
      return "fallback-parent";
    }

    throw new Error(`Unexpected git args: ${args.join(" ")}`);
  }
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
};

describe("PollingPushWatcher", () => {
  it("returns idle when no new remote commit exists", async () => {
    const executor = new FakeExecutor();
    const watcher = new PollingPushWatcher({
      config: {
        baseBranch: "main",
        watchPollIntervalMs: 10
      },
      executor,
      logger
    });

    await watcher.initialize();
    const callback = vi.fn();

    const result = await watcher.pollOnce(callback);
    expect(result).toBe("idle");
    expect(callback).not.toHaveBeenCalled();
  });

  it("emits a temporary push event payload when new commit is detected", async () => {
    const executor = new FakeExecutor();
    const watcher = new PollingPushWatcher({
      config: {
        baseBranch: "main",
        watchPollIntervalMs: 10
      },
      executor,
      logger
    });

    await watcher.initialize();
    executor.remoteHeadSha = "sha2";

    let emittedPath = "";
    const callback = vi.fn(async ({ eventPath }) => {
      emittedPath = eventPath;
      const payloadRaw = await readFile(eventPath, "utf8");
      const payload = JSON.parse(payloadRaw) as { before: string; after: string; ref: string };

      expect(payload.before).toBe("sha1");
      expect(payload.after).toBe("sha2");
      expect(payload.ref).toBe("refs/heads/main");
    });

    const result = await watcher.pollOnce(callback);
    expect(result).toBe("processed");
    expect(callback).toHaveBeenCalledTimes(1);
    await expect(access(emittedPath)).rejects.toThrow();
  });

  it("retries the same commit range after callback failure", async () => {
    const executor = new FakeExecutor();
    const watcher = new PollingPushWatcher({
      config: {
        baseBranch: "main",
        watchPollIntervalMs: 10
      },
      executor,
      logger
    });

    await watcher.initialize();
    executor.remoteHeadSha = "sha2";

    const failing = vi.fn(async () => {
      throw new Error("boom");
    });

    const first = await watcher.pollOnce(failing);
    expect(first).toBe("failed");

    const succeeding = vi.fn(async () => {
      return;
    });

    const second = await watcher.pollOnce(succeeding);
    expect(second).toBe("processed");
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});
