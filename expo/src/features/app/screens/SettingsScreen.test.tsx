import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { SettingsScreen } from "./SettingsScreen";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("expo-av", () => ({
  Audio: {
    RecordingOptionsPresets: {
      HIGH_QUALITY: { android: {}, ios: {}, web: {} },
    },
  },
}));

const mockOpenSkiaBoardScreen = jest.fn();
const mockOpenDrawer = jest.fn();
const mockChangeRunnerUrl = jest.fn();
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

const mockSettings = {
  runnerUrl: "https://runner.example.com",
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
  changeRunnerUrl: mockChangeRunnerUrl,
  changeLlmDirectory: jest.fn(),
  changeRunnerToken: jest.fn(),
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

  await fireEvent.changeText(screen.getByLabelText("Runner URL"), "https://next.example.com");
  await fireEvent(screen.getByLabelText("文字起こし後に送信"), "valueChange", true);
  await fireEvent.press(screen.getByText("設定をクリップボードへ書き出す"));
  await fireEvent.press(screen.getByLabelText("メニューに戻る"));

  expect(mockChangeRunnerUrl).toHaveBeenCalledWith("https://next.example.com");
  expect(mockToggleAutoReplyAfterStt).toHaveBeenCalledWith(true);
  expect(mockExportSettingsJson).toHaveBeenCalledTimes(1);
  expect(mockOpenSkiaBoardScreen).toHaveBeenCalledTimes(1);
  expect(mockOpenDrawer).toHaveBeenCalledTimes(1);
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
