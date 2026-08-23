import { useMemo } from "react";
import { Alert } from "react-native";
import type { ModelOption } from "../contexts/AppSettingsContext";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import { effortOptionsForModel, isBackendChangeBlocked } from "../modelOptions";
import { modelRefLabelForDisplay, normalizeModelRef } from "../utils/settingsParsers";

export function useChatModelSelection(options: {
  isPanelRuntimeView: boolean;
  panelId: string;
  panelSnapshot: PanelRuntimeSnapshot;
  conversationMessageCount: number;
  llmBackend: string;
  modelRef: string;
  reasoningEffort: string;
  selectedModelLabel: string;
  modelOptions: readonly ModelOption[];
  selectModel: (selectionKey: string) => void;
  updatePanelSettings: (
    panelId: string,
    settings: { backendId?: string; modelRef?: string; reasoningEffort?: string },
  ) => void;
  closePicker: (value: null) => void;
}) {
  const modelRefForView = options.isPanelRuntimeView
    ? (String(options.panelSnapshot.modelRef || "").trim() || options.modelRef)
    : options.modelRef;
  const normalizedModelRefForView = normalizeModelRef(modelRefForView) || modelRefForView;
  const backendIdForView = String(
    (options.isPanelRuntimeView ? options.panelSnapshot.backendId : options.llmBackend) || "codex",
  ).trim() || "codex";
  const modelOptionForView = options.modelOptions.find(
    (option) => option.backendId === backendIdForView && option.modelId === normalizedModelRefForView,
  );
  const selectableModelOptions = useMemo(
    () => options.modelOptions.filter((option) => option.selectable !== false),
    [options.modelOptions],
  );
  const scheduleModelOptions = useMemo(() => selectableModelOptions
    .filter((option) => option.supportsScheduling === true)
    .map((option) => ({ value: option.modelId, label: option.label })), [selectableModelOptions]);
  const reasoningEffortForView = options.isPanelRuntimeView
    ? (String(options.panelSnapshot.reasoningEffort || "").trim() || options.reasoningEffort)
    : options.reasoningEffort;
  const selectedModelLabelForView = useMemo(() => {
    if (!options.isPanelRuntimeView) {
      return options.selectedModelLabel || modelRefLabelForDisplay(
        modelRefForView, options.modelOptions, backendIdForView,
      );
    }
    return modelRefLabelForDisplay(modelRefForView, options.modelOptions, backendIdForView);
  }, [backendIdForView, modelRefForView, options.isPanelRuntimeView, options.modelOptions, options.selectedModelLabel]);
  const selectModelForView = (selectionKey: string) => {
    if (options.isPanelRuntimeView) {
      const next = options.modelOptions.find((item) => item.selectionKey === selectionKey);
      if (!next) return;
      const currentBackendId = String(options.panelSnapshot.backendId || "codex").trim() || "codex";
      const sessionLocked = options.conversationMessageCount > 0 || (
        Boolean(String(options.panelSnapshot.selectedSessionId || "").trim())
        && options.panelSnapshot.sessionMaterialized !== false
      );
      if (isBackendChangeBlocked({
        sessionLocked,
        currentBackendId,
        nextBackendId: next.backendId,
      })) {
        Alert.alert("新規チャットが必要です", "チャットの途中でAgent Providerは変更できません。");
        options.closePicker(null);
        return;
      }
      options.updatePanelSettings(options.panelId, { backendId: next.backendId, modelRef: next.modelId });
    } else {
      options.selectModel(selectionKey);
    }
    options.closePicker(null);
  };

  return {
    backendIdForView,
    normalizedModelRefForView,
    modelOptionForView,
    selectableModelOptions,
    reasoningEffortSupportedForView: modelOptionForView?.supportsReasoningEffort === true,
    effortOptionsForView: effortOptionsForModel(modelOptionForView),
    scheduleModelOptions,
    scheduleModelRef: modelOptionForView?.supportsScheduling === true
      ? normalizedModelRefForView
      : scheduleModelOptions[0]?.value || "",
    reasoningEffortForView,
    selectedModelLabelForView,
    selectModelForView,
  };
}
