import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as Clipboard from "../clipboard";
import * as FileSystem from "expo-file-system/legacy";
import { Alert, AppState } from "react-native";
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
import type { LlmBackend } from "../types/appTypes";
import type { RegisteredDirectoryEntry } from "../types/directorySessions";
import {
  loadSecureRunnerCredentials,
  saveSecureRunnerCredentials,
  type SecureRunnerCredentials,
} from "../utils/secureRunnerCredentials";
import {
  mutatePersistedSettings,
  PRESERVED_SETTINGS_FIELDS,
  readPersistedSettings,
} from "../utils/persistedSettingsFile";

type UseAppSettingsPersistenceControllerArgs = {
  settingsLoaded: boolean;
  setSettingsLoaded: Dispatch<SetStateAction<boolean>>;
  settingsFileName: string;
  modelOptions: readonly { modelId: string; backendId?: string }[];
  defaultModelRef: string;
  defaultReasoningEffort: ReasoningEffort;
  defaultRecordingQualityPreset: RecordingQualityPreset;
  defaultSelectedVoiceIds: SelectedVoiceIdByProvider;
  runnerUrl: string;
  runnerToken: string;
  cloudflareAccessClientId: string;
  cloudflareAccessClientSecret: string;
  cloudflareRunnerUrl: string;
  localRunnerUrl: string;
  llmBackend: LlmBackend;
  llmDirectory: string;
  registeredDirectories: RegisteredDirectoryEntry[];
  sessionTitleOverridesById: Record<string, string>;
  sessionMarkerColorsById: Record<string, RegisteredDirectoryEntry["markerColor"]>;
  expandedDirectoryIds: string[];
  selectedLlmSessionId: string;
  selectedLlmSessionMaterialized: boolean;
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
  faceIdRequiredForApproval: boolean;
  setRunnerUrl: Dispatch<SetStateAction<string>>;
  setRunnerToken: Dispatch<SetStateAction<string>>;
  setCloudflareAccessClientId: Dispatch<SetStateAction<string>>;
  setCloudflareAccessClientSecret: Dispatch<SetStateAction<string>>;
  setCloudflareRunnerUrl: Dispatch<SetStateAction<string>>;
  setLocalRunnerUrl: Dispatch<SetStateAction<string>>;
  setLlmBackend: Dispatch<SetStateAction<LlmBackend>>;
  setLlmDirectory: Dispatch<SetStateAction<string>>;
  setRegisteredDirectories: Dispatch<SetStateAction<RegisteredDirectoryEntry[]>>;
  setSessionTitleOverridesById: Dispatch<SetStateAction<Record<string, string>>>;
  setSessionMarkerColorsById: Dispatch<SetStateAction<Record<string, RegisteredDirectoryEntry["markerColor"]>>>;
  setExpandedDirectoryIds: Dispatch<SetStateAction<string[]>>;
  setSelectedLlmSessionId: Dispatch<SetStateAction<string>>;
  setSelectedLlmSessionMaterialized: Dispatch<SetStateAction<boolean>>;
  selectedLlmSessionIdRef: MutableRefObject<string>;
  llmConversationSessionIdRef: MutableRefObject<string>;
  rememberKnownCodexThreadId: (sessionIdRaw: unknown) => void;
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
  setAutoTranscribeOnStop: Dispatch<SetStateAction<boolean>>;
  setAutoBargeInEnabled: Dispatch<SetStateAction<boolean>>;
  setAutoSpeakerPriorityEnabled: Dispatch<SetStateAction<boolean>>;
  setAutoReplyAfterStt: Dispatch<SetStateAction<boolean>>;
  setAutoSpeakAfterReply: Dispatch<SetStateAction<boolean>>;
  setFaceIdRequiredForApproval: Dispatch<SetStateAction<boolean>>;
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
  cloudflareAccessClientId,
  cloudflareAccessClientSecret,
  cloudflareRunnerUrl,
  localRunnerUrl,
  llmBackend,
  llmDirectory,
  registeredDirectories,
  sessionTitleOverridesById,
  sessionMarkerColorsById,
  expandedDirectoryIds,
  selectedLlmSessionId,
  selectedLlmSessionMaterialized,
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
  faceIdRequiredForApproval,
  setRunnerUrl,
  setRunnerToken,
  setCloudflareAccessClientId,
  setCloudflareAccessClientSecret,
  setCloudflareRunnerUrl,
  setLocalRunnerUrl,
  setLlmBackend,
  setLlmDirectory,
  setRegisteredDirectories,
  setSessionTitleOverridesById,
  setSessionMarkerColorsById,
  setExpandedDirectoryIds,
  setSelectedLlmSessionId,
  setSelectedLlmSessionMaterialized,
  selectedLlmSessionIdRef,
  llmConversationSessionIdRef,
  rememberKnownCodexThreadId,
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
  setAutoTranscribeOnStop,
  setAutoBargeInEnabled,
  setAutoSpeakerPriorityEnabled,
  setAutoReplyAfterStt,
  setAutoSpeakAfterReply,
  setFaceIdRequiredForApproval,
  parseRegisteredDirectories,
  parseSessionTitleOverrides,
  parseSessionMarkerColors,
  parseExpandedDirectoryIds,
}: UseAppSettingsPersistenceControllerArgs) {
  const loadedSettingsPathRef = useRef<string | null>(null);
  const writablePersistenceRef = useRef({
    settings: false,
    secureCredentials: false,
  });
  const credentialsRecoveryInFlightRef = useRef(false);
  // Bumped when a recovery unlocks the credential store, so the autosave effect
  // re-runs with fresh values instead of persisting a snapshot captured before the
  // recovery.
  const [persistenceRetryTick, setPersistenceRetryTick] = useState(0);

  // keepExistingValues: on a retry the user may have re-typed a credential during the
  // degraded session; the stored value must not clobber that input.
  const applySecureCredentials = useCallback((
    secureCredentials: SecureRunnerCredentials,
    { keepExistingValues }: { keepExistingValues: boolean }
  ) => {
    const applyValue = (setter: Dispatch<SetStateAction<string>>, value: string) => {
      if (!value) return;
      setter((current) => keepExistingValues && String(current || "").trim() ? current : value);
    };
    applyValue(setRunnerToken, secureCredentials.runnerToken);
    applyValue(setCloudflareAccessClientId, secureCredentials.cloudflareAccessClientId);
    applyValue(setCloudflareAccessClientSecret, secureCredentials.cloudflareAccessClientSecret);
  }, [setCloudflareAccessClientId, setCloudflareAccessClientSecret, setRunnerToken]);

  const settingsPath = useCallback(() => {
    const baseDir = FileSystem.documentDirectory;
    if (!baseDir) return "";
    return `${baseDir}${settingsFileName}`;
  }, [settingsFileName]);

  const buildPersistedSettingsPayload = useCallback(() => {
    return {
      runnerUrl,
      cloudflareRunnerUrl,
      localRunnerUrl,
      llmBackend,
      llmDirectory,
      registeredDirectories,
      sessionTitleOverridesById,
      sessionMarkerColorsById,
      directoryUiState: {
        expandedDirectoryIds,
      },
      selectedLlmSessionId,
      selectedLlmSessionMaterialized,
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
      faceIdRequiredForApproval,
    };
  }, [
    autoBargeInEnabled,
    autoReplyAfterStt,
    autoSpeakerPriorityEnabled,
    autoSpeakAfterReply,
    autoTranscribeOnStop,
    faceIdRequiredForApproval,
    cloudflareRunnerUrl,
    codexApprovalPolicy,
    expandedDirectoryIds,
    faceTrackingEnabled,
    llmBackend,
    llmDirectory,
    localRunnerUrl,
    modelRef,
    reasoningEffort,
    recordingQualityPreset,
    recordingTuning,
    registeredDirectories,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    runnerUrl,
    cloudflareAccessClientId,
    cloudflareAccessClientSecret,
    selectedLlmSessionId,
    selectedLlmSessionMaterialized,
    selectedVoiceIdByProvider,
    sttProvider,
    ttsProvider,
    ttsSpeed,
  ]);

  const applyPersistedSettings = useCallback((parsed: Record<string, unknown>) => {
    const savedRunnerUrl = String(parsed.runnerUrl || "").trim();
    const savedRunnerToken = String(parsed.runnerToken || "").trim();
    const legacyCloudflareAccessClientId = String(parsed.cloudflareAccessClientId || "").trim();
    const legacyCloudflareAccessClientSecret = String(parsed.cloudflareAccessClientSecret || "").trim();
    const savedCloudflareRunnerUrl = String(parsed.cloudflareRunnerUrl || parsed.tunnelRunnerUrl || "").trim();
    const savedLocalRunnerUrl = String(parsed.localRunnerUrl || "").trim();

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
    if (savedCloudflareRunnerUrl) {
      setCloudflareRunnerUrl(savedCloudflareRunnerUrl);
    } else if (savedRunnerUrl.startsWith("https://")) {
      setCloudflareRunnerUrl(savedRunnerUrl);
    }
    if (savedLocalRunnerUrl) {
      setLocalRunnerUrl(savedLocalRunnerUrl);
    } else if (savedRunnerUrl.startsWith("http://") && savedRunnerUrl.includes(".local")) {
      setLocalRunnerUrl(savedRunnerUrl);
    }
    // The runner token lives in SecureStore, not in the settings JSON, so the
    // parsed value is normally empty (only legacy exports carried it). Never
    // overwrite a SecureStore-provided token with that empty string.
    if (savedRunnerToken) {
      setRunnerToken(savedRunnerToken);
    }
    if (legacyCloudflareAccessClientId) {
      setCloudflareAccessClientId(legacyCloudflareAccessClientId);
    }
    if (legacyCloudflareAccessClientSecret) {
      setCloudflareAccessClientSecret(legacyCloudflareAccessClientSecret);
    }
    const savedBackend = String(parsed.llmBackend || "").trim();
    setLlmBackend(savedBackend && savedBackend !== "codex_app_server" ? savedBackend : "codex");
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
      const loadedSessionMaterialized = Object.prototype.hasOwnProperty.call(parsed, "selectedLlmSessionMaterialized")
        ? parsed.selectedLlmSessionMaterialized === true
        : true;
      setSelectedLlmSessionId(loadedSelectedSessionId);
      setSelectedLlmSessionMaterialized(loadedSessionMaterialized);
      selectedLlmSessionIdRef.current = loadedSelectedSessionId;
      llmConversationSessionIdRef.current = loadedSelectedSessionId;
      if (loadedSessionMaterialized) rememberKnownCodexThreadId(loadedSelectedSessionId);
    } else {
      setSelectedLlmSessionId("");
      setSelectedLlmSessionMaterialized(false);
      selectedLlmSessionIdRef.current = "";
      llmConversationSessionIdRef.current = "";
    }

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
    if (typeof parsed.faceIdRequiredForApproval === "boolean") {
      setFaceIdRequiredForApproval(parsed.faceIdRequiredForApproval);
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
    setFaceIdRequiredForApproval,
    setCodexApprovalPolicy,
    setCloudflareAccessClientId,
    setCloudflareAccessClientSecret,
    setCloudflareRunnerUrl,
    setExpandedDirectoryIds,
    setFaceTrackingEnabledWithRef,
    setLlmBackend,
    setLlmDirectory,
    setLocalRunnerUrl,
    setModelRef,
    setReasoningEffort,
    setRecordingQualityPreset,
    setRecordingTuning,
    setRegisteredDirectories,
    setRunnerToken,
    setRunnerUrl,
    setSelectedLlmSessionId,
    setSelectedLlmSessionMaterialized,
    setSelectedVoiceIdByProvider,
    setSessionMarkerColorsById,
    setSessionTitleOverridesById,
    setSttProvider,
    setTtsProvider,
    setTtsSpeedWithSync,
  ]);

  const exportSettingsJson = useCallback(async () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      appDefaultSettings: buildPersistedSettingsPayload(),
    };
    const settingsJson = JSON.stringify(payload, null, 2);
    try {
      await Clipboard.setStringAsync(settingsJson);
      Alert.alert("書き出し完了", "設定をクリップボードへコピーしました。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Alert.alert("書き出し失敗", message || "設定をコピーできませんでした。");
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
        "認証トークン、Cloudflare認証情報、保存済み承認ルールを除く端末設定を復元します。これらは移行先で再設定してください。",
        [
          { text: "キャンセル", style: "cancel" },
          {
            text: "インポート",
            onPress: () => {
              const importedSettings = { ...imported };
              for (const field of [
                "runnerToken",
                "cloudflareAccessClientId",
                "cloudflareAccessClientSecret",
                "toolAutoApprovalRules",
                "toolAutoApprovalMap",
              ]) {
                delete importedSettings[field];
              }
              applyPersistedSettings(importedSettings);
              Alert.alert("インポート完了", "移行対象の端末設定を反映しました。");
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
      if (loadedSettingsPathRef.current === path) return;
      loadedSettingsPathRef.current = path;

      const [settingsResult, credentialsResult] = await Promise.allSettled([
        path ? readPersistedSettings() : Promise.resolve(undefined),
        loadSecureRunnerCredentials(),
      ]);

      if (settingsResult.status === "fulfilled") {
        writablePersistenceRef.current.settings = Boolean(path);
        if (settingsResult.value) {
          applyPersistedSettings(settingsResult.value);
        }
      } else {
        console.warn("[settings] failed to read persisted settings", settingsResult.reason);
      }
      if (credentialsResult.status === "fulfilled") {
        writablePersistenceRef.current.secureCredentials = true;
        applySecureCredentials(credentialsResult.value, { keepExistingValues: false });
      } else {
        console.warn("[settings] failed to read secure credentials", credentialsResult.reason);
      }
      setSettingsLoaded(true);
    }

    void loadSettings();
  }, [
    applyPersistedSettings,
    applySecureCredentials,
    setSettingsLoaded,
    settingsPath,
  ]);

  // A credentials read that failed at launch (e.g. a background launch while the
  // device was locked could not read the keychain) is retried here, so the session
  // recovers instead of losing the credentials until the next cold start. Only the
  // credential store recovers mid-session: re-applying the settings file would
  // overwrite settings the user changed during the degraded session, so a failed
  // settings read keeps that store read-only until the next launch.
  const recoverSecureCredentials = useCallback(() => {
    if (writablePersistenceRef.current.secureCredentials) return;
    if (credentialsRecoveryInFlightRef.current) return;
    credentialsRecoveryInFlightRef.current = true;
    loadSecureRunnerCredentials()
      .then((credentials) => {
        writablePersistenceRef.current.secureCredentials = true;
        applySecureCredentials(credentials, { keepExistingValues: true });
        setPersistenceRetryTick((tick) => tick + 1);
      })
      .catch((error) => {
        console.warn("[settings] failed to read secure credentials", error);
      })
      .finally(() => {
        credentialsRecoveryInFlightRef.current = false;
      });
  }, [applySecureCredentials]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (!settingsLoaded) return;
      recoverSecureCredentials();
    });
    return () => subscription.remove();
  }, [recoverSecureCredentials, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded) return;

    const path = settingsPath();
    if (!path) return;

    // Snapshot the writable flags now: if a recovery unlocks the credential store
    // while this timer is pending, the timer must not save this render's stale
    // (possibly empty) values — the recovery tick re-runs the effect with fresh ones.
    const writableAtArm = { ...writablePersistenceRef.current };
    const timer = setTimeout(() => {
      if (writableAtArm.settings) {
        void mutatePersistedSettings((current) => {
          const next: Record<string, unknown> = buildPersistedSettingsPayload();
          for (const field of PRESERVED_SETTINGS_FIELDS) {
            if (field in current) next[field] = current[field];
          }
          return next;
        }).catch((error) => {
          console.warn("[settings] failed to save persisted settings", error);
        });
      }
      if (writableAtArm.secureCredentials) {
        void saveSecureRunnerCredentials({
          runnerToken,
          cloudflareAccessClientId,
          cloudflareAccessClientSecret,
        }).catch((error) => {
          console.warn("[settings] failed to save secure credentials", error);
        });
      } else {
        // A locked credential store gets one more chance here so a credential the
        // user just re-entered is not silently dropped: on recovery the tick re-runs
        // this effect, which then saves the current values through the branch above.
        recoverSecureCredentials();
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [
    buildPersistedSettingsPayload,
    cloudflareAccessClientId,
    cloudflareAccessClientSecret,
    persistenceRetryTick,
    recoverSecureCredentials,
    runnerToken,
    settingsLoaded,
    settingsPath,
  ]);

  return {
    importSettingsJson,
    exportSettingsJson,
  };
}
