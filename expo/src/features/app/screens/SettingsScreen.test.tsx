import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { SettingsScreen } from "./SettingsScreen";

jest.mock("../components/CodexAccountSettings", () => ({ CodexAccountSettings: () => null }));

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
const mockSetStringAsync = jest.fn(async (_text: string) => true);
jest.mock("../clipboard", () => ({
  setStringAsync: (text: string) => mockSetStringAsync(text),
}));
jest.mock("expo-av", () => ({
  Audio: {
    RecordingOptionsPresets: {
      HIGH_QUALITY: { android: {}, ios: {}, web: {} },
    },
  },
}));

const mockOpenSkiaBoardScreen = jest.fn();
const mockOpenDrawer = jest.fn();
const mockChangeCloudflareRunnerUrl = jest.fn();
const mockChangeLocalRunnerUrl = jest.fn();
const mockToggleAutoReplyAfterStt = jest.fn();
const mockExportSettingsJson = jest.fn();
const mockSelectTtsProvider = jest.fn();
const mockSelectCodexApprovalPolicy = jest.fn();
const mockSelectModel = jest.fn();
const mockSelectThinkOption = jest.fn();
const mockSelectSttProvider = jest.fn();
const mockApplyRecordingQualityPreset = jest.fn();
const mockLoadVoices = jest.fn();
const mockSelectVoiceId = jest.fn();
const mockSaveRunnerToken = jest.fn(async (_token: string) => undefined);

const mockSettings = {
  runnerUrl: "https://runner.example.com",
  cloudflareRunnerUrl: "https://runner.example.com",
  localRunnerUrl: "http://mac.local:8788",
  llmDirectory: "/work/bitty",
  llmBackend: "codex",
  modelRef: "gpt-5.5",
  runnerToken: "runner-secret",
  codexApprovalPolicy: "on-request",
  selectedModelLabel: "GPT-5.5",
  reasoningEffort: "high",
  modelOptions: [
    {
      selectionKey: "codex::gpt-5.5",
      label: "GPT-5.5",
      modelId: "gpt-5.5",
      backendId: "codex",
      supportsReasoningEffort: true,
    },
  ],
  thinkOptions: ["low", "medium", "high"],
  faceIdRequiredForApproval: true,
  ttsProvider: "aivisspeech",
  sttProvider: "runner",
  voicesLoading: false,
  filteredVoices: [{ voiceId: "voice-a", name: "Voice A" }],
  ttsSpeedInput: "1.2",
  ttsSpeed: 1.2,
  voiceFilter: "",
  selectedVoiceId: "",
  recordingQualityPreset: "high",
  autoTranscribeOnStop: true,
  autoReplyAfterStt: false,
  autoBargeInEnabled: false,
  autoSpeakerPriorityEnabled: true,
  autoSpeakAfterReply: true,
  toolAutoApprovalRuleCount: 2,
  changeCloudflareRunnerUrl: mockChangeCloudflareRunnerUrl,
  changeLocalRunnerUrl: mockChangeLocalRunnerUrl,
  changeLlmDirectory: jest.fn(),
  saveRunnerToken: mockSaveRunnerToken,
  selectCodexApprovalPolicy: mockSelectCodexApprovalPolicy,
  openModelSelect: jest.fn(),
  openThinkSelect: jest.fn(),
  toggleFaceIdRequiredForApproval: jest.fn(),
  selectTtsProvider: mockSelectTtsProvider,
  selectSttProvider: mockSelectSttProvider,
  applyRecordingQualityPreset: mockApplyRecordingQualityPreset,
  loadVoices: mockLoadVoices,
  changeTtsSpeedInput: jest.fn(),
  commitTtsSpeedInput: jest.fn(),
  decreaseTtsSpeed: jest.fn(),
  increaseTtsSpeed: jest.fn(),
  changeVoiceFilter: jest.fn(),
  selectVoiceId: mockSelectVoiceId,
  toggleAutoTranscribeOnStop: jest.fn(),
  toggleAutoReplyAfterStt: mockToggleAutoReplyAfterStt,
  toggleAutoBargeInEnabled: jest.fn(),
  toggleAutoSpeakerPriorityEnabled: jest.fn(),
  toggleAutoSpeakAfterReply: jest.fn(),
  exportSettingsJson: mockExportSettingsJson,
  importSettingsJson: jest.fn(),
  clearToolAutoApprovals: jest.fn(),
  selectModel: mockSelectModel,
  selectThinkOption: mockSelectThinkOption,
};

jest.mock("../contexts/AppShellContext", () => ({
  useAppShell: () => ({
    openSkiaBoardScreen: mockOpenSkiaBoardScreen,
    openDrawer: mockOpenDrawer,
  }),
}));

jest.mock("../contexts/AppSettingsContext", () => ({
  useAppSettings: () => mockSettings,
}));

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders real settings and wires their actions securely", async () => {
  const screen = await render(<SettingsScreen />);

  expect(screen.getByText("接続とエージェント")).toBeTruthy();
  expect(screen.getByText("音声")).toBeTruthy();
  expect(screen.getByText("音声の動作")).toBeTruthy();
  expect(screen.getByText("設定の移行と承認ルール")).toBeTruthy();
  expect(screen.queryByText("作業ディレクトリ")).toBeNull();
  expect(screen.queryByDisplayValue("/work/bitty")).toBeNull();
  expect(screen.queryByText("変更内容はこの端末に自動保存されます。")).toBeNull();
  expect(screen.queryByText("Runnerへの接続先とCodexの実行設定")).toBeNull();
  expect(screen.getByText(/認証トークン.*保存済み承認ルールは移行に含まれません/)).toBeTruthy();
  expect(screen.queryByLabelText("Codexトークン")).toBeNull();
  expect(screen.getByDisplayValue("runner-secret").props.secureTextEntry).toBe(true);

  expect(screen.queryByLabelText("Runner URL")).toBeNull();
  await fireEvent.changeText(screen.getByLabelText("ローカルURL"), "http://next.local:8788");
  await fireEvent.changeText(screen.getByLabelText("Cloudflare経由URL"), "https://next.example.com");
  await fireEvent(screen.getByLabelText("文字起こし後に送信"), "valueChange", true);
  await fireEvent.press(screen.getByText("設定をクリップボードへ書き出す"));
  await fireEvent.press(screen.getByLabelText("メニューに戻る"));

  expect(mockChangeLocalRunnerUrl).toHaveBeenCalledWith("http://next.local:8788");
  expect(mockChangeCloudflareRunnerUrl).toHaveBeenCalledWith("https://next.example.com");
  expect(mockToggleAutoReplyAfterStt).toHaveBeenCalledWith(true);
  expect(mockExportSettingsJson).toHaveBeenCalledTimes(1);
  expect(mockOpenSkiaBoardScreen).toHaveBeenCalledTimes(1);
  expect(mockOpenDrawer).toHaveBeenCalledTimes(1);
});

test("keeps runner token edits as a draft until Save and Connect succeeds", async () => {
  const screen = await render(<SettingsScreen />);

  await fireEvent.changeText(screen.getByLabelText("Runnerトークン"), " next-token ");
  expect(mockSaveRunnerToken).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByLabelText("Runnerトークンを保存して接続"));

  expect(mockSaveRunnerToken).toHaveBeenCalledWith(" next-token ");
  await waitFor(() => {
    expect(screen.getByText("保存を確認し、接続に反映しました。")).toBeTruthy();
  });
});

test("shows the typed token's length and fingerprint so input can be verified while masked", async () => {
  const screen = await render(<SettingsScreen />);

  await fireEvent.changeText(screen.getByLabelText("Runnerトークン"), " runner-token \n");

  await waitFor(() => {
    // FNV-1a("runner-token") = 07b20b97 (tokenFingerprint.test.tsの共有ベクター)
    expect(screen.getByText(/入力中: 12文字・指紋 07b20b97/)).toBeTruthy();
  });
  expect(mockSaveRunnerToken).not.toHaveBeenCalled();
});

test("shows a readback mismatch without reporting a successful connection update", async () => {
  mockSaveRunnerToken.mockRejectedValueOnce(
    new Error("secure_credentials_readback_mismatch: runnerToken")
  );
  const screen = await render(<SettingsScreen />);

  await fireEvent.changeText(screen.getByLabelText("Runnerトークン"), "next-token");
  await fireEvent.press(screen.getByLabelText("Runnerトークンを保存して接続"));

  await waitFor(() => {
    expect(screen.getByText("保存後の読み戻し結果が一致しません。接続トークンは変更していません。")).toBeTruthy();
  });
  expect(screen.queryByText("保存を確認し、接続に反映しました。")).toBeNull();
});

test("shows a keychain rejection without reporting a successful connection update", async () => {
  mockSaveRunnerToken.mockRejectedValueOnce(new Error("User denied keychain access"));
  const screen = await render(<SettingsScreen />);

  await fireEvent.changeText(screen.getByLabelText("Runnerトークン"), "next-token");
  await fireEvent.press(screen.getByLabelText("Runnerトークンを保存して接続"));

  await waitFor(() => {
    expect(screen.getByText(/キーチェーンへの保存に失敗しました.*User denied keychain access/)).toBeTruthy();
  });
  expect(screen.queryByText("保存を確認し、接続に反映しました。")).toBeNull();
});

test("shows the build stamp and copies it to the clipboard", async () => {
  const screen = await render(<SettingsScreen />);

  expect(screen.getByText("アプリ情報")).toBeTruthy();
  expect(screen.getByText("ビルド")).toBeTruthy();
  const stampText = screen.getByText(/^dev$|^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(.+\)$/);

  await fireEvent.press(screen.getByLabelText("ビルドIDをコピー"));

  expect(mockSetStringAsync).toHaveBeenCalledWith(stampText.props.children);
  expect(screen.getByText("コピーしました")).toBeTruthy();
  await screen.unmount();
});

test("uses dropdowns for selectable settings", async () => {
  const screen = await render(<SettingsScreen />);

  await fireEvent.press(screen.getByLabelText("モデル"));
  await fireEvent.press(screen.getAllByText("GPT-5.5").at(-1)!);
  expect(mockSelectModel).toHaveBeenCalledWith("codex::gpt-5.5");

  await fireEvent.press(screen.getByLabelText("推論レベル"));
  await fireEvent.press(screen.getByText("低"));
  expect(mockSelectThinkOption).toHaveBeenCalledWith("low");

  await fireEvent.press(screen.getByLabelText("読み上げサービス"));
  await fireEvent.press(screen.getByText("Google"));
  expect(mockSelectTtsProvider).toHaveBeenCalledWith("google");

  await fireEvent.press(screen.getByLabelText("声"));
  expect(mockLoadVoices).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText("Voice A"));
  expect(mockSelectVoiceId).toHaveBeenCalledWith("voice-a");

  await fireEvent.press(screen.getByLabelText("文字起こしサービス"));
  await fireEvent.press(screen.getByText("ios_native (SFSpeechRecognizer)"));
  expect(mockSelectSttProvider).toHaveBeenCalledWith("ios_native");

  await fireEvent.press(screen.getByLabelText("録音品質"));
  await fireEvent.press(screen.getByText("中"));
  expect(mockApplyRecordingQualityPreset).toHaveBeenCalledWith("medium");

  await fireEvent.press(screen.getByLabelText("承認ポリシー"));
  await fireEvent.press(screen.getByText("確認しない"));
  expect(mockSelectCodexApprovalPolicy).toHaveBeenCalledWith("never");
});
