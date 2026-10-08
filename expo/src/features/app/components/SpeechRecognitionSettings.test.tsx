import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import { SpeechRecognitionSettings } from "./SpeechRecognitionSettings";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../contexts/AppSettingsContext", () => ({
  useAppSettings: () => ({ runnerUrl: "https://runner.example.com", runnerToken: "runner-token" }),
}));

let selected = "google";
let failSave = false;
let correction = { model: "gpt-6-luna", effort: "low" };
const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
  if (_url.endsWith("/stt/models")) return { ok: true, json: async () => ({ models: [
    { modelId: "gpt-6-luna", label: "GPT-6 Luna", effortOptions: ["low", "medium"] },
    { modelId: "gpt-6-astra", label: "GPT-6 Astra", effortOptions: ["medium", "high"] },
  ] }) };
  if (init?.method === "PUT") {
    if (failSave) return { ok: false, status: 500, json: async () => ({ message: "保存できませんでした" }) };
    selected = JSON.parse(String(init.body)).provider;
  }
  if (init?.method === "PATCH") correction = JSON.parse(String(init.body)).correction;
  return { ok: true, json: async () => ({ provider: selected,
    correction }) };
});

beforeEach(() => {
  jest.clearAllMocks();
  selected = "google";
  failSave = false;
  correction = { model: "gpt-6-luna", effort: "low" };
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
});

test("saves model and supported effort together", async () => {
  const screen = await render(<SpeechRecognitionSettings />);
  await waitFor(() => expect(screen.getByLabelText("補正モデル").props.accessibilityValue)
    .toEqual({ text: "GPT-6 Luna" }));
  await fireEvent.press(screen.getByLabelText("補正モデル"));
  await fireEvent.press(screen.getByText("GPT-6 Astra"));
  await waitFor(() => expect(correction).toEqual({ model: "gpt-6-astra", effort: "medium" }));
  await fireEvent.press(screen.getByLabelText("補正の思考量"));
  await fireEvent.press(screen.getByText("high"));
  await waitFor(() => expect(correction).toEqual({ model: "gpt-6-astra", effort: "high" }));
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { correction: { model: "gpt-6-astra", effort: "medium" } },
      { correction: { model: "gpt-6-astra", effort: "high" } },
    ]);
});
afterEach(() => jest.restoreAllMocks());

test("switches the Runner's speech provider and preserves the saved choice", async () => {
  const screen = await render(<SpeechRecognitionSettings />);
  await waitFor(() => expect(screen.getByLabelText("文字起こし方式").props.accessibilityValue).toEqual({ text: "Google Cloud" }));
  await fireEvent.press(screen.getByLabelText("文字起こし方式"));
  await fireEvent.press(screen.getByText("macOS標準"));
  await waitFor(() => expect(screen.getByLabelText("文字起こし方式").props.accessibilityValue).toEqual({ text: "macOS標準" }));
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(String(init?.body))))
    .toEqual([{ provider: "macos" }]);
});

test("keeps the previous choice when the Runner rejects a change", async () => {
  failSave = true;
  const screen = await render(<SpeechRecognitionSettings />);
  await waitFor(() => expect(screen.getByLabelText("文字起こし方式").props.accessibilityValue).toEqual({ text: "Google Cloud" }));
  await fireEvent.press(screen.getByLabelText("文字起こし方式"));
  await fireEvent.press(screen.getByText("macOS標準"));
  await waitFor(() => expect(screen.getByText("保存できませんでした")).toBeTruthy());
  expect(screen.getByLabelText("文字起こし方式").props.accessibilityValue).toEqual({ text: "Google Cloud" });
});
