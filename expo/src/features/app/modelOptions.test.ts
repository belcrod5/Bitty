import {
  THINK_OPTIONS,
  currentModelFallback,
  effortOptionsForModel,
  isBackendChangeBlocked,
  modelOptionsFromStatuses,
} from "./modelOptions";

test("builds stable composite selections when backends publish the same model id", () => {
  const options = modelOptionsFromStatuses([
    {
      backendId: "first",
      capabilities: {
        model: { effort: true, catalog: [{ modelId: "shared", label: "First" }] },
        operations: { schedule: true },
      },
    },
    {
      backendId: "second",
      capabilities: { model: { effort: false, catalog: [{ modelId: "shared", label: "Second" }] } },
    },
  ]);

  expect(options.map((option) => option.selectionKey)).toEqual(["first::shared", "second::shared"]);
  expect(options[0]?.supportsScheduling).toBe(true);
  expect(options[1]?.supportsScheduling).toBe(false);
  expect(options.every((option) => option.selectable)).toBe(true);
  expect(options[1]).toMatchObject({ supportsReasoningEffort: false });
});

test("maps the backend's advertised effort catalog and renders only advertised values", () => {
  const options = modelOptionsFromStatuses([
    {
      backendId: "codex",
      capabilities: {
        model: {
          effort: true,
          effortOptions: ["low", "medium", "high", "xhigh", "max", "ultra"],
          catalog: [{ modelId: "gpt-5.6-sol", label: "Sol" }],
        },
        operations: { compact: true },
      },
    },
    {
      backendId: "claude",
      capabilities: {
        model: {
          effort: true,
          effortOptions: ["low", "medium", "high", "xhigh", "max", "not-an-effort"],
          catalog: [{ modelId: "sonnet", label: "Claude Sonnet" }],
        },
        operations: { compact: true },
      },
    },
  ]);

  expect(effortOptionsForModel(options[0])).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  expect(effortOptionsForModel(options[1])).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(effortOptionsForModel(options[1])).not.toContain("ultra");
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
    selectable: false,
  });
});

test("blocks only backend changes for locked sessions", () => {
  expect(isBackendChangeBlocked({
    sessionLocked: true,
    currentBackendId: "claude",
    nextBackendId: "claude",
  })).toBe(false);
  expect(isBackendChangeBlocked({
    sessionLocked: true,
    currentBackendId: "codex",
    nextBackendId: "claude",
  })).toBe(true);
  expect(isBackendChangeBlocked({
    sessionLocked: false,
    currentBackendId: "claude",
    nextBackendId: "codex",
  })).toBe(false);
});
