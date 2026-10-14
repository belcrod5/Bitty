import { act, renderHook } from "@testing-library/react-native";
import { saveSecureRunnerCredentials } from "../utils/secureRunnerCredentials";
import { useAppContextActions } from "./useAppContextActions";
import { configureLocalRunnerTls } from "../utils/localRunnerTls";

jest.mock("expo-av", () => ({
  Audio: {
    RecordingOptionsPresets: {
      HIGH_QUALITY: { android: {}, ios: {}, web: {} },
    },
  },
}));

jest.mock("../utils/secureRunnerCredentials", () => ({
  saveSecureRunnerCredentials: jest.fn(),
}));
jest.mock("../utils/localRunnerTls", () => ({ configureLocalRunnerTls: jest.fn() }));

const mockSaveSecureRunnerCredentials = jest.mocked(saveSecureRunnerCredentials);

async function renderActions(setRunnerToken: jest.Mock, retryRunnerWsConnection?: jest.Mock) {
  return renderHook(() => useAppContextActions({
    setRunnerToken,
    retryRunnerWsConnection,
  } as unknown as Parameters<typeof useAppContextActions>[0]));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(configureLocalRunnerTls).mockResolvedValue(true);
});

test("QR pairing waits for native CA configuration before storing or applying credentials", async () => {
  let finish!: (value: boolean) => void;
  jest.mocked(configureLocalRunnerTls).mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  mockSaveSecureRunnerCredentials.mockResolvedValue(undefined);
  const setRunnerToken = jest.fn();
  const setLocalRunnerCertificate = jest.fn();
  const hook = await renderHook(() => useAppContextActions({ setRunnerToken, setLocalRunnerCertificate,
    setRunnerUrl: jest.fn(), setCloudflareAccessClientId: jest.fn(), setCloudflareAccessClientSecret: jest.fn(),
    setCloudflareRunnerUrl: jest.fn(), setLocalRunnerUrl: jest.fn(),
  } as unknown as Parameters<typeof useAppContextActions>[0]));
  const payload = JSON.stringify({ type: "bitty.runner.pairing", runnerUrl: "https://runner.example.com",
    localRunnerUrl: "https://mac.local:8789", localRunnerCertificate: "paired-ca", runnerToken: "token",
    cloudflareAccessClientId: "cf-id", cloudflareAccessClientSecret: "cf-secret" });
  let pairing!: Promise<unknown>;
  await act(async () => { pairing = hook.result.current.applyCloudflareRunnerPairing(payload); });
  expect(configureLocalRunnerTls).toHaveBeenCalledWith("https://mac.local:8789", "paired-ca");
  expect(mockSaveSecureRunnerCredentials).not.toHaveBeenCalled();
  expect(setRunnerToken).not.toHaveBeenCalled();
  await act(async () => { finish(true); await pairing; });
  expect(setRunnerToken).toHaveBeenCalledWith("token");
  expect(setLocalRunnerCertificate).toHaveBeenCalledWith("paired-ca");
});

test("updates the connection token only after secure persistence succeeds", async () => {
  let finishSave = () => {};
  mockSaveSecureRunnerCredentials.mockImplementation(() => new Promise<void>((resolve) => {
    finishSave = resolve;
  }));
  const setRunnerToken = jest.fn();
  const hook = await renderActions(setRunnerToken);

  let saving!: Promise<void>;
  await act(async () => {
    saving = hook.result.current.saveRunnerToken(" next-token ");
    await Promise.resolve();
  });
  expect(mockSaveSecureRunnerCredentials).toHaveBeenCalledWith({ runnerToken: "next-token" });
  expect(setRunnerToken).not.toHaveBeenCalled();

  finishSave();
  await act(async () => {
    await saving;
  });
  expect(setRunnerToken).toHaveBeenCalledWith("next-token");
});

test("keeps the current connection token when secure persistence fails", async () => {
  mockSaveSecureRunnerCredentials.mockRejectedValue(new Error("keychain denied"));
  const setRunnerToken = jest.fn();
  const retryRunnerWsConnection = jest.fn();
  const hook = await renderActions(setRunnerToken, retryRunnerWsConnection);

  await expect(hook.result.current.saveRunnerToken("next-token")).rejects.toThrow("keychain denied");

  expect(setRunnerToken).not.toHaveBeenCalled();
  expect(retryRunnerWsConnection).not.toHaveBeenCalled();
});

test("a successful save always retries the runner connection, even for an unchanged token", async () => {
  // 保存値が既存tokenと同一だとsetConnectionOptionsは変更なしで早期returnするため、
  // 認証失敗停止(stopped)から抜けるにはこの明示的な再試行が必要。
  mockSaveSecureRunnerCredentials.mockResolvedValue(undefined);
  const setRunnerToken = jest.fn();
  const retryRunnerWsConnection = jest.fn();
  const hook = await renderActions(setRunnerToken, retryRunnerWsConnection);

  await act(async () => {
    await hook.result.current.saveRunnerToken("same-token");
  });

  expect(setRunnerToken).toHaveBeenCalledWith("same-token");
  expect(retryRunnerWsConnection).toHaveBeenCalledTimes(1);
});
