import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import { Alert } from "react-native";
import { parseSttProvider, type SttProvider } from "../../stt/sttConfig";
import {
  normalizeRecordingTuning,
  parseRecordingQualityPreset,
  parseTtsProvider,
  parseTtsSpeed,
  type RecordingQualityPreset,
  type RecordingTuning,
  type SelectedVoiceIdByProvider,
  type TtsProvider,
} from "../utils/audioConfig";
import { parseOptionalSessionId } from "../utils/llmSession";
import { parseCodexApprovalPolicy, parseLlmDirectory, parseModelRef, parseReasoningEffort, type CodexApprovalPolicy, type ReasoningEffort } from "../utils/settingsParsers";
import { parseToolAutoApprovalMap } from "../utils/tooling";
import { suggestRunnerUrlFromCodexWsUrl } from "../utils/urlResolvers";
import type { LlmBackend, ToolAutoApprovalMap } from "../types/appTypes";
import type { RegisteredDirectoryEntry } from "../components/AppDrawer";

const LEGACY_DEFAULT_CODEX_WS_URL = "ws://127.0.0.1:8788/codex-ws";
const DEFAULT_RUNNER_WS_URL = "ws://127.0.0.1:8788/runner-ws";

type UseAppSettingsPersistenceControllerArgs = {
  settingsLoaded: boolean;
  setSettingsLoaded: Dispatch<SetStateAction<boolean>>;
  settingsFileName: string;
  modelOptions: readonly { value: string }[];
  defaultModelRef: string;
  defaultReasoningEffort: ReasoningEffort;
  defaultRecordingQualityPreset: RecordingQualityPreset;
  defaultSelectedVoiceIds: SelectedVoiceIdByProvider;
  runnerUrl: string;
  runnerToken: string;
  llmBackend: LlmBackend;
  llmDirectory: string;
  registeredDirectories: RegisteredDirectoryEntry[];
  sessionTitleOverridesById: Record<string, string>;
  sessionMarkerColorsById: Record<string, RegisteredDirectoryEntry["markerColor"]>;
  expandedDirectoryIds: string[];
  selectedLlmSessionId: string;
  codexWsUrl: string;
  codexWsToken: string;
  modelRef: string;
  reasoningEffort: ReasoningEffort;
  codexApprovalPolicy: CodexApprovalPolicy;
  ttsProvider: TtsProvider;
  sttProvider: SttProvider;
  recordingQualityPreset: RecordingQualityPreset;
  recordingTuning: RecordingTuning;
  faceTrackingEnabled: boolean;
  ttsSpeed: number;
  selectedVoiceIdByProvider: SelectedVoiceIdByProvider;
  autoBargeInEnabled: boolean;
  autoSpeakerPriorityEnabled: boolean;
  autoTranscribeOnStop: boolean;
  autoReplyAfterStt: boolean;
  autoSpeakAfterReply: boolean;
  toolAutoApprovalMap: ToolAutoApprovalMap;
  llmToolLogCompact: boolean;
  setRunnerUrl: Dispatch<SetStateAction<string>>;
  setRunnerToken: Dispatch<SetStateAction<string>>;
  setLlmDirectory: Dispatch<SetStateAction<string>>;
  setRegisteredDirectories: Dispatch<SetStateAction<RegisteredDirectoryEntry[]>>;
  setSessionTitleOverridesById: Dispatch<SetStateAction<Record<string, string>>>;
  setSessionMarkerColorsById: Dispatch<SetStateAction<Record<string, RegisteredDirectoryEntry["markerColor"]>>>;
  setExpandedDirectoryIds: Dispatch<SetStateAction<string[]>>;
  setSelectedLlmSessionId: Dispatch<SetStateAction<string>>;
  selectedLlmSessionIdRef: MutableRefObject<string>;
  llmConversationSessionIdRef: MutableRefObject<string>;
  rememberKnownCodexThreadId: (sessionIdRaw: unknown) => void;
  setCodexWsUrl: Dispatch<SetStateAction<string>>;
  setCodexWsToken: Dispatch<SetStateAction<string>>;
  setModelRef: Dispatch<SetStateAction<string>>;
  setReasoningEffort: Dispatch<SetStateAction<ReasoningEffort>>;
  setCodexApprovalPolicy: Dispatch<SetStateAction<CodexApprovalPolicy>>;
  setSelectedVoiceIdByProvider: Dispatch<SetStateAction<SelectedVoiceIdByProvider>>;
  setTtsProvider: Dispatch<SetStateAction<TtsProvider>>;
  setSttProvider: Dispatch<SetStateAction<SttProvider>>;
  setRecordingQualityPreset: Dispatch<SetStateAction<RecordingQualityPreset>>;
  setRecordingTuning: Dispatch<SetStateAction<RecordingTuning>>;
  setFaceTrackingEnabledWithRef: (enabled: boolean) => void;
  setTtsSpeedWithSync: (value: number) => void;
  setToolAutoApprovalMap: Dispatch<SetStateAction<ToolAutoApprovalMap>>;
  setLlmToolLogCompact: Dispatch<SetStateAction<boolean>>;
  setAutoTranscribeOnStop: Dispatch<SetStateAction<boolean>>;
  setAutoBargeInEnabled: Dispatch<SetStateAction<boolean>>;
  setAutoSpeakerPriorityEnabled: Dispatch<SetStateAction<boolean>>;
  setAutoReplyAfterStt: Dispatch<SetStateAction<boolean>>;
  setAutoSpeakAfterReply: Dispatch<SetStateAction<boolean>>;
  parseRegisteredDirectories: (raw: unknown) => RegisteredDirectoryEntry[];
  parseSessionTitleOverrides: (raw: unknown) => Record<string, string>;
  parseSessionMarkerColors: (raw: unknown) => Record<string, RegisteredDirectoryEntry["markerColor"]>;
  parseExpandedDirectoryIds: (raw: unknown, directories: RegisteredDirectoryEntry[]) => string[];
};

export function useAppSettingsPersistenceController({
  settingsLoaded,
  setSettingsLoaded,
  settingsFileName,
  modelOptions,
  defaultModelRef,
  defaultReasoningEffort,
  defaultRecordingQualityPreset,
  defaultSelectedVoiceIds,
  runnerUrl,
  runnerToken,
  llmBackend,
  llmDirectory,
  registeredDirectories,
  sessionTitleOverridesById,
  sessionMarkerColorsById,
  expandedDirectoryIds,
  selectedLlmSessionId,
  codexWsUrl,
  codexWsToken,
  modelRef,
  reasoningEffort,
  codexApprovalPolicy,
  ttsProvider,
  sttProvider,
  recordingQualityPreset,
  recordingTuning,
  faceTrackingEnabled,
  ttsSpeed,
  selectedVoiceIdByProvider,
  autoBargeInEnabled,
  autoSpeakerPriorityEnabled,
  autoTranscribeOnStop,
  autoReplyAfterStt,
  autoSpeakAfterReply,
  toolAutoApprovalMap,
  llmToolLogCompact,
  setRunnerUrl,
  setRunnerToken,
  setLlmDirectory,
  setRegisteredDirectories,
  setSessionTitleOverridesById,
  setSessionMarkerColorsById,
  setExpandedDirectoryIds,
  setSelectedLlmSessionId,
  selectedLlmSessionIdRef,
  llmConversationSessionIdRef,
  rememberKnownCodexThreadId,
  setCodexWsUrl,
  setCodexWsToken,
  setModelRef,
  setReasoningEffort,
  setCodexApprovalPolicy,
  setSelectedVoiceIdByProvider,
  setTtsProvider,
  setSttProvider,
  setRecordingQualityPreset,
  setRecordingTuning,
  setFaceTrackingEnabledWithRef,
  setTtsSpeedWithSync,
  setToolAutoApprovalMap,
  setLlmToolLogCompact,
  setAutoTranscribeOnStop,
  setAutoBargeInEnabled,
  setAutoSpeakerPriorityEnabled,
  setAutoReplyAfterStt,
  setAutoSpeakAfterReply,
  parseRegisteredDirectories,
  parseSessionTitleOverrides,
  parseSessionMarkerColors,
  parseExpandedDirectoryIds,
}: UseAppSettingsPersistenceControllerArgs) {
  const loadedSettingsPathRef = useRef<string | null>(null);

  const settingsPath = useCallback(() => {
    const baseDir = FileSystem.documentDirectory;
    if (!baseDir) return "";
    return `${baseDir}${settingsFileName}`;
  }, [settingsFileName]);

  const buildPersistedSettingsPayload = useCallback(() => {
    return {
      runnerUrl,
      runnerToken,
      llmBackend,
      llmDirectory,
      registeredDirectories,
      sessionTitleOverridesById,
      sessionMarkerColorsById,
      directoryUiState: {
        expandedDirectoryIds,
      },
      selectedLlmSessionId,
      codexWsUrl,
      codexWsToken,
      modelRef,
      reasoningEffort,
      codexApprovalPolicy,
      ttsProvider,
      sttProvider,
      recordingQualityPreset,
      recordingTuning: normalizeRecordingTuning(recordingTuning, recordingQualityPreset),
      recordingHighQuality: recordingQualityPreset === "high",
      faceTrackingEnabled,
      ttsSpeed,
      selectedVoiceId: selectedVoiceIdByProvider.elevenlabs,
      selectedVoiceIdByProvider,
      autoBargeInEnabled,
      autoSpeakerPriorityEnabled,
      autoTranscribeOnStop,
      autoReplyAfterStt,
      autoSpeakAfterReply,
      toolAutoApprovalMap,
      llmToolLogCompact,
    };
  }, [
    autoBargeInEnabled,
    autoReplyAfterStt,
    autoSpeakerPriorityEnabled,
    autoSpeakAfterReply,
    autoTranscribeOnStop,
    codexApprovalPolicy,
    codexWsToken,
    codexWsUrl,
    expandedDirectoryIds,
    faceTrackingEnabled,
    llmBackend,
    llmDirectory,
    llmToolLogCompact,
    modelRef,
    reasoningEffort,
    recordingQualityPreset,
    recordingTuning,
    registeredDirectories,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    runnerToken,
    runnerUrl,
    selectedLlmSessionId,
    selectedVoiceIdByProvider,
    sttProvider,
    toolAutoApprovalMap,
    ttsProvider,
    ttsSpeed,
  ]);

  const applyPersistedSettings = useCallback((parsed: Record<string, unknown>) => {
    let savedRunnerUrl = String(parsed.runnerUrl || "").trim();
    let savedRunnerToken = String(parsed.runnerToken || "").trim();
    const savedCodexWsUrlRaw = String(parsed.codexWsUrl || "").trim();
    const savedCodexWsUrl = savedCodexWsUrlRaw === LEGACY_DEFAULT_CODEX_WS_URL
      ? DEFAULT_RUNNER_WS_URL
      : savedCodexWsUrlRaw;
    const savedCodexWsToken = String(parsed.codexWsToken || "").trim();
    if (!savedRunnerUrl && savedCodexWsUrl) {
      savedRunnerUrl = suggestRunnerUrlFromCodexWsUrl(savedCodexWsUrl);
    }
    if (!savedRunnerToken && savedCodexWsUrl) {
      try {
        const wsUrl = new URL(savedCodexWsUrl);
        savedRunnerToken = String(wsUrl.searchParams.get("token") || "").trim();
      } catch {}
    }

    const savedVoiceIds = {
      ...defaultSelectedVoiceIds,
      elevenlabs: String(parsed.selectedVoiceId || "").trim(),
    };
    const selectedVoiceIdByProviderRaw = parsed.selectedVoiceIdByProvider;
    if (
      selectedVoiceIdByProviderRaw &&
      typeof selectedVoiceIdByProviderRaw === "object" &&
      !Array.isArray(selectedVoiceIdByProviderRaw)
    ) {
      const voiceIds = selectedVoiceIdByProviderRaw as Record<string, unknown>;
      savedVoiceIds.elevenlabs = String(voiceIds.elevenlabs || savedVoiceIds.elevenlabs).trim();
      savedVoiceIds.google = String(voiceIds.google || "").trim();
      savedVoiceIds.aivisspeech = String(voiceIds.aivisspeech || "").trim();
    }

    if (savedRunnerUrl) {
      setRunnerUrl(savedRunnerUrl);
    }
    setRunnerToken(savedRunnerToken);
    setLlmDirectory(parseLlmDirectory(parsed.llmDirectory));
    const parsedRegisteredDirectories = parseRegisteredDirectories(parsed.registeredDirectories);
    setRegisteredDirectories(parsedRegisteredDirectories);
    setSessionTitleOverridesById(parseSessionTitleOverrides(parsed.sessionTitleOverridesById));
    setSessionMarkerColorsById(parseSessionMarkerColors(parsed.sessionMarkerColorsById));
    const directoryUiStateRaw = parsed.directoryUiState;
    const directoryUiState = directoryUiStateRaw &&
      typeof directoryUiStateRaw === "object" &&
      !Array.isArray(directoryUiStateRaw)
      ? directoryUiStateRaw as Record<string, unknown>
      : {};
    setExpandedDirectoryIds(parseExpandedDirectoryIds(
      directoryUiState.expandedDirectoryIds,
      parsedRegisteredDirectories
    ));

    const loadedSelectedSessionId = parseOptionalSessionId(parsed.selectedLlmSessionId);
    if (loadedSelectedSessionId) {
      setSelectedLlmSessionId(loadedSelectedSessionId);
      selectedLlmSessionIdRef.current = loadedSelectedSessionId;
      llmConversationSessionIdRef.current = loadedSelectedSessionId;
      rememberKnownCodexThreadId(loadedSelectedSessionId);
    } else {
      setSelectedLlmSessionId("");
      selectedLlmSessionIdRef.current = "";
      llmConversationSessionIdRef.current = "";
    }

    if (savedCodexWsUrl) {
      setCodexWsUrl(savedCodexWsUrl);
    }
    setCodexWsToken(savedCodexWsToken);
    setModelRef(parseModelRef(parsed.modelRef, modelOptions, defaultModelRef));
    setReasoningEffort(parseReasoningEffort(parsed.reasoningEffort, defaultReasoningEffort));
    setCodexApprovalPolicy(parseCodexApprovalPolicy(parsed.codexApprovalPolicy));
    setSelectedVoiceIdByProvider(savedVoiceIds);
    setTtsProvider(parseTtsProvider(parsed.ttsProvider));
    setSttProvider(parseSttProvider(parsed.sttProvider));
    const loadedRecordingPreset = (() => {
      if (typeof parsed.recordingQualityPreset === "string") {
        return parseRecordingQualityPreset(parsed.recordingQualityPreset);
      }
      if (typeof parsed.recordingHighQuality === "boolean") {
        return parsed.recordingHighQuality ? "high" : "low";
      }
      return defaultRecordingQualityPreset;
    })();
    setRecordingQualityPreset(loadedRecordingPreset);
    setRecordingTuning(normalizeRecordingTuning(parsed.recordingTuning, loadedRecordingPreset));
    if (typeof parsed.faceTrackingEnabled === "boolean") {
      setFaceTrackingEnabledWithRef(parsed.faceTrackingEnabled);
    }
    setTtsSpeedWithSync(parseTtsSpeed(parsed.ttsSpeed));
    setToolAutoApprovalMap(parseToolAutoApprovalMap(parsed.toolAutoApprovalMap));
    if (typeof parsed.llmToolLogCompact === "boolean") {
      setLlmToolLogCompact(parsed.llmToolLogCompact);
    }
    if (typeof parsed.autoTranscribeOnStop === "boolean") {
      setAutoTranscribeOnStop(parsed.autoTranscribeOnStop);
    }
    if (typeof parsed.autoBargeInEnabled === "boolean") {
      setAutoBargeInEnabled(parsed.autoBargeInEnabled);
    }
    if (typeof parsed.autoSpeakerPriorityEnabled === "boolean") {
      setAutoSpeakerPriorityEnabled(parsed.autoSpeakerPriorityEnabled);
    }
    if (typeof parsed.autoReplyAfterStt === "boolean") {
      setAutoReplyAfterStt(parsed.autoReplyAfterStt);
    }
    if (typeof parsed.autoSpeakAfterReply === "boolean") {
      setAutoSpeakAfterReply(parsed.autoSpeakAfterReply);
    }
  }, [
    defaultModelRef,
    defaultReasoningEffort,
    defaultRecordingQualityPreset,
    defaultSelectedVoiceIds,
    llmConversationSessionIdRef,
    modelOptions,
    parseExpandedDirectoryIds,
    parseRegisteredDirectories,
    parseSessionMarkerColors,
    parseSessionTitleOverrides,
    rememberKnownCodexThreadId,
    selectedLlmSessionIdRef,
    setAutoBargeInEnabled,
    setAutoReplyAfterStt,
    setAutoSpeakerPriorityEnabled,
    setAutoSpeakAfterReply,
    setAutoTranscribeOnStop,
    setCodexApprovalPolicy,
    setCodexWsToken,
    setCodexWsUrl,
    setExpandedDirectoryIds,
    setFaceTrackingEnabledWithRef,
    setLlmDirectory,
    setLlmToolLogCompact,
    setModelRef,
    setReasoningEffort,
    setRecordingQualityPreset,
    setRecordingTuning,
    setRegisteredDirectories,
    setRunnerToken,
    setRunnerUrl,
    setSelectedLlmSessionId,
    setSelectedVoiceIdByProvider,
    setSessionMarkerColorsById,
    setSessionTitleOverridesById,
    setSttProvider,
    setToolAutoApprovalMap,
    setTtsProvider,
    setTtsSpeedWithSync,
  ]);

  const logSettingsJson = useCallback(async () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      appDefaultSettings: buildPersistedSettingsPayload(),
    };
    const settingsJson = JSON.stringify(payload, null, 2);
    console.log("[settings/export]", settingsJson);
    try {
      await Clipboard.setStringAsync(settingsJson);
      console.log("[settings/export] copied to clipboard");
    } catch (error) {
      console.warn("[settings/export] failed to copy to clipboard", error);
    }
  }, [buildPersistedSettingsPayload]);

  const importSettingsJson = useCallback(async () => {
    try {
      const raw = (await Clipboard.getStringAsync()).trim();
      if (!raw) {
        throw new Error("クリップボードに設定JSONがありません。");
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("設定JSONの形式が正しくありません。");
      }
      const envelope = parsed as Record<string, unknown>;
      const settingsRaw = envelope.appDefaultSettings ?? envelope;
      if (!settingsRaw || typeof settingsRaw !== "object" || Array.isArray(settingsRaw)) {
        throw new Error("appDefaultSettings が見つかりません。");
      }
      const imported = settingsRaw as Record<string, unknown>;

      Alert.alert(
        "設定をインポート",
        "接続先、個人パス、セッション設定、自動許可ルールを含むすべての端末設定を復元します。",
        [
          { text: "キャンセル", style: "cancel" },
          {
            text: "インポート",
            onPress: () => {
              applyPersistedSettings(imported);
              Alert.alert("インポート完了", "すべての端末設定を反映しました。");
            },
          },
        ]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Alert.alert("インポート失敗", message || "設定JSONを読み込めませんでした。");
    }
  }, [applyPersistedSettings]);

  useEffect(() => {
    async function loadSettings() {
      const path = settingsPath();
      if (!path) {
        setSettingsLoaded(true);
        return;
      }
      if (loadedSettingsPathRef.current === path) return;
      loadedSettingsPathRef.current = path;

      try {
        const info = await FileSystem.getInfoAsync(path);
        if (!info.exists) {
          setSettingsLoaded(true);
          return;
        }
        const raw = await FileSystem.readAsStringAsync(path);
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("設定ファイルの形式が正しくありません。");
        }
        applyPersistedSettings(parsed as Record<string, unknown>);
      } catch {}
      setSettingsLoaded(true);
    }

    void loadSettings();
  }, [
    applyPersistedSettings,
    setSettingsLoaded,
    settingsPath,
  ]);

  useEffect(() => {
    if (!settingsLoaded) return;

    const path = settingsPath();
    if (!path) return;

    const timer = setTimeout(() => {
      void FileSystem.writeAsStringAsync(path, JSON.stringify(buildPersistedSettingsPayload()));
    }, 250);

    return () => clearTimeout(timer);
  }, [buildPersistedSettingsPayload, settingsLoaded, settingsPath]);

  return {
    importSettingsJson,
    logSettingsJson,
  };
}
