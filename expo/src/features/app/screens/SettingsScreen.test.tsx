import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";

jest.mock("../keyboardController", () => ({
  KeyboardAvoidingView: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import { SettingsScreen } from "./SettingsScreen";
import { VisualThemeProvider } from "../theme/VisualThemeContext";

jest.mock("../components/CodexAccountSettings", () => ({ CodexAccountSettings: () => null }));
jest.mock("../components/GoogleCloudSettings", () => ({ GoogleCloudSettings: () => null }));
jest.mock("../components/RunnerLoginSettings", () => ({
  RunnerLoginSettings: () => { const { Text } = require("react-native"); return <Text>本人ログインと端末</Text>; },
}));

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
const mockSetStringAsync = jest.fn(async (_text: string) => true);
jest.mock("../clipboard", () => ({
  setStringAsync: (text: string) => mockSetStringAsync(text),
}));

const mockOpenSkiaBoardScreen = jest.fn();
const mockOpenDrawer = jest.fn();
const mockOpenCloudflareTunnelMonitorScreen = jest.fn();
const mockChangeCloudflareRunnerUrl = jest.fn();
const mockChangeLocalRunnerUrl = jest.fn();
const mockToggleAutoReplyAfterStt = jest.fn();
const mockExportSettingsJson = jest.fn();
const mockSelectTtsProvider = jest.fn();
const mockSelectCodexApprovalPolicy = jest.fn();
const mockSelectModel = jest.fn();
const mockSelectTitleSettings = jest.fn();
const mockSelectThinkOption = jest.fn();
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
    { selectionKey: "codex::gpt-6-luna", label: "GPT-6 Luna", modelId: "gpt-6-luna", backendId: "codex", supportsReasoningEffort: true, effortOptions: ["low", "medium"] },
    { selectionKey: "codex::gpt-6.1-luna", label: "GPT-6.1 Luna", modelId: "gpt-6.1-luna", backendId: "codex", supportsReasoningEffort: true, effortOptions: ["low", "medium"] },
    { selectionKey: "codex::gpt-6.1-sol", label: "GPT-6.1 Sol", modelId: "gpt-6.1-sol", backendId: "codex", supportsReasoningEffort: true, effortOptions: ["high"] },
  ],
  titleModelId: "gpt-6-luna",
  titleReasoningEffort: "low",
  selectTitleSettings: mockSelectTitleSettings,
  thinkOptions: ["low", "medium", "high"],
  faceIdRequiredForApproval: true,
  ttsProvider: "aivisspeech",
  voicesLoading: false,
  filteredVoices: [{ voiceId: "voice-a", name: "Voice A" }],
  ttsSpeedInput: "1.2",
  ttsSpeed: 1.2,
  lightweightTtsOnCellular: false,
  voiceFilter: "",
  selectedVoiceId: "",
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
  toggleLightweightTtsOnCellular: jest.fn(),
  loadVoices: mockLoadVoices,
  changeTtsSpeedInput: jest.fn(),
  commitTtsSpeedInput: jest.fn(),
  decreaseTtsSpeed: jest.fn(),
  increaseTtsSpeed: jest.fn(),
  changeVoiceFilter: jest.fn(),
  selectVoiceId: mockSelectVoiceId,
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
    openCloudflareTunnelMonitorScreen: mockOpenCloudflareTunnelMonitorScreen,
  }),
}));

jest.mock("../contexts/AppSettingsContext", () => ({
  useAppSettings: () => mockSettings,
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSettings.titleModelId = "gpt-6-luna";
  mockSettings.titleReasoningEffort = "low";
});

test("renders real settings and wires their actions securely", async () => {
  const screen = await render(<SettingsScreen />);

  expect(screen.getByText("接続")).toBeTruthy();
  expect(screen.getByText("通常チャット")).toBeTruthy();
  expect(screen.getByText("タイトル生成")).toBeTruthy();
  expect(screen.getByText("音声")).toBeTruthy();
  expect(screen.getByText("音声の動作")).toBeTruthy();
  expect(screen.getByText("設定の移行と承認ルール")).toBeTruthy();
  expect(screen.queryByText("作業ディレクトリ")).toBeNull();
  expect(screen.queryByDisplayValue("/work/bitty")).toBeNull();
  expect(screen.queryByText("変更内容はこの端末に自動保存されます。")).toBeNull();
  expect(screen.queryByText("Runnerへの接続先とCodexの実行設定")).toBeNull();
  expect(screen.getByText(/認証トークン.*保存済み承認ルールは移行に含まれません/)).toBeTruthy();
  expect(screen.queryByLabelText("Codexトークン")).toBeNull();
  expect(screen.queryByLabelText("Runnerトークン")).toBeNull();
  expect(screen.getByText("本人ログインと端末")).toBeTruthy();
  expect(screen.getAllByText(/^(本人ログインと端末|接続)$/).map((node) => node.props.children))
    .toEqual(["本人ログインと端末", "接続"]);

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

test("opens the dedicated Cloudflare Tunnel monitor from Settings", async () => {
  const screen = await render(<SettingsScreen />);

  expect(screen.getByText("Cloudflare Tunnel")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Cloudflare Tunnelを開く"));

  expect(mockOpenCloudflareTunnelMonitorScreen).toHaveBeenCalledTimes(1);
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
  expect(screen.getByLabelText("タイトル生成モデル").props.accessibilityValue.text).toBe("GPT-6 Luna");

  await fireEvent.press(screen.getByLabelText("モデル"));
  await fireEvent.press(screen.getAllByText("GPT-5.5").at(-1)!);
  expect(mockSelectModel).toHaveBeenCalledWith("codex::gpt-5.5");

  await fireEvent.press(screen.getByLabelText("タイトル生成モデル"));
  expect(screen.queryByText("自動（Luna）")).toBeNull();
  expect(screen.getByText("GPT-6.1 Sol")).toBeTruthy();
  await fireEvent.press(screen.getByText("GPT-6.1 Luna"));
  expect(mockSelectTitleSettings).toHaveBeenCalledWith("gpt-6.1-luna", "low");
  expect(mockSelectModel).toHaveBeenCalledTimes(1);

  await fireEvent.press(screen.getByLabelText("タイトル生成の推論レベル"));
  await fireEvent.press(screen.getAllByText("中").at(-1)!);
  expect(mockSelectTitleSettings).toHaveBeenLastCalledWith("gpt-6-luna", "medium");

  await fireEvent.press(screen.getByLabelText("推論レベル"));
  await fireEvent.press(screen.getAllByText("低")[0]);
  expect(mockSelectThinkOption).toHaveBeenCalledWith("low");

  await fireEvent.press(screen.getByLabelText("読み上げサービス"));
  await fireEvent.press(screen.getByText("Google"));
  expect(mockSelectTtsProvider).toHaveBeenCalledWith("google");

  await fireEvent.press(screen.getByLabelText("声"));
  expect(mockLoadVoices).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText("Voice A"));
  expect(mockSelectVoiceId).toHaveBeenCalledWith("voice-a");

  await fireEvent.press(screen.getByLabelText("承認ポリシー"));
  await fireEvent.press(screen.getByText("確認しない"));
  expect(mockSelectCodexApprovalPolicy).toHaveBeenCalledWith("never");
});

test("title effort follows only its selected model and resets with model changes", async () => {
  mockSettings.titleModelId = "gpt-6.1-luna";
  mockSettings.titleReasoningEffort = "medium";
  const screen = await render(<SettingsScreen />);

  await fireEvent.press(screen.getByLabelText("タイトル生成の推論レベル"));
  await fireEvent.press(screen.getAllByText("中").at(-1)!);
  expect(mockSelectTitleSettings).toHaveBeenLastCalledWith("gpt-6.1-luna", "medium");

  await fireEvent.press(screen.getByLabelText("タイトル生成モデル"));
  await fireEvent.press(screen.getByText("GPT-6.1 Sol"));
  expect(mockSelectTitleSettings).toHaveBeenLastCalledWith("gpt-6.1-sol", "high");
  await fireEvent.press(screen.getByLabelText("タイトル生成モデル"));
  await fireEvent.press(screen.getAllByText("GPT-6 Luna").at(-1)!);
  expect(mockSelectTitleSettings).toHaveBeenLastCalledWith("gpt-6-luna", "medium");
  expect(mockSelectThinkOption).not.toHaveBeenCalled();
});

test("switches the visual theme from the display settings", async () => {
  const selectTheme = jest.fn();
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={selectTheme}>
      <SettingsScreen />
    </VisualThemeProvider>
  );

  await fireEvent.press(screen.getByLabelText("表示テーマ"));
  await fireEvent.press(screen.getByText("cyberpunk"));

  expect(selectTheme).toHaveBeenCalledWith("cyberpunk");
});

test("mobile lightweight audio switch changes the saved preference", async () => {
  const screen = await render(<SettingsScreen />);
  await fireEvent(screen.getByLabelText("モバイル通信中は軽量音声"), "valueChange", true);
  expect(mockSettings.toggleLightweightTtsOnCellular).toHaveBeenCalledWith(true);
});
