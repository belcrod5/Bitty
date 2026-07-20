import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { RunnerPairingResult } from "../contexts/AppSettingsContext";
import type { RegisteredDirectoryEntry } from "../components/AppDrawer";
import type { AppScreen } from "../types/appTypes";
import { TTS_SPEED_STEP, type SelectedVoiceIdByProvider, type TtsProvider } from "../utils/audioConfig";
import type { CodexApprovalPolicy, ReasoningEffort } from "../utils/settingsParsers";
import { parseCloudflareRunnerPairingPayload } from "../utils/cloudflareAccess";
import { saveSecureRunnerCredentials } from "../utils/secureRunnerCredentials";

type UseAppContextActionsArgs = {
  drawerOpen: boolean;
  runnerToken: string;
  defaultLlmDirectory: string;
  directoryExplorerParentPath: string;
  directoryExplorerRootPath: string;
  directoryExplorerPath: string;
  selectedRegisteredDirectory: RegisteredDirectoryEntry | null;
  latestAssistantYouTubeVideoIds: string[];
  ttsSpeed: number;
  ttsProvider: TtsProvider;
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;
  setActiveScreen: Dispatch<SetStateAction<AppScreen>>;
  setRunnerUrl: Dispatch<SetStateAction<string>>;
  selectLlmDirectory: (value: string) => void;
  setCodexWsUrl: Dispatch<SetStateAction<string>>;
  setCodexWsToken: Dispatch<SetStateAction<string>>;
  setRunnerToken: Dispatch<SetStateAction<string>>;
  setCloudflareAccessClientId: Dispatch<SetStateAction<string>>;
  setCloudflareAccessClientSecret: Dispatch<SetStateAction<string>>;
  setCloudflareRunnerUrl: Dispatch<SetStateAction<string>>;
  setCloudflareRunnerWsUrl: Dispatch<SetStateAction<string>>;
  setLocalRunnerUrl: Dispatch<SetStateAction<string>>;
  setLocalRunnerWsUrl: Dispatch<SetStateAction<string>>;
  setCodexApprovalPolicy: Dispatch<SetStateAction<CodexApprovalPolicy>>;
  setModelSelectOpen: Dispatch<SetStateAction<boolean>>;
  setThinkSelectOpen: Dispatch<SetStateAction<boolean>>;
  setModelRef: Dispatch<SetStateAction<string>>;
  setReasoningEffort: Dispatch<SetStateAction<ReasoningEffort>>;
  testHardcodedCodexWsConnection: () => Promise<void>;
  testHardcodedCodexWsHandshakeOnly: () => Promise<void>;
  runCodexWsDiagnosticsAndUpload: () => Promise<void>;
  runRunner8788ReachabilitySuite: () => Promise<void>;
  runCodexWsE2eTurnAndUpload: () => Promise<void>;
  loadLlmRuntimeLimits: () => Promise<void>;
  updateLlmToolMaxRounds: () => Promise<void>;
  setLlmToolMaxRoundsInput: Dispatch<SetStateAction<string>>;
  setLlmToolLogCompact: Dispatch<SetStateAction<boolean>>;
  setTranscript: Dispatch<SetStateAction<string>>;
  setSystemPrompt: Dispatch<SetStateAction<string>>;
  sendReplyRequest: () => Promise<void>;
  sendReplyTranscript: () => Promise<void>;
  reloadActiveSession: (source?: "mini_board" | "drawer" | "session_modal") => void;
  loadDirectoryExplorer: (path: string) => Promise<void>;
  upsertRegisteredDirectory: (pathRaw: unknown) => void;
  setDirectorySelectOpen: Dispatch<SetStateAction<boolean>>;
  resumeWaitingApprovalForActiveSession: () => void;
  renameRegisteredDirectory: (directoryId: string, nextDisplayNameRaw: unknown) => void;
  setSelectedSessionTitleOverride: (nextTitleRaw: unknown) => void;
  setSelectedSessionMarkerColor: (nextMarkerColorRaw: unknown) => void;
  removeRegisteredDirectory: (directoryId: string) => void;
  openYouTubeVideo: (
    videoId: string,
    source: string,
    options?: { queueVideoIds?: string[]; queueIndex?: number }
  ) => void;
  synthesizeSpeech: () => Promise<void>;
  stopTtsPlayback: () => Promise<void>;
  startDirectNativeStt: () => Promise<void>;
  stopDirectNativeStt: () => Promise<void>;
  startAutoRecordingMode: (panelId?: string) => Promise<void>;
  stopAutoRecordingMode: () => Promise<void>;
  sendAutoClientLogsNow: () => Promise<void>;
  transcribeRecording: () => Promise<void>;
  startAudioLabProbe: () => Promise<void>;
  stopAudioLabProbe: (reason?: string) => Promise<void>;
  startAudioLabPlaybackOnly: (reason?: string) => Promise<void>;
  stopAudioLabPlaybackOnly: (reason?: string) => Promise<void>;
  sendAudioLabLogsNow: () => Promise<void>;
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
  runnerToken,
  defaultLlmDirectory,
  directoryExplorerParentPath,
  directoryExplorerRootPath,
  directoryExplorerPath,
  selectedRegisteredDirectory,
  latestAssistantYouTubeVideoIds,
  ttsSpeed,
  ttsProvider,
  setDrawerOpen,
  setActiveScreen,
  setRunnerUrl,
  selectLlmDirectory,
  setCodexWsUrl,
  setCodexWsToken,
  setRunnerToken,
  setCloudflareAccessClientId,
  setCloudflareAccessClientSecret,
  setCloudflareRunnerUrl,
  setCloudflareRunnerWsUrl,
  setLocalRunnerUrl,
  setLocalRunnerWsUrl,
  setCodexApprovalPolicy,
  setModelSelectOpen,
  setThinkSelectOpen,
  setModelRef,
  setReasoningEffort,
  testHardcodedCodexWsConnection,
  testHardcodedCodexWsHandshakeOnly,
  runCodexWsDiagnosticsAndUpload,
  runRunner8788ReachabilitySuite,
  runCodexWsE2eTurnAndUpload,
  loadLlmRuntimeLimits,
  updateLlmToolMaxRounds,
  setLlmToolMaxRoundsInput,
  setLlmToolLogCompact,
  setTranscript,
  setSystemPrompt,
  sendReplyRequest,
  sendReplyTranscript,
  reloadActiveSession,
  loadDirectoryExplorer,
  upsertRegisteredDirectory,
  setDirectorySelectOpen,
  resumeWaitingApprovalForActiveSession,
  renameRegisteredDirectory,
  setSelectedSessionTitleOverride,
  setSelectedSessionMarkerColor,
  removeRegisteredDirectory,
  openYouTubeVideo,
  synthesizeSpeech,
  stopTtsPlayback,
  startDirectNativeStt,
  stopDirectNativeStt,
  startAutoRecordingMode,
  stopAutoRecordingMode,
  sendAutoClientLogsNow,
  transcribeRecording,
  startAudioLabProbe,
  stopAudioLabProbe,
  startAudioLabPlaybackOnly,
  stopAudioLabPlaybackOnly,
  sendAudioLabLogsNow,
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
  const openDebugScreen = useCallback(() => {
    setActiveScreen("debug");
  }, [setActiveScreen]);
  const openAudioLabScreen = useCallback(() => {
    setActiveScreen("audio_lab");
  }, [setActiveScreen]);
  const openMiniBoardScreen = useCallback(() => {
    setActiveScreen("mini_board");
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
  const changeCodexWsUrl = useCallback((value: string) => {
    setCodexWsUrl(value);
  }, [setCodexWsUrl]);
  const changeCodexWsToken = useCallback((value: string) => {
    setCodexWsToken(value);
  }, [setCodexWsToken]);
  const changeRunnerToken = useCallback((value: string) => {
    setRunnerToken(value);
  }, [setRunnerToken]);
  const clearCloudflareAccessCredentials = useCallback(async () => {
    await saveSecureRunnerCredentials({
      runnerToken,
      cloudflareAccessClientId: "",
      cloudflareAccessClientSecret: "",
    });
    setCloudflareAccessClientId("");
    setCloudflareAccessClientSecret("");
  }, [runnerToken, setCloudflareAccessClientId, setCloudflareAccessClientSecret]);
  const applyCloudflareRunnerPairing = useCallback(async (payload: string): Promise<RunnerPairingResult> => {
    const pairing = parseCloudflareRunnerPairingPayload(payload);
    await saveSecureRunnerCredentials({
      runnerToken: pairing.runnerToken,
      cloudflareAccessClientId: pairing.cloudflareAccessClientId,
      cloudflareAccessClientSecret: pairing.cloudflareAccessClientSecret,
    });
    setRunnerUrl(pairing.runnerUrl);
    setRunnerToken(pairing.runnerToken);
    setCodexWsToken(pairing.runnerToken);
    setCloudflareAccessClientId(pairing.cloudflareAccessClientId);
    setCloudflareAccessClientSecret(pairing.cloudflareAccessClientSecret);
    setCloudflareRunnerUrl(pairing.runnerUrl);
    setCloudflareRunnerWsUrl(pairing.runnerWsUrl);
    setLocalRunnerUrl(pairing.localRunnerUrl);
    setLocalRunnerWsUrl(pairing.localRunnerWsUrl);
    if (pairing.runnerWsUrl) {
      setCodexWsUrl(pairing.runnerWsUrl);
    }
    return {
      runnerUrl: pairing.runnerUrl,
      runnerWsUrl: pairing.runnerWsUrl,
      localRunnerUrl: pairing.localRunnerUrl,
      localRunnerWsUrl: pairing.localRunnerWsUrl,
    };
  }, [
    setCloudflareAccessClientId,
    setCloudflareAccessClientSecret,
    setCloudflareRunnerUrl,
    setCloudflareRunnerWsUrl,
    setCodexWsToken,
    setCodexWsUrl,
    setLocalRunnerUrl,
    setLocalRunnerWsUrl,
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
    setThinkSelectOpen(true);
  }, [setThinkSelectOpen]);
  const selectModel = useCallback((nextModel: string) => {
    setModelRef(nextModel);
    setModelSelectOpen(false);
    if (drawerOpen) {
      requestAnimationFrame(() => {
        setThinkSelectOpen(true);
      });
    }
  }, [drawerOpen, setModelRef, setModelSelectOpen, setThinkSelectOpen]);
  const selectThinkOption = useCallback((option: ReasoningEffort) => {
    setReasoningEffort(option);
    setThinkSelectOpen(false);
  }, [setReasoningEffort, setThinkSelectOpen]);
  const probeCurrentWsFromContext = useCallback(() => {
    void testHardcodedCodexWsConnection();
  }, [testHardcodedCodexWsConnection]);
  const probeHandshakeOnlyFromContext = useCallback(() => {
    void testHardcodedCodexWsHandshakeOnly();
  }, [testHardcodedCodexWsHandshakeOnly]);
  const runWsDiagFromContext = useCallback(() => {
    void runCodexWsDiagnosticsAndUpload();
  }, [runCodexWsDiagnosticsAndUpload]);
  const runAuxServerSuiteFromContext = useCallback(() => {
    void runRunner8788ReachabilitySuite();
  }, [runRunner8788ReachabilitySuite]);
  const runWsE2eFromContext = useCallback(() => {
    void runCodexWsE2eTurnAndUpload();
  }, [runCodexWsE2eTurnAndUpload]);
  const loadLlmRuntimeLimitsFromContext = useCallback(() => {
    void loadLlmRuntimeLimits();
  }, [loadLlmRuntimeLimits]);
  const updateLlmToolMaxRoundsFromContext = useCallback(() => {
    void updateLlmToolMaxRounds();
  }, [updateLlmToolMaxRounds]);
  const changeLlmToolMaxRoundsInputFromContext = useCallback((value: string) => {
    setLlmToolMaxRoundsInput(value);
  }, [setLlmToolMaxRoundsInput]);
  const toggleLlmToolLogCompactFromContext = useCallback((value: boolean) => {
    setLlmToolLogCompact(value);
  }, [setLlmToolLogCompact]);
  const changeTranscript = useCallback((value: string) => {
    setTranscript(value);
  }, [setTranscript]);
  const changeSystemPrompt = useCallback((value: string) => {
    setSystemPrompt(value);
  }, [setSystemPrompt]);
  const sendReplyRequestFromContext = useCallback(() => {
    void sendReplyRequest();
  }, [sendReplyRequest]);
  const sendReplyTranscriptFromContext = useCallback(() => {
    void sendReplyTranscript();
  }, [sendReplyTranscript]);
  const reloadSelectedSessionFromContext = useCallback(() => {
    reloadActiveSession("mini_board");
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
  const openLatestYouTubeVideoFromDebugContext = useCallback((videoId: string, queueIndex: number) => {
    openYouTubeVideo(videoId, "__latest__", {
      queueVideoIds: latestAssistantYouTubeVideoIds,
      queueIndex,
    });
  }, [openYouTubeVideo, latestAssistantYouTubeVideoIds]);
  const synthesizeSpeechFromDebugContext = useCallback(() => {
    void synthesizeSpeech();
  }, [synthesizeSpeech]);
  const stopTtsPlaybackFromDebugContext = useCallback(() => {
    void stopTtsPlayback();
  }, [stopTtsPlayback]);
  const startDirectNativeSttFromDebugSpeechContext = useCallback(() => {
    void startDirectNativeStt();
  }, [startDirectNativeStt]);
  const stopDirectNativeSttFromDebugSpeechContext = useCallback(() => {
    void stopDirectNativeStt();
  }, [stopDirectNativeStt]);
  const startAutoRecordingModeFromDebugSpeechContext = useCallback(() => {
    void startAutoRecordingMode();
  }, [startAutoRecordingMode]);
  const stopAutoRecordingModeFromDebugSpeechContext = useCallback(() => {
    void stopAutoRecordingMode();
  }, [stopAutoRecordingMode]);
  const sendAutoClientLogsFromDebugSpeechContext = useCallback(() => {
    void sendAutoClientLogsNow();
  }, [sendAutoClientLogsNow]);
  const transcribeRecordingFromDebugSpeechContext = useCallback(() => {
    void transcribeRecording();
  }, [transcribeRecording]);
  const startAudioLabProbeFromContext = useCallback(() => {
    void startAudioLabProbe();
  }, [startAudioLabProbe]);
  const stopAudioLabProbeFromContext = useCallback(() => {
    void stopAudioLabProbe("manual_stop");
  }, [stopAudioLabProbe]);
  const startAudioLabPlaybackOnlyFromContext = useCallback(() => {
    void startAudioLabPlaybackOnly("manual_resume");
  }, [startAudioLabPlaybackOnly]);
  const stopAudioLabPlaybackOnlyFromContext = useCallback(() => {
    void stopAudioLabPlaybackOnly("manual_interrupt");
  }, [stopAudioLabPlaybackOnly]);
  const sendAudioLabLogsFromContext = useCallback(() => {
    void sendAudioLabLogsNow();
  }, [sendAudioLabLogsNow]);
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
    openDebugScreen,
    openAudioLabScreen,
    openMiniBoardScreen,
    openCloudflareTunnelMonitorScreen,
    openSkiaBoardScreen,
    changeRunnerUrl,
    changeLlmDirectory,
    changeCodexWsUrl,
    changeCodexWsToken,
    changeRunnerToken,
    clearCloudflareAccessCredentials,
    applyCloudflareRunnerPairing,
    selectCodexApprovalPolicy,
    openModelSelect,
    openThinkSelect,
    selectModel,
    selectThinkOption,
    probeCurrentWsFromContext,
    probeHandshakeOnlyFromContext,
    runWsDiagFromContext,
    runAuxServerSuiteFromContext,
    runWsE2eFromContext,
    loadLlmRuntimeLimitsFromContext,
    updateLlmToolMaxRoundsFromContext,
    changeLlmToolMaxRoundsInputFromContext,
    toggleLlmToolLogCompactFromContext,
    changeTranscript,
    changeSystemPrompt,
    sendReplyRequestFromContext,
    sendReplyTranscriptFromContext,
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
    openLatestYouTubeVideoFromDebugContext,
    synthesizeSpeechFromDebugContext,
    stopTtsPlaybackFromDebugContext,
    startDirectNativeSttFromDebugSpeechContext,
    stopDirectNativeSttFromDebugSpeechContext,
    startAutoRecordingModeFromDebugSpeechContext,
    stopAutoRecordingModeFromDebugSpeechContext,
    sendAutoClientLogsFromDebugSpeechContext,
    transcribeRecordingFromDebugSpeechContext,
    startAudioLabProbeFromContext,
    stopAudioLabProbeFromContext,
    startAudioLabPlaybackOnlyFromContext,
    stopAudioLabPlaybackOnlyFromContext,
    sendAudioLabLogsFromContext,
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
