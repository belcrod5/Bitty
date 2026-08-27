import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Alert } from "react-native";
import type { ModelOption, RunnerPairingResult } from "../contexts/AppSettingsContext";
import type { RegisteredDirectoryEntry } from "../types/directorySessions";
import type { AppScreen, LlmBackend } from "../types/appTypes";
import { TTS_SPEED_STEP, type SelectedVoiceIdByProvider, type TtsProvider } from "../utils/audioConfig";
import { isBackendChangeBlocked } from "../modelOptions";
import type { CodexApprovalPolicy, ReasoningEffort } from "../utils/settingsParsers";
import { parseCloudflareRunnerPairingPayload } from "../utils/cloudflareAccess";
import { saveSecureRunnerCredentials } from "../utils/secureRunnerCredentials";

type UseAppContextActionsArgs = {
  drawerOpen: boolean;
  defaultLlmDirectory: string;
  directoryExplorerParentPath: string;
  directoryExplorerRootPath: string;
  directoryExplorerPath: string;
  selectedRegisteredDirectory: RegisteredDirectoryEntry | null;
  ttsSpeed: number;
  ttsProvider: TtsProvider;
  llmBackend: LlmBackend;
  modelOptions: readonly ModelOption[];
  modelRef: string;
  modelBackendLocked: boolean;
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;
  setActiveScreen: Dispatch<SetStateAction<AppScreen>>;
  setRunnerUrl: Dispatch<SetStateAction<string>>;
  selectLlmDirectory: (value: string) => void;
  setRunnerToken: Dispatch<SetStateAction<string>>;
  setCloudflareAccessClientId: Dispatch<SetStateAction<string>>;
  setCloudflareAccessClientSecret: Dispatch<SetStateAction<string>>;
  setCloudflareRunnerUrl: Dispatch<SetStateAction<string>>;
  setLocalRunnerUrl: Dispatch<SetStateAction<string>>;
  setCodexApprovalPolicy: Dispatch<SetStateAction<CodexApprovalPolicy>>;
  setModelSelectOpen: Dispatch<SetStateAction<boolean>>;
  setThinkSelectOpen: Dispatch<SetStateAction<boolean>>;
  setModelRef: Dispatch<SetStateAction<string>>;
  setLlmBackend: Dispatch<SetStateAction<LlmBackend>>;
  setReasoningEffort: Dispatch<SetStateAction<ReasoningEffort>>;
  reloadActiveSession: (source?: "board" | "drawer" | "session_modal") => void;
  loadDirectoryExplorer: (path: string) => Promise<void>;
  upsertRegisteredDirectory: (pathRaw: unknown) => void;
  setDirectorySelectOpen: Dispatch<SetStateAction<boolean>>;
  resumeWaitingApprovalForActiveSession: () => void;
  renameRegisteredDirectory: (directoryId: string, nextDisplayNameRaw: unknown) => void;
  setSelectedSessionTitleOverride: (nextTitleRaw: unknown) => void;
  setSelectedSessionMarkerColor: (nextMarkerColorRaw: unknown) => void;
  removeRegisteredDirectory: (directoryId: string) => void;
  startDirectNativeStt: () => Promise<void>;
  stopDirectNativeStt: () => Promise<void>;
  startAutoRecordingMode: (panelId?: string) => Promise<void>;
  stopAutoRecordingMode: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelCodexTurnRequest: () => Promise<void>;
  stopWaveformPlayback: () => Promise<void>;
  refreshCodexCliStatusForWidget: (
    options?: { force?: boolean; source?: "auto" | "initial" | "resume" | "manual" | "slash" }
  ) => Promise<void>;
  refreshCodexAuthProfiles: (options?: { force?: boolean }) => Promise<void>;
  switchCodexAuthProfile: (authId: string) => Promise<boolean>;
  loadVoices: () => Promise<void>;
  setTtsSpeedWithSync: (value: number) => void;
  setSelectedVoiceIdByProvider: Dispatch<SetStateAction<SelectedVoiceIdByProvider>>;
};

export function useAppContextActions({
  drawerOpen,
  defaultLlmDirectory,
  directoryExplorerParentPath,
  directoryExplorerRootPath,
  directoryExplorerPath,
  selectedRegisteredDirectory,
  ttsSpeed,
  ttsProvider,
  llmBackend,
  modelOptions,
  modelRef,
  modelBackendLocked,
  setDrawerOpen,
  setActiveScreen,
  setRunnerUrl,
  selectLlmDirectory,
  setRunnerToken,
  setCloudflareAccessClientId,
  setCloudflareAccessClientSecret,
  setCloudflareRunnerUrl,
  setLocalRunnerUrl,
  setCodexApprovalPolicy,
  setModelSelectOpen,
  setThinkSelectOpen,
  setModelRef,
  setLlmBackend,
  setReasoningEffort,
  reloadActiveSession,
  loadDirectoryExplorer,
  upsertRegisteredDirectory,
  setDirectorySelectOpen,
  resumeWaitingApprovalForActiveSession,
  renameRegisteredDirectory,
  setSelectedSessionTitleOverride,
  setSelectedSessionMarkerColor,
  removeRegisteredDirectory,
  startDirectNativeStt,
  stopDirectNativeStt,
  startAutoRecordingMode,
  stopAutoRecordingMode,
  stopRecording,
  cancelCodexTurnRequest,
  stopWaveformPlayback,
  refreshCodexCliStatusForWidget,
  refreshCodexAuthProfiles,
  switchCodexAuthProfile,
  loadVoices,
  setTtsSpeedWithSync,
  setSelectedVoiceIdByProvider,
}: UseAppContextActionsArgs) {
  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
  }, [setDrawerOpen]);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, [setDrawerOpen]);
  const openSettingsScreen = useCallback(() => {
    setActiveScreen("settings");
  }, [setActiveScreen]);
  const openCloudflareTunnelMonitorScreen = useCallback(() => {
    setActiveScreen("cloudflare_tunnel_monitor");
  }, [setActiveScreen]);
  const openSkiaBoardScreen = useCallback(() => {
    setActiveScreen("skia_board");
  }, [setActiveScreen]);
  const changeRunnerUrl = useCallback((value: string) => {
    setRunnerUrl(value);
  }, [setRunnerUrl]);
  const changeLlmDirectory = useCallback((value: string) => {
    selectLlmDirectory(value);
  }, [selectLlmDirectory]);
  const changeRunnerToken = useCallback((value: string) => {
    setRunnerToken(value);
  }, [setRunnerToken]);
  const clearCloudflareAccessCredentials = useCallback(async () => {
    // Only the Cloudflare fields: passing runnerToken here would delete it whenever
    // this runs in a session whose credential load failed (state still empty).
    await saveSecureRunnerCredentials({
      cloudflareAccessClientId: "",
      cloudflareAccessClientSecret: "",
    });
    setCloudflareAccessClientId("");
    setCloudflareAccessClientSecret("");
  }, [setCloudflareAccessClientId, setCloudflareAccessClientSecret]);
  const applyCloudflareRunnerPairing = useCallback(async (payload: string): Promise<RunnerPairingResult> => {
    const pairing = parseCloudflareRunnerPairingPayload(payload);
    await saveSecureRunnerCredentials({
      runnerToken: pairing.runnerToken,
      cloudflareAccessClientId: pairing.cloudflareAccessClientId,
      cloudflareAccessClientSecret: pairing.cloudflareAccessClientSecret,
    });
    setRunnerUrl(pairing.runnerUrl);
    setRunnerToken(pairing.runnerToken);
    setCloudflareAccessClientId(pairing.cloudflareAccessClientId);
    setCloudflareAccessClientSecret(pairing.cloudflareAccessClientSecret);
    setCloudflareRunnerUrl(pairing.runnerUrl);
    setLocalRunnerUrl(pairing.localRunnerUrl);
    return {
      runnerUrl: pairing.runnerUrl,
      localRunnerUrl: pairing.localRunnerUrl,
    };
  }, [
    setCloudflareAccessClientId,
    setCloudflareAccessClientSecret,
    setCloudflareRunnerUrl,
    setLocalRunnerUrl,
    setRunnerToken,
    setRunnerUrl,
  ]);
  const selectCodexApprovalPolicy = useCallback((value: CodexApprovalPolicy) => {
    setCodexApprovalPolicy(value);
  }, [setCodexApprovalPolicy]);
  const openModelSelect = useCallback(() => {
    setModelSelectOpen(true);
  }, [setModelSelectOpen]);
  const openThinkSelect = useCallback(() => {
    const option = modelOptions.find((item) => item.backendId === llmBackend && item.modelId === modelRef);
    if (option?.supportsReasoningEffort) {
      setThinkSelectOpen(true);
    }
  }, [llmBackend, modelOptions, modelRef, setThinkSelectOpen]);
  const selectModel = useCallback((selectionKey: string) => {
    const option = modelOptions.find((item) => item.selectionKey === selectionKey);
    if (!option) return;
    const backendChangeBlocked = isBackendChangeBlocked({
      sessionLocked: modelBackendLocked,
      currentBackendId: llmBackend,
      nextBackendId: option.backendId,
    });
    if (backendChangeBlocked) {
      setModelSelectOpen(false);
      Alert.alert("新規チャットが必要です", "チャットの途中でAgent Providerは変更できません。");
      return;
    }
    setLlmBackend(option.backendId);
    setModelRef(option.modelId);
    setModelSelectOpen(false);
    if (drawerOpen && option.supportsReasoningEffort) {
      requestAnimationFrame(() => {
        setThinkSelectOpen(true);
      });
    }
  }, [drawerOpen, llmBackend, modelBackendLocked, modelOptions, setLlmBackend, setModelRef, setModelSelectOpen, setThinkSelectOpen]);
  const selectThinkOption = useCallback((option: ReasoningEffort) => {
    setReasoningEffort(option);
    setThinkSelectOpen(false);
  }, [setReasoningEffort, setThinkSelectOpen]);
  const reloadSelectedSessionFromContext = useCallback(() => {
    reloadActiveSession("board");
  }, [reloadActiveSession]);
  const goDirectoryParentFromContext = useCallback(() => {
    void loadDirectoryExplorer(directoryExplorerParentPath);
  }, [loadDirectoryExplorer, directoryExplorerParentPath]);
  const goDirectoryRootFromContext = useCallback(() => {
    void loadDirectoryExplorer(directoryExplorerRootPath || defaultLlmDirectory);
  }, [loadDirectoryExplorer, directoryExplorerRootPath, defaultLlmDirectory]);
  const selectCurrentDirectoryFromContext = useCallback(() => {
    upsertRegisteredDirectory(directoryExplorerPath || defaultLlmDirectory);
    setDirectorySelectOpen(false);
  }, [upsertRegisteredDirectory, directoryExplorerPath, defaultLlmDirectory, setDirectorySelectOpen]);
  const openDirectoryEntryFromContext = useCallback((path: string) => {
    void loadDirectoryExplorer(path);
  }, [loadDirectoryExplorer]);
  const resumeWaitingApprovalSessionFromContext = useCallback(() => {
    void resumeWaitingApprovalForActiveSession();
  }, [resumeWaitingApprovalForActiveSession]);
  const renameSelectedDirectoryFromContext = useCallback((nextDisplayName: string) => {
    if (!selectedRegisteredDirectory) return;
    renameRegisteredDirectory(selectedRegisteredDirectory.id, nextDisplayName);
  }, [selectedRegisteredDirectory, renameRegisteredDirectory]);
  const renameSelectedSessionTitleFromContext = useCallback((nextTitle: string) => {
    setSelectedSessionTitleOverride(nextTitle);
  }, [setSelectedSessionTitleOverride]);
  const selectSessionMarkerColorFromContext = useCallback((
    nextMarkerColor: RegisteredDirectoryEntry["markerColor"]
  ) => {
    setSelectedSessionMarkerColor(nextMarkerColor);
  }, [setSelectedSessionMarkerColor]);
  const removeSelectedDirectoryFromContext = useCallback(() => {
    if (!selectedRegisteredDirectory) return;
    removeRegisteredDirectory(selectedRegisteredDirectory.id);
  }, [selectedRegisteredDirectory, removeRegisteredDirectory]);
  const stopDirectNativeSttFromComposerContext = useCallback(() => {
    void stopDirectNativeStt();
  }, [stopDirectNativeStt]);
  const stopAutoRecordingModeFromComposerContext = useCallback(() => {
    void stopAutoRecordingMode();
  }, [stopAutoRecordingMode]);
  const stopRecordingFromComposerContext = useCallback(() => {
    void stopRecording();
  }, [stopRecording]);
  const stopLlmTurnFromComposerContext = useCallback(() => {
    void cancelCodexTurnRequest();
  }, [cancelCodexTurnRequest]);
  const startDirectNativeSttFromComposerContext = useCallback(() => {
    void startDirectNativeStt();
  }, [startDirectNativeStt]);
  const startAutoRecordingModeFromComposerContext = useCallback((panelId?: string) => {
    void startAutoRecordingMode(panelId);
  }, [startAutoRecordingMode]);
  const stopWaveformPlaybackFromVisualContext = useCallback(() => {
    void stopWaveformPlayback();
  }, [stopWaveformPlayback]);
  const refreshCodexCliStatusFromContext = useCallback(() => {
    void refreshCodexCliStatusForWidget({
      force: true,
      source: "manual",
    });
  }, [refreshCodexCliStatusForWidget]);
  const loadCodexAuthProfilesFromContext = useCallback(() => {
    void refreshCodexAuthProfiles({
      force: true,
    });
  }, [refreshCodexAuthProfiles]);
  const switchCodexAuthProfileFromContext = useCallback((authId: string) => (
    switchCodexAuthProfile(authId)
  ), [switchCodexAuthProfile]);
  const loadVoicesFromSettingsContext = useCallback(() => {
    void loadVoices();
  }, [loadVoices]);
  const decreaseTtsSpeedFromSettingsContext = useCallback(() => {
    setTtsSpeedWithSync(ttsSpeed - TTS_SPEED_STEP);
  }, [setTtsSpeedWithSync, ttsSpeed]);
  const increaseTtsSpeedFromSettingsContext = useCallback(() => {
    setTtsSpeedWithSync(ttsSpeed + TTS_SPEED_STEP);
  }, [setTtsSpeedWithSync, ttsSpeed]);
  const selectVoiceIdFromSettingsContext = useCallback((voiceId: string) => {
    setSelectedVoiceIdByProvider((prev) => ({
      ...prev,
      [ttsProvider]: voiceId,
    }));
  }, [setSelectedVoiceIdByProvider, ttsProvider]);
  return {
    openDrawer,
    closeDrawer,
    openSettingsScreen,
    openCloudflareTunnelMonitorScreen,
    openSkiaBoardScreen,
    changeRunnerUrl,
    changeLlmDirectory,
    changeRunnerToken,
    clearCloudflareAccessCredentials,
    applyCloudflareRunnerPairing,
    selectCodexApprovalPolicy,
    openModelSelect,
    openThinkSelect,
    selectModel,
    selectThinkOption,
    reloadSelectedSessionFromContext,
    goDirectoryParentFromContext,
    goDirectoryRootFromContext,
    selectCurrentDirectoryFromContext,
    openDirectoryEntryFromContext,
    resumeWaitingApprovalSessionFromContext,
    renameSelectedDirectoryFromContext,
    renameSelectedSessionTitleFromContext,
    selectSessionMarkerColorFromContext,
    removeSelectedDirectoryFromContext,
    stopDirectNativeSttFromComposerContext,
    stopAutoRecordingModeFromComposerContext,
    stopRecordingFromComposerContext,
    stopLlmTurnFromComposerContext,
    startDirectNativeSttFromComposerContext,
    startAutoRecordingModeFromComposerContext,
    stopWaveformPlaybackFromVisualContext,
    refreshCodexCliStatusFromContext,
    loadCodexAuthProfilesFromContext,
    switchCodexAuthProfileFromContext,
    loadVoicesFromSettingsContext,
    decreaseTtsSpeedFromSettingsContext,
    increaseTtsSpeedFromSettingsContext,
    selectVoiceIdFromSettingsContext,
  };
}
