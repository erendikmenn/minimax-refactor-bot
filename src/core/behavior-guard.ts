export interface BehaviorGuardAssessment {
  safe: boolean;
  reasons: string[];
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".php",
  ".rb",
  ".cs",
  ".cpp",
  ".c",
  ".h"
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

const getExtension = (filePath: string): string => {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot < 0) {
    return "";
  }
  return filePath.slice(lastDot).toLowerCase();
};

const normalizePath = (value: string): string => {
  if (value.startsWith("a/") || value.startsWith("b/")) {
    return value.slice(2);
  }
  return value;
};

const isTestFile = (filePath: string): boolean => {
  const normalized = filePath.toLowerCase();
  return (
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith(".spec.js")
  );
};

const isDocOrConfigFile = (filePath: string): boolean => {
  const extension = getExtension(filePath);
  if (DOC_EXTENSIONS.has(extension)) {
    return true;
  }

  return filePath.endsWith(".yml") || filePath.endsWith(".yaml") || filePath.endsWith(".json");
};

const isSourceFile = (filePath: string): boolean => SOURCE_EXTENSIONS.has(getExtension(filePath));

const tokenize = (value: string): string[] => {
  return value.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|==={1,2}|!==|!=|<=|>=|=>|\+\+|--|&&|\|\||[{}()[\].,;:+\-*/%?<>!=&|^~]/g) ?? [];
};

export const assessPatchBehaviorRisk = (patch: string): BehaviorGuardAssessment => {
  const reasons: string[] = [];

  let currentFile: string | null = null;
  let inHunk = false;
  const removedByFile = new Map<string, string[]>();
  const addedByFile = new Map<string, string[]>();

  const lines = patch.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(" ");
      const rightPath = parts[3] ?? "";
      currentFile = normalizePath(rightPath);
      inHunk = false;
      continue;
    }

    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }

    if (!inHunk || !currentFile) {
      continue;
    }

    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const added = addedByFile.get(currentFile) ?? [];
      added.push(line.slice(1));
      addedByFile.set(currentFile, added);
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      const removed = removedByFile.get(currentFile) ?? [];
      removed.push(line.slice(1));
      removedByFile.set(currentFile, removed);
      continue;
    }
  }

  const touchedFiles = new Set([...removedByFile.keys(), ...addedByFile.keys()]);

  for (const file of touchedFiles) {
    if (isTestFile(file) || isDocOrConfigFile(file)) {
      continue;
    }

    if (!isSourceFile(file)) {
      reasons.push(`Behavior guard blocked unsupported source file type: ${file}`);
      continue;
    }

    const removedLines = removedByFile.get(file) ?? [];
    const addedLines = addedByFile.get(file) ?? [];

    const removedTokens = tokenize(removedLines.join("\n"));
    const addedTokens = tokenize(addedLines.join("\n"));

    if (removedTokens.length === 0 && addedTokens.length === 0) {
      continue;
    }

    if (removedTokens.join(" ") !== addedTokens.join(" ")) {
      reasons.push(`Behavior guard blocked semantic token changes in ${file}`);
    }
  }

  return {
    safe: reasons.length === 0,
    reasons
  };
};
