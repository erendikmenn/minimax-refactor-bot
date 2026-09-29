import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/core/config";

const baseEnv = {
  OPENROUTER_API_KEY: "key",
  GITHUB_TOKEN: "token",
  GITHUB_REPOSITORY: "acme/repo",
  GITHUB_REF_NAME: "main"
} as NodeJS.ProcessEnv;

describe("loadConfig FILE_EXCLUDE_PATTERNS", () => {
  it("uses default patterns when FILE_EXCLUDE_PATTERNS is an empty string", () => {
    const config = loadConfig({
      ...baseEnv,
      FILE_EXCLUDE_PATTERNS: ""
    });

    expect(config.fileExcludePatterns).toContain("(^|/)package-lock\\.json$");
    expect(config.fileExcludePatterns.length).toBeGreaterThan(0);
  });

  it("uses default patterns when FILE_EXCLUDE_PATTERNS is whitespace", () => {
    const config = loadConfig({
      ...baseEnv,
      FILE_EXCLUDE_PATTERNS: "   "
    });

    expect(config.fileExcludePatterns).toContain("(^|/)package-lock\\.json$");
    expect(config.fileExcludePatterns.length).toBeGreaterThan(0);
  });

  it("allows disabling exclusion with sentinel value", () => {
    const config = loadConfig({
      ...baseEnv,
      FILE_EXCLUDE_PATTERNS: "none"
    });

    expect(config.fileExcludePatterns).toEqual([]);
  });

  it("supports JSON-array regex patterns containing commas", () => {
    const config = loadConfig({
      ...baseEnv,
      FILE_EXCLUDE_PATTERNS: String.raw`["(?:foo,bar)","(^|/)package-lock\\.json$"]`
    });

    expect(config.fileExcludePatterns).toEqual(["(?:foo,bar)", "(^|/)package-lock\\.json$"]);
  });

  it("validates regex with runtime flags", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        FILE_EXCLUDE_PATTERNS: "["
      })
    ).toThrow(ConfigError);
  });
});

describe("loadConfig performance defaults", () => {
  it("uses faster chunk defaults when env vars are unset", () => {
    const config = loadConfig({
      ...baseEnv,
      MAX_FILES_PER_CHUNK: "",
      MAX_CHUNKS_PER_RUN: ""
    });

    expect(config.maxFilesPerChunk).toBe(4);
    expect(config.maxChunksPerRun).toBe(20);
  });
});
