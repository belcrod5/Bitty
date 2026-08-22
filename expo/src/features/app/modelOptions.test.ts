import {
  THINK_OPTIONS,
  currentModelFallback,
  effortOptionsForModel,
  isModelSelectionBlocked,
  modelOptionsFromStatuses,
} from "./modelOptions";

test("builds stable composite selections when backends publish the same model id", () => {
  const options = modelOptionsFromStatuses([
    {
      backendId: "first",
      capabilities: {
        model: { effort: true, changeWithinSession: true, catalog: [{ modelId: "shared", label: "First" }] },
        operations: { schedule: true },
      },
    },
    {
      backendId: "second",
      capabilities: { model: { effort: false, changeWithinSession: false, catalog: [{ modelId: "shared", label: "Second" }] } },
    },
  ]);

  expect(options.map((option) => option.selectionKey)).toEqual(["first::shared", "second::shared"]);
  expect(options[0]?.supportsScheduling).toBe(true);
  expect(options[1]?.supportsScheduling).toBe(false);
  expect(options.every((option) => option.selectable)).toBe(true);
  expect(options[1]).toMatchObject({ supportsReasoningEffort: false, changeWithinSession: false });
});

test("maps the backend's advertised effort catalog and renders only advertised values", () => {
  const options = modelOptionsFromStatuses([
    {
      backendId: "codex",
      capabilities: {
        model: {
          effort: true,
          effortOptions: ["low", "medium", "high", "xhigh", "max", "ultra"],
          changeWithinSession: true,
          catalog: [{ modelId: "gpt-5.6-sol", label: "Sol" }],
        },
        operations: { compact: true, compactQueue: true },
      },
    },
    {
      backendId: "claude",
      capabilities: {
        model: {
          effort: true,
          effortOptions: ["low", "medium", "high", "xhigh", "max", "not-an-effort"],
          changeWithinSession: false,
          catalog: [{ modelId: "sonnet", label: "Claude Sonnet" }],
        },
        // claudeはcompact対応でもcodex raw固有のcompact queueには非対応
        operations: { compact: true, compactQueue: false },
      },
    },
  ]);

  expect(effortOptionsForModel(options[0])).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  expect(effortOptionsForModel(options[1])).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(effortOptionsForModel(options[1])).not.toContain("ultra");
  expect(options[0]?.supportsCompactQueue).toBe(true);
  expect(options[1]?.supportsCompactQueue).toBe(false);
});

test("falls back to the full effort list only when a backend advertises no effort catalog", () => {
  const [option] = modelOptionsFromStatuses([
    {
      backendId: "legacy",
      capabilities: { model: { effort: true, catalog: [{ modelId: "legacy-model" }] } },
    },
  ]);
  expect(effortOptionsForModel(option)).toEqual(THINK_OPTIONS);
  expect(effortOptionsForModel({ supportsReasoningEffort: false })).toEqual([]);
  expect(effortOptionsForModel(undefined)).toEqual([]);
});

test("does not invent capabilities for a model missing from the current catalog", () => {
  expect(currentModelFallback("claude", "future-model")).toMatchObject({
    supportsReasoningEffort: false,
    changeWithinSession: false,
    selectable: false,
  });
});

test("blocks backend changes and unsupported in-session model changes only for locked sessions", () => {
  expect(isModelSelectionBlocked({
    sessionLocked: true,
    currentBackendId: "claude",
    currentModelId: "sonnet",
    currentChangeWithinSession: false,
    nextBackendId: "claude",
    nextModelId: "opus",
  })).toBe(true);
  expect(isModelSelectionBlocked({
    sessionLocked: true,
    currentBackendId: "future-backend",
    currentModelId: "unknown-model",
    currentChangeWithinSession: undefined,
    nextBackendId: "future-backend",
    nextModelId: "another-model",
  })).toBe(true);
  expect(isModelSelectionBlocked({
    sessionLocked: true,
    currentBackendId: "codex",
    currentModelId: "shared-model",
    currentChangeWithinSession: true,
    nextBackendId: "claude",
    nextModelId: "shared-model",
  })).toBe(true);
  expect(isModelSelectionBlocked({
    sessionLocked: false,
    currentBackendId: "claude",
    currentModelId: "sonnet",
    currentChangeWithinSession: false,
    nextBackendId: "codex",
    nextModelId: "gpt",
  })).toBe(false);
});
