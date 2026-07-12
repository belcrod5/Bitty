import {
  RUNTIME_CONVERSATION_FRESHNESS_GRACE_MS,
  shouldPreserveRuntimeConversationOnHydrate,
} from "./panelHydrationFreshness";

const NOW_MS = 1_700_000_000_000;

function buildInput(overrides: Partial<Parameters<typeof shouldPreserveRuntimeConversationOnHydrate>[0]> = {}) {
  return {
    runtimeMessageCount: 3,
    runtimeUpdatedAtMs: NOW_MS,
    runtimeIsResponding: false,
    requestCompletedAtMs: null,
    restoredUpdatedAtMs: null,
    restoredMessageCount: 3,
    nowMs: NOW_MS,
    ...overrides,
  };
}

describe("shouldPreserveRuntimeConversationOnHydrate", () => {
  it("returns false when runtime has no messages, regardless of other conditions", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      runtimeMessageCount: 0,
      runtimeIsResponding: true,
      requestCompletedAtMs: NOW_MS,
      restoredUpdatedAtMs: 0,
      restoredMessageCount: 0,
    }));
    expect(result).toBe(false);
  });

  it("returns true when a live turn is responding, even if other conditions are unfavorable", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      runtimeIsResponding: true,
      requestCompletedAtMs: null,
      runtimeUpdatedAtMs: 0,
      restoredUpdatedAtMs: NOW_MS + 1_000_000,
      restoredMessageCount: 999,
    }));
    expect(result).toBe(true);
  });

  it("returns true when the request completed exactly at the grace boundary", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      requestCompletedAtMs: NOW_MS - RUNTIME_CONVERSATION_FRESHNESS_GRACE_MS,
    }));
    expect(result).toBe(true);
  });

  it("falls through to the next check when the completion grace has just elapsed", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      requestCompletedAtMs: NOW_MS - RUNTIME_CONVERSATION_FRESHNESS_GRACE_MS - 1,
      restoredUpdatedAtMs: NOW_MS + 1,
      runtimeUpdatedAtMs: NOW_MS,
    }));
    expect(result).toBe(false);
  });

  it("prefers runtime when its updatedAtMs is greater than or equal to restored (timestamp comparison)", () => {
    const greater = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      runtimeUpdatedAtMs: NOW_MS,
      restoredUpdatedAtMs: NOW_MS - 1,
    }));
    expect(greater).toBe(true);

    const equal = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      runtimeUpdatedAtMs: NOW_MS,
      restoredUpdatedAtMs: NOW_MS,
    }));
    expect(equal).toBe(true);
  });

  it("returns false when restored updatedAtMs is newer than runtime", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      runtimeUpdatedAtMs: NOW_MS - 1,
      restoredUpdatedAtMs: NOW_MS,
    }));
    expect(result).toBe(false);
  });

  it("falls back to message count comparison when both timestamps are missing", () => {
    const preserved = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      restoredUpdatedAtMs: null,
      runtimeMessageCount: 5,
      restoredMessageCount: 5,
    }));
    expect(preserved).toBe(true);

    const replaced = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      restoredUpdatedAtMs: null,
      runtimeMessageCount: 2,
      restoredMessageCount: 5,
    }));
    expect(replaced).toBe(false);
  });
});
