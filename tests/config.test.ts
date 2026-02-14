import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/core/config";

const baseEnv = {
  OPENROUTER_API_KEY: "key",
  GITHUB_TOKEN: "token",
  GITHUB_REPOSITORY: "acme/repo",
  GITHUB_REF_NAME: "main"
} as NodeJS.ProcessEnv;

describe("loadConfig FILE_EXCLUDE_PATTERNS", () => {
  it("allows disabling exclusion with whitespace-only value", () => {
    const config = loadConfig({
      ...baseEnv,
      FILE_EXCLUDE_PATTERNS: "   "
    });

    expect(config.fileExcludePatterns).toEqual([]);
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
