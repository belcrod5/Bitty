import { act, renderHook } from "@testing-library/react-native";
import { useState } from "react";
import { useAppSettingsPersistenceController } from "./useAppSettingsPersistenceController";
import {
  mutatePersistedSettings,
  readPersistedSettings,
} from "../utils/persistedSettingsFile";
import {
  loadSecureRunnerCredentials,
  saveSecureRunnerCredentials,
} from "../utils/secureRunnerCredentials";

jest.mock("expo-av", () => ({
  Audio: {
    RecordingOptionsPresets: {
      HIGH_QUALITY: { android: {}, ios: {}, web: {} },
    },
  },
}));

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///documents/",
}));

jest.mock("../utils/persistedSettingsFile", () => ({
  LOCATION_BACKGROUND_FIELDS: [],
  mutatePersistedSettings: jest.fn(),
  readPersistedSettings: jest.fn(),
}));

jest.mock("../utils/secureRunnerCredentials", () => ({
  loadSecureRunnerCredentials: jest.fn(),
  saveSecureRunnerCredentials: jest.fn(),
}));

const mockReadPersistedSettings = jest.mocked(readPersistedSettings);
const mockMutatePersistedSettings = jest.mocked(mutatePersistedSettings);
const mockLoadSecureRunnerCredentials = jest.mocked(loadSecureRunnerCredentials);
const mockSaveSecureRunnerCredentials = jest.mocked(saveSecureRunnerCredentials);
const setter = jest.fn();

function createArgs() {
  return {
    settingsFileName: "bitty-settings.json",
    modelOptions: [{ value: "default-model" }],
    defaultModelRef: "default-model",
    defaultReasoningEffort: "medium",
    defaultRecordingQualityPreset: "high",
    defaultSelectedVoiceIds: { elevenlabs: "", google: "", aivisspeech: "" },
    runnerUrl: "http://default-runner",
    runnerToken: "",
    cloudflareAccessClientId: "",
    cloudflareAccessClientSecret: "",
    cloudflareRunnerUrl: "",
    cloudflareRunnerWsUrl: "",
    localRunnerUrl: "",
    localRunnerWsUrl: "",
    llmBackend: "codex",
    llmDirectory: "",
    registeredDirectories: [],
    sessionTitleOverridesById: {},
    sessionMarkerColorsById: {},
    expandedDirectoryIds: [],
    selectedLlmSessionId: "",
    codexWsUrl: "",
    codexWsToken: "",
    modelRef: "default-model",
    reasoningEffort: "medium",
    codexApprovalPolicy: "on-request",
    ttsProvider: "elevenlabs",
    sttProvider: "runner",
    recordingQualityPreset: "high",
    recordingTuning: {},
    faceTrackingEnabled: false,
    ttsSpeed: 1,
    selectedVoiceIdByProvider: { elevenlabs: "", google: "", aivisspeech: "" },
    autoBargeInEnabled: false,
    autoSpeakerPriorityEnabled: false,
    autoTranscribeOnStop: false,
    autoReplyAfterStt: false,
    autoSpeakAfterReply: false,
    faceIdRequiredForApproval: false,
    llmToolLogCompact: false,
    setRunnerUrl: setter,
    setRunnerToken: setter,
    setCloudflareAccessClientId: setter,
    setCloudflareAccessClientSecret: setter,
    setCloudflareRunnerUrl: setter,
    setCloudflareRunnerWsUrl: setter,
    setLocalRunnerUrl: setter,
    setLocalRunnerWsUrl: setter,
    setLlmDirectory: setter,
    setRegisteredDirectories: setter,
    setSessionTitleOverridesById: setter,
    setSessionMarkerColorsById: setter,
    setExpandedDirectoryIds: setter,
    setSelectedLlmSessionId: setter,
    selectedLlmSessionIdRef: { current: "" },
    llmConversationSessionIdRef: { current: "" },
    rememberKnownCodexThreadId: jest.fn(),
    setCodexWsUrl: setter,
    setCodexWsToken: setter,
    setModelRef: setter,
    setReasoningEffort: setter,
    setCodexApprovalPolicy: setter,
    setSelectedVoiceIdByProvider: setter,
    setTtsProvider: setter,
    setSttProvider: setter,
    setRecordingQualityPreset: setter,
    setRecordingTuning: setter,
    setFaceTrackingEnabledWithRef: setter,
    setTtsSpeedWithSync: setter,
    setLlmToolLogCompact: setter,
    setAutoTranscribeOnStop: setter,
    setAutoBargeInEnabled: setter,
    setAutoSpeakerPriorityEnabled: setter,
    setAutoReplyAfterStt: setter,
    setAutoSpeakAfterReply: setter,
    setFaceIdRequiredForApproval: setter,
    parseRegisteredDirectories: () => [],
    parseSessionTitleOverrides: () => ({}),
    parseSessionMarkerColors: () => ({}),
    parseExpandedDirectoryIds: () => [],
  } as unknown as Omit<
    Parameters<typeof useAppSettingsPersistenceController>[0],
    "settingsLoaded" | "setSettingsLoaded"
  >;
}

async function renderPersistenceController() {
  const args = createArgs();
  await renderHook(() => {
    const [settingsLoaded, setSettingsLoaded] = useState(false);
    return useAppSettingsPersistenceController({
      ...args,
      settingsLoaded,
      setSettingsLoaded,
    });
  });
  await act(async () => {});
  await act(async () => {
    jest.advanceTimersByTime(250);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  mockReadPersistedSettings.mockResolvedValue({});
  mockLoadSecureRunnerCredentials.mockResolvedValue({
    runnerToken: "saved-token",
    cloudflareAccessClientId: "",
    cloudflareAccessClientSecret: "",
  });
  mockMutatePersistedSettings.mockResolvedValue();
  mockSaveSecureRunnerCredentials.mockResolvedValue();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("does not overwrite settings after their initial read fails", async () => {
  mockReadPersistedSettings.mockRejectedValue(new Error("settings read failed"));

  await renderPersistenceController();

  expect(mockMutatePersistedSettings).not.toHaveBeenCalled();
  expect(mockSaveSecureRunnerCredentials).toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledWith(
    "[settings] failed to read persisted settings",
    expect.any(Error)
  );
});

test("does not delete credentials after their initial read fails", async () => {
  mockLoadSecureRunnerCredentials.mockRejectedValue(new Error("secure store read failed"));

  await renderPersistenceController();

  expect(mockMutatePersistedSettings).toHaveBeenCalled();
  expect(mockSaveSecureRunnerCredentials).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledWith(
    "[settings] failed to read secure credentials",
    expect.any(Error)
  );
});
