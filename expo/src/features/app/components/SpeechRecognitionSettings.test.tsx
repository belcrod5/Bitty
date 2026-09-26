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
const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === "PUT") {
    if (failSave) return { ok: false, status: 500, json: async () => ({ message: "保存できませんでした" }) };
    selected = JSON.parse(String(init.body)).provider;
  }
  return { ok: true, json: async () => ({ provider: selected }) };
});

beforeEach(() => {
  jest.clearAllMocks();
  selected = "google";
  failSave = false;
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
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
