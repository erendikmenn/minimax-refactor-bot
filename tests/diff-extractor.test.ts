import { describe, expect, it } from "vitest";

import { GitDiffExtractor } from "../src/git/diff";
import type { CommandExecutor } from "../src/utils/exec";

class FakeExecutor implements CommandExecutor {
  public calls: Array<{ command: string; args: string[] }> = [];

  public async run(command: string, args: string[]): Promise<string> {
    this.calls.push({ command, args });

    if (command !== "git") {
      throw new Error(`Unexpected command ${command}`);
    }

    if (args[0] === "diff" && args[1] === "--name-only") {
      return "src/index.ts\npackage-lock.json\n";
    }

    if (
      args[0] === "diff" &&
      args[1] === "--unified=3" &&
      args[2] === "base" &&
      args[3] === "head" &&
      args[4] === "--" &&
      args[5] === "src/index.ts"
    ) {
      return [
        "diff --git a/src/index.ts b/src/index.ts",
        "--- a/src/index.ts",
        "+++ b/src/index.ts",
        "@@ -1 +1 @@",
        "-const x=1;",
        "+const x = 1;"
      ].join("\n");
    }

    if (args[0] === "show" && args[1] === "HEAD:src/index.ts") {
      return "const x = 1;\n";
    }

    throw new Error(`Unexpected git args: ${args.join(" ")}`);
  }
}

describe("GitDiffExtractor", () => {
  it("excludes configured files from chunking and snapshot prompts", async () => {
    const executor = new FakeExecutor();
    const extractor = new GitDiffExtractor(executor, 10000, 1, ["(^|/)package-lock\\.json$"]);

    const result = await extractor.extract("base", "head");
    expect(result).not.toBeNull();

    if (!result) {
      return;
    }

    expect(result.changedFiles).toEqual(["src/index.ts"]);
    expect(result.excludedFiles).toEqual(["package-lock.json"]);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.files).toEqual(["src/index.ts"]);

    const touchedPackageLock = executor.calls.some(
      (call) => call.args.includes("package-lock.json")
    );
    expect(touchedPackageLock).toBe(false);
  });

  it("returns null when only excluded files changed", async () => {
    const executor: CommandExecutor = {
      run: async (command, args) => {
        if (command !== "git") {
          throw new Error("Unexpected command");
        }

        if (args[0] === "diff" && args[1] === "--name-only") {
          return "package-lock.json\n";
        }

        throw new Error(`Unexpected git args: ${args.join(" ")}`);
      }
    };

    const extractor = new GitDiffExtractor(executor, 10000, 1, ["(^|/)package-lock\\.json$"]);
    const result = await extractor.extract("base", "head");
    expect(result).toBeNull();
  });
});
