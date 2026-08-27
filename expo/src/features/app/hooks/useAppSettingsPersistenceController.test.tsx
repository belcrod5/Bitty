import { act, renderHook } from "@testing-library/react-native";
import { useState } from "react";
import { Alert } from "react-native";
import * as Clipboard from "../clipboard";
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

jest.mock("../clipboard", () => ({
  getStringAsync: jest.fn(),
  setStringAsync: jest.fn(),
}));

jest.mock("../utils/persistedSettingsFile", () => ({
  PRESERVED_SETTINGS_FIELDS: ["skiaBoardState"],
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
const mockGetStringAsync = jest.mocked(Clipboard.getStringAsync);
const mockSetStringAsync = jest.mocked(Clipboard.setStringAsync);
const setter = jest.fn();

function createArgs() {
  return {
    settingsFileName: "bitty-settings.json",
    modelOptions: [{ modelId: "default-model", backendId: "codex" }],
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
    selectedLlmSessionMaterialized: false,
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
    setRunnerUrl: setter,
    setRunnerToken: setter,
    setCloudflareAccessClientId: setter,
    setCloudflareAccessClientSecret: setter,
    setCloudflareRunnerUrl: setter,
    setCloudflareRunnerWsUrl: setter,
    setLocalRunnerUrl: setter,
    setLocalRunnerWsUrl: setter,
    setLlmBackend: setter,
    setLlmDirectory: setter,
    setRegisteredDirectories: setter,
    setSessionTitleOverridesById: setter,
    setSessionMarkerColorsById: setter,
    setExpandedDirectoryIds: setter,
    setSelectedLlmSessionId: setter,
    setSelectedLlmSessionMaterialized: setter,
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

async function renderPersistenceController(
  overrides: Partial<ReturnType<typeof createArgs>> = {}
) {
  const args = { ...createArgs(), ...overrides };
  const hook = await renderHook(() => {
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
  return hook;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
  mockReadPersistedSettings.mockResolvedValue({});
  mockLoadSecureRunnerCredentials.mockResolvedValue({
    runnerToken: "saved-token",
    cloudflareAccessClientId: "",
    cloudflareAccessClientSecret: "",
  });
  mockMutatePersistedSettings.mockResolvedValue();
  mockSaveSecureRunnerCredentials.mockResolvedValue();
  mockGetStringAsync.mockResolvedValue("");
  mockSetStringAsync.mockResolvedValue(true);
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

test("autosave preserves externally owned fields instead of rebuilding them", async () => {
  await renderPersistenceController();

  expect(mockMutatePersistedSettings).toHaveBeenCalled();
  const mutate = mockMutatePersistedSettings.mock.calls[0][0];
  const boardState = { cards: [{ sessionId: "session-1", col: 0, row: 0 }] };
  const next = mutate({ skiaBoardState: boardState, runnerUrl: "stale-url" });

  // 所有者(Skiaボード等)が直接書いたフィールドは保持し、それ以外はReact stateから再構築。
  expect(next.skiaBoardState).toEqual(boardState);
  expect(next.runnerUrl).toBe("http://default-runner");
});

test("clipboard export excludes authentication credentials and approval rules", async () => {
  const hook = await renderPersistenceController({
    runnerToken: "runner-secret",
    codexWsToken: "different-codex-secret",
    cloudflareAccessClientId: "cloudflare-client-id",
    cloudflareAccessClientSecret: "cloudflare-client-secret",
  });

  await act(async () => {
    await hook.result.current.exportSettingsJson();
  });

  const exported = JSON.parse(mockSetStringAsync.mock.calls[0][0]);
  expect(exported.appDefaultSettings.runnerUrl).toBe("http://default-runner");
  expect(exported.appDefaultSettings).not.toHaveProperty("runnerToken");
  expect(exported.appDefaultSettings).not.toHaveProperty("codexWsToken");
  expect(exported.appDefaultSettings).not.toHaveProperty("cloudflareAccessClientId");
  expect(exported.appDefaultSettings).not.toHaveProperty("cloudflareAccessClientSecret");
  expect(exported.appDefaultSettings).not.toHaveProperty("toolAutoApprovalRules");
  expect(Alert.alert).toHaveBeenCalledWith("書き出し完了", "設定をクリップボードへコピーしました。");
});

test("import confirmation identifies settings that must be reconfigured", async () => {
  mockGetStringAsync.mockResolvedValue(JSON.stringify({
    appDefaultSettings: { runnerUrl: "https://migrated.example.com" },
  }));
  const hook = await renderPersistenceController();

  await act(async () => {
    await hook.result.current.importSettingsJson();
  });

  expect(Alert.alert).toHaveBeenCalledWith(
    "設定をインポート",
    expect.stringMatching(/認証トークン.*Cloudflare認証情報.*保存済み承認ルール.*移行先で再設定/),
    expect.any(Array)
  );
});

test("clipboard import never restores credentials from an old settings payload", async () => {
  mockLoadSecureRunnerCredentials.mockResolvedValue({
    runnerToken: "",
    cloudflareAccessClientId: "",
    cloudflareAccessClientSecret: "",
  });
  mockGetStringAsync.mockResolvedValue(JSON.stringify({
    appDefaultSettings: {
      runnerUrl: "https://migrated.example.com",
      runnerToken: "legacy-runner-secret",
      codexWsUrl: "wss://migrated.example.com/codex-ws?token=legacy-query-secret",
      codexWsToken: "legacy-codex-secret",
      cloudflareAccessClientId: "legacy-cloudflare-id",
      cloudflareAccessClientSecret: "legacy-cloudflare-secret",
      toolAutoApprovalRules: { "session:command": true },
      toolAutoApprovalMap: { "session:other-command": true },
    },
  }));
  const setRunnerToken = jest.fn();
  const setCodexWsToken = jest.fn();
  const setCloudflareAccessClientId = jest.fn();
  const setCloudflareAccessClientSecret = jest.fn();
  const setCodexWsUrl = jest.fn();
  const hook = await renderPersistenceController({
    setRunnerToken,
    setCodexWsToken,
    setCloudflareAccessClientId,
    setCloudflareAccessClientSecret,
    setCodexWsUrl,
  } as Parameters<typeof renderPersistenceController>[0]);

  await act(async () => {
    await hook.result.current.importSettingsJson();
  });
  const confirmation = jest.mocked(Alert.alert).mock.calls.find(([title]) => title === "設定をインポート");
  const importButton = (confirmation?.[2] as Array<{ text?: string; onPress?: () => void }> | undefined)
    ?.find(({ text }) => text === "インポート");

  setRunnerToken.mockClear();
  setCodexWsToken.mockClear();
  setCloudflareAccessClientId.mockClear();
  setCloudflareAccessClientSecret.mockClear();
  setCodexWsUrl.mockClear();
  await act(async () => {
    importButton?.onPress?.();
  });

  expect(setRunnerToken).not.toHaveBeenCalled();
  expect(setCodexWsToken).not.toHaveBeenCalled();
  expect(setCloudflareAccessClientId).not.toHaveBeenCalled();
  expect(setCloudflareAccessClientSecret).not.toHaveBeenCalled();
  expect(setCodexWsUrl).toHaveBeenCalledWith("wss://migrated.example.com/codex-ws");
});

test("keeps a persisted unsent local session as an unlocked draft", async () => {
  mockReadPersistedSettings.mockResolvedValue({
    selectedLlmSessionId: "local-session",
    selectedLlmSessionMaterialized: false,
  });
  const setSelectedLlmSessionMaterialized = jest.fn();
  const rememberKnownCodexThreadId = jest.fn();

  await renderPersistenceController({
    setSelectedLlmSessionMaterialized,
    rememberKnownCodexThreadId,
  } as Parameters<typeof renderPersistenceController>[0]);

  expect(setSelectedLlmSessionMaterialized).toHaveBeenCalledWith(false);
  expect(rememberKnownCodexThreadId).not.toHaveBeenCalled();
});

test("treats a legacy persisted session id as a materialized Codex session", async () => {
  mockReadPersistedSettings.mockResolvedValue({ selectedLlmSessionId: "legacy-session" });
  const setSelectedLlmSessionMaterialized = jest.fn();
  const rememberKnownCodexThreadId = jest.fn();

  await renderPersistenceController({
    setSelectedLlmSessionMaterialized,
    rememberKnownCodexThreadId,
  } as Parameters<typeof renderPersistenceController>[0]);

  expect(setSelectedLlmSessionMaterialized).toHaveBeenCalledWith(true);
  expect(rememberKnownCodexThreadId).toHaveBeenCalledWith("legacy-session");
});

test("preserves a persisted backend and model before its catalog is available", async () => {
  mockReadPersistedSettings.mockResolvedValue({
    llmBackend: "claude",
    modelRef: "sonnet",
  });
  const setLlmBackend = jest.fn();
  const setModelRef = jest.fn();

  await renderPersistenceController({
    modelOptions: [{ modelId: "default-model", backendId: "codex" }],
    setLlmBackend,
    setModelRef,
  } as Parameters<typeof renderPersistenceController>[0]);

  expect(setLlmBackend).toHaveBeenCalledWith("claude");
  expect(setModelRef).toHaveBeenCalledWith("sonnet");
});

test("local startup preserves legacy credentials before applying SecureStore values", async () => {
  mockReadPersistedSettings.mockResolvedValue({
    runnerToken: "legacy-runner-token",
    codexWsUrl: "wss://legacy.example.com/codex-ws?token=query-token&mode=relay",
    codexWsToken: "legacy-codex-token",
    cloudflareAccessClientId: "legacy-cloudflare-id",
    cloudflareAccessClientSecret: "legacy-cloudflare-secret",
  });
  mockLoadSecureRunnerCredentials.mockResolvedValue({
    runnerToken: "secure-runner-token",
    cloudflareAccessClientId: "secure-cloudflare-id",
    cloudflareAccessClientSecret: "secure-cloudflare-secret",
  });
  const setRunnerToken = jest.fn();
  const setCodexWsToken = jest.fn();
  const setCodexWsUrl = jest.fn();
  const setCloudflareAccessClientId = jest.fn();
  const setCloudflareAccessClientSecret = jest.fn();

  await renderPersistenceController({
    setRunnerToken,
    setCodexWsToken,
    setCodexWsUrl,
    setCloudflareAccessClientId,
    setCloudflareAccessClientSecret,
  } as Parameters<typeof renderPersistenceController>[0]);

  expect(setRunnerToken.mock.calls[0][0]).toBe("legacy-runner-token");
  expect(setCodexWsToken.mock.calls[0][0]).toBe("legacy-codex-token");
  expect(setCodexWsUrl).toHaveBeenCalledWith("wss://legacy.example.com/codex-ws?mode=relay");
  expect(setCloudflareAccessClientId.mock.calls[0][0]).toBe("legacy-cloudflare-id");
  expect(setCloudflareAccessClientSecret.mock.calls[0][0]).toBe("legacy-cloudflare-secret");

  const secureRunnerUpdate = setRunnerToken.mock.calls[1][0];
  const secureCodexUpdate = setCodexWsToken.mock.calls[1][0];
  const secureCloudflareIdUpdate = setCloudflareAccessClientId.mock.calls[1][0];
  const secureCloudflareSecretUpdate = setCloudflareAccessClientSecret.mock.calls[1][0];
  expect(secureRunnerUpdate("legacy-runner-token")).toBe("secure-runner-token");
  expect(secureCodexUpdate("legacy-codex-token")).toBe("legacy-codex-token");
  expect(secureCloudflareIdUpdate("legacy-cloudflare-id")).toBe("secure-cloudflare-id");
  expect(secureCloudflareSecretUpdate("legacy-cloudflare-secret")).toBe("secure-cloudflare-secret");
});

test("local startup recovers a legacy runner token from the Codex WebSocket URL", async () => {
  mockReadPersistedSettings.mockResolvedValue({
    codexWsUrl: "wss://legacy.example.com/codex-ws?mode=relay&token=query-token",
  });
  const setRunnerToken = jest.fn();
  const setCodexWsUrl = jest.fn();

  await renderPersistenceController({
    setRunnerToken,
    setCodexWsUrl,
  } as Parameters<typeof renderPersistenceController>[0]);

  expect(setRunnerToken.mock.calls[0][0]).toBe("query-token");
  expect(setCodexWsUrl).toHaveBeenCalledWith("wss://legacy.example.com/codex-ws?mode=relay");
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

test("retries a failed credentials read on the next save attempt and unlocks saving after recovery", async () => {
  mockLoadSecureRunnerCredentials.mockRejectedValueOnce(new Error("secure store read failed"));

  await renderPersistenceController();
  // The first autosave pass runs while the credential store is still locked.
  expect(mockSaveSecureRunnerCredentials).not.toHaveBeenCalled();

  // Its retry read succeeds (the mock only failed once); the recovery tick re-arms
  // the autosave timer, which may then persist credentials.
  await act(async () => {});
  await act(async () => {
    jest.advanceTimersByTime(250);
  });

  expect(mockLoadSecureRunnerCredentials).toHaveBeenCalledTimes(2);
  expect(mockSaveSecureRunnerCredentials).toHaveBeenCalled();
});

test("keeps retry reads from clobbering a credential the user re-entered", async () => {
  mockLoadSecureRunnerCredentials.mockRejectedValueOnce(new Error("secure store read failed"));
  const setRunnerToken = jest.fn();

  await renderPersistenceController({ setRunnerToken } as Parameters<typeof renderPersistenceController>[0]);
  await act(async () => {});

  // Recovery applies stored values through functional updates that keep an existing
  // non-empty value, so a token typed during the degraded session survives.
  const runnerTokenUpdates = setRunnerToken.mock.calls
    .map(([update]) => update)
    .filter((update) => typeof update === "function");
  expect(runnerTokenUpdates.length).toBeGreaterThan(0);
  for (const update of runnerTokenUpdates) {
    expect(update("user-typed-token")).toBe("user-typed-token");
    expect(update("")).toBe("saved-token");
  }
});
