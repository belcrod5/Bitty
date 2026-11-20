import { act, renderHook } from "@testing-library/react-native";
import { Alert } from "react-native";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import { useChatModelSelection } from "./useChatModelSelection";

const modelOptions = [
  {
    selectionKey: "codex::gpt-5.6-sol",
    backendId: "codex",
    modelId: "gpt-5.6-sol",
    label: "ChatGPT 5.6 Sol",
    supportsReasoningEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    selectionKey: "claude::sonnet",
    backendId: "claude",
    modelId: "sonnet",
    label: "Claude Sonnet",
    supportsReasoningEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    selectionKey: "claude::opus",
    backendId: "claude",
    modelId: "opus",
    label: "Claude Opus",
    supportsReasoningEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
  },
] as const;

function localDraft(): PanelRuntimeSnapshot {
  return {
    panelId: "drawer-session-popup",
    backendId: "codex",
    selectedSessionId: "local-draft",
    sessionMaterialized: false,
    selectedDirectoryPath: "/workspace",
    selectedDirectoryDisplayName: "workspace",
    selectedSessionTitle: "（ユーザーメッセージなし）",
    selectedSessionUpdatedAt: "",
    selectedSessionMarkerColor: "gray",
    selectedThreadStatusType: "idle",
    modelRef: "gpt-5.6-sol",
    reasoningEffort: "medium",
    contextUsedPct: null,
    isResponding: false,
    inheritedConversationMessages: [],
    conversationMessages: [],
  };
}

test("a local panel draft can select Claude before its first send", async () => {
  const updatePanelSettings = jest.fn();
  const closePicker = jest.fn();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { result } = await renderHook(() => useChatModelSelection({
    isPanelRuntimeView: true,
    panelId: "drawer-session-popup",
    panelSnapshot: localDraft(),
    conversationMessageCount: 0,
    llmBackend: "codex",
    modelRef: "gpt-5.6-sol",
    reasoningEffort: "medium",
    selectedModelLabel: "ChatGPT 5.6 Sol",
    modelOptions,
    selectModel: jest.fn(),
    updatePanelSettings,
    closePicker,
  }));

  await act(async () => result.current.selectModelForView("claude::sonnet"));

  expect(alert).not.toHaveBeenCalled();
  expect(updatePanelSettings).toHaveBeenCalledWith("drawer-session-popup", {
    backendId: "claude",
    modelRef: "sonnet",
  });
  expect(closePicker).toHaveBeenCalledWith(null);
  alert.mockRestore();
});

test("an unmaterialized panel draft adopts its backend's first advertised model", async () => {
  const updatePanelSettings = jest.fn();
  await renderHook(() => useChatModelSelection({
    isPanelRuntimeView: true,
    panelId: "drawer-session-popup",
    panelSnapshot: { ...localDraft(), modelRef: "" },
    conversationMessageCount: 0,
    llmBackend: "codex",
    modelRef: "",
    reasoningEffort: "medium",
    selectedModelLabel: "",
    modelOptions,
    selectModel: jest.fn(),
    updatePanelSettings,
    closePicker: jest.fn(),
  }));

  expect(updatePanelSettings).toHaveBeenCalledWith("drawer-session-popup", { modelRef: "gpt-5.6-sol" });
});

test("the effort picker renders only the backend-advertised catalog for the selected model", async () => {
  const { result } = await renderHook(() => useChatModelSelection({
    isPanelRuntimeView: true,
    panelId: "drawer-session-popup",
    panelSnapshot: { ...localDraft(), backendId: "claude", modelRef: "sonnet" },
    conversationMessageCount: 0,
    llmBackend: "codex",
    modelRef: "gpt-5.6-sol",
    reasoningEffort: "medium",
    selectedModelLabel: "ChatGPT 5.6 Sol",
    modelOptions,
    selectModel: jest.fn(),
    updatePanelSettings: jest.fn(),
    closePicker: jest.fn(),
  }));

  expect(result.current.reasoningEffortSupportedForView).toBe(true);
  expect(result.current.effortOptionsForView).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(result.current.effortOptionsForView).not.toContain("ultra");
});

test("an empty native session cannot change Provider after hydration fails", async () => {
  const updatePanelSettings = jest.fn();
  const closePicker = jest.fn();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { result } = await renderHook(() => useChatModelSelection({
    isPanelRuntimeView: true,
    panelId: "drawer-session-popup",
    panelSnapshot: {
      ...localDraft(),
      selectedSessionId: "native-session",
      sessionMaterialized: true,
      isHydrating: false,
      selectedThreadStatusType: "error",
    },
    conversationMessageCount: 0,
    llmBackend: "codex",
    modelRef: "gpt-5.6-sol",
    reasoningEffort: "medium",
    selectedModelLabel: "ChatGPT 5.6 Sol",
    modelOptions,
    selectModel: jest.fn(),
    updatePanelSettings,
    closePicker,
  }));

  await act(async () => result.current.selectModelForView("claude::sonnet"));

  expect(alert).toHaveBeenCalledWith(
    "新規チャットが必要です",
    "チャットの途中でAgent Providerは変更できません。",
  );
  expect(updatePanelSettings).not.toHaveBeenCalled();
  expect(closePicker).toHaveBeenCalledWith(null);
  alert.mockRestore();
});

test("a materialized session can change models within its Provider", async () => {
  const updatePanelSettings = jest.fn();
  const closePicker = jest.fn();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { result } = await renderHook(() => useChatModelSelection({
    isPanelRuntimeView: true,
    panelId: "drawer-session-popup",
    panelSnapshot: {
      ...localDraft(),
      backendId: "claude",
      modelRef: "sonnet",
      selectedSessionId: "native-session",
      sessionMaterialized: true,
    },
    conversationMessageCount: 1,
    llmBackend: "codex",
    modelRef: "gpt-5.6-sol",
    reasoningEffort: "medium",
    selectedModelLabel: "ChatGPT 5.6 Sol",
    modelOptions,
    selectModel: jest.fn(),
    updatePanelSettings,
    closePicker,
  }));

  await act(async () => result.current.selectModelForView("claude::opus"));

  expect(alert).not.toHaveBeenCalled();
  expect(updatePanelSettings).toHaveBeenCalledWith("drawer-session-popup", {
    backendId: "claude",
    modelRef: "opus",
  });
  expect(closePicker).toHaveBeenCalledWith(null);
  alert.mockRestore();
});

test("speed selection follows advertised tiers and remains scoped to the visible panel", async () => {
  const updatePanelSettings = jest.fn();
  const closePicker = jest.fn();
  const { result, rerender } = await renderHook(({ panelSnapshot }: { panelSnapshot: PanelRuntimeSnapshot }) => useChatModelSelection({
    isPanelRuntimeView: true, panelId: panelSnapshot.panelId, panelSnapshot, conversationMessageCount: 1,
    llmBackend: "codex", modelRef: "gpt-5.6-sol", reasoningEffort: "medium", selectedModelLabel: "Codex",
    modelOptions: modelOptions.map((option) => option.backendId === "codex"
      ? { ...option, serviceTiers: ["fast", "ultrafast"] } : option),
    selectModel: jest.fn(), updatePanelSettings, closePicker,
  }), { initialProps: { panelSnapshot: localDraft() } });
  expect(result.current.speedSelectionSupported).toBe(true);
  expect(result.current.serviceTierForView).toBe("default");
  expect(result.current.serviceTierOptions).toEqual([
    { value: "default", label: "Standard" }, { value: "fast", label: "Fast" }, { value: "ultrafast", label: "Ultrafast" },
  ]);
  await act(async () => result.current.selectServiceTier("ultrafast"));
  expect(updatePanelSettings).toHaveBeenLastCalledWith("drawer-session-popup", { serviceTier: "ultrafast" });
  expect(closePicker).toHaveBeenCalledWith(null);

  await rerender({ panelSnapshot: { ...localDraft(), serviceTier: "ultrafast" } });
  expect(result.current.serviceTierForView).toBe("ultrafast");
  await act(async () => result.current.selectServiceTier("default"));
  expect(updatePanelSettings).toHaveBeenLastCalledWith("drawer-session-popup", { serviceTier: "default" });

  await rerender({ panelSnapshot: { ...localDraft(), serviceTier: "priority" } });
  expect(result.current.serviceTierForView).toBe("fast");
  await rerender({ panelSnapshot: { ...localDraft(), panelId: "other-panel", serviceTier: "default" } });
  expect(result.current.serviceTierForView).toBe("default");
  await act(async () => result.current.selectServiceTier("fast"));
  expect(updatePanelSettings).toHaveBeenLastCalledWith("other-panel", { serviceTier: "fast" });

  await rerender({ panelSnapshot: { ...localDraft(), backendId: "claude", modelRef: "sonnet", serviceTier: "ultrafast" } });
  expect(result.current.speedSelectionSupported).toBe(false);
  expect(result.current.serviceTierForView).toBe("default");
  expect(result.current.serviceTierOptions).toEqual([{ value: "default", label: "Standard" }]);
  const writes = updatePanelSettings.mock.calls.length;
  await act(async () => result.current.selectServiceTier("ultrafast"));
  expect(updatePanelSettings).toHaveBeenCalledTimes(writes);
});
