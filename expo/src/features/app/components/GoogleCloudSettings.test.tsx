import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import { GoogleCloudSettings } from "./GoogleCloudSettings";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../contexts/AppSettingsContext", () => ({
  useAppSettings: () => ({ runnerUrl: "https://runner.example.com", runnerToken: "runner-token" }),
}));

const saved = { sttRegion: "us", sttModel: "chirp_3" };
let status = { ...saved };
let rejectSave = false;
let holdFirstSave = false;
let releaseFirstSave: (() => void) | undefined;
let holdFirstStatusGet = false;
let releaseFirstStatusGet: (() => void) | undefined;
const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === "PUT") {
    if (holdFirstSave) {
      holdFirstSave = false;
      await new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    }
    if (rejectSave) return { ok: false, status: 400, json: async () => ({ message: "選択した組合せを保存できません" }) };
    Object.assign(status, JSON.parse(String(init.body)));
  } else {
    const fetchedStatus = { ...status };
    if (holdFirstStatusGet) {
      holdFirstStatusGet = false;
      await new Promise<void>((resolve) => { releaseFirstStatusGet = resolve; });
    }
    return { ok: true, json: async () => ({ status: "connected", projectId: "project-1", ...fetchedStatus }) };
  }
  return { ok: true, json: async () => ({ status: "connected", projectId: "project-1", ...status }) };
});

beforeEach(() => {
  jest.clearAllMocks();
  status = { ...saved };
  rejectSave = false;
  holdFirstSave = false;
  releaseFirstSave = undefined;
  holdFirstStatusGet = false;
  releaseFirstStatusGet = undefined;
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

test("auto-saves each selection in order, including a change made during a save", async () => {
  holdFirstSave = true;
  const screen = await render(<GoogleCloudSettings />);
  await waitFor(() => expect(screen.getByText("リージョン: us · 認識モデル: chirp_3")).toBeTruthy());
  expect(screen.queryByLabelText("リージョン")).toBeNull();

  await fireEvent.press(screen.getByLabelText("Google Cloud STT 詳細設定"));
  expect(screen.queryByLabelText("STT 詳細設定を保存")).toBeNull();
  await fireEvent.press(screen.getByLabelText("リージョン"));
  await fireEvent.press(screen.getByText("東京 (asia-northeast1) · 検証中"));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1));
  await fireEvent.press(screen.getByLabelText("認識モデル"));
  await fireEvent.press(screen.getByText("long"));
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  releaseFirstSave?.();

  await waitFor(() => {
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { sttRegion: "asia-northeast1", sttModel: "chirp_3" },
      { sttRegion: "asia-northeast1", sttModel: "long" },
    ]);
    expect(screen.getByText("リージョン: asia-northeast1 · 認識モデル: long")).toBeTruthy();
  });
  await fireEvent.press(screen.getByLabelText("Google Cloud STT 詳細設定"));
  expect(screen.queryByLabelText("リージョン")).toBeNull();
  expect(screen.getByText("リージョン: asia-northeast1 · 認識モデル: long")).toBeTruthy();
});

test("keeps the saved choice and shows a Runner rejection", async () => {
  rejectSave = true;
  const screen = await render(<GoogleCloudSettings />);
  await waitFor(() => expect(screen.getByText("リージョン: us · 認識モデル: chirp_3")).toBeTruthy());

  await fireEvent.press(screen.getByLabelText("Google Cloud STT 詳細設定"));
  await fireEvent.press(screen.getByLabelText("認識モデル"));
  await fireEvent.press(screen.getByText("short"));

  await waitFor(() => expect(screen.getByText("選択した組合せを保存できません")).toBeTruthy());
  expect(screen.getByText("リージョン: us · 認識モデル: chirp_3")).toBeTruthy();
  expect(screen.getByLabelText("認識モデル").props.accessibilityValue).toEqual({ text: "chirp_3" });
});

test("an older status response cannot restore settings saved while it was in flight", async () => {
  holdFirstStatusGet = true;
  const screen = await render(<GoogleCloudSettings />);
  await waitFor(() => expect(releaseFirstStatusGet).toBeDefined());

  await fireEvent.press(screen.getByLabelText("Google Cloud STT 詳細設定"));
  await fireEvent.press(screen.getByLabelText("認識モデル"));
  await fireEvent.press(screen.getByText("long"));
  await waitFor(() => expect(screen.getByText("リージョン: us · 認識モデル: long")).toBeTruthy());

  releaseFirstStatusGet?.();
  await waitFor(() => expect(screen.getByPlaceholderText("Google Cloud project ID").props.value).toBe("project-1"));
  expect(screen.getByText("リージョン: us · 認識モデル: long")).toBeTruthy();
});
