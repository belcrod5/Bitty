import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import { CodexScheduleSettings } from "./CodexScheduleSettings";
import { CodexScheduleEditor } from "./CodexScheduleEditor";
import { CodexScheduleApiError, getCodexSchedules, putCodexSchedules } from "./codexScheduleApi";

jest.mock("expo-crypto", () => ({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }));
jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");
jest.mock("react-native-keyboard-controller", () => {
  const { ScrollView } = jest.requireActual("react-native") as typeof import("react-native");
  return { KeyboardAwareScrollView: ScrollView };
});
jest.mock("./codexScheduleApi", () => ({
  ...jest.requireActual("./codexScheduleApi"),
  getCodexSchedules: jest.fn(),
  putCodexSchedules: jest.fn(),
}));

const mockGet = getCodexSchedules as jest.MockedFunction<typeof getCodexSchedules>;
const mockPut = putCodexSchedules as jest.MockedFunction<typeof putCodexSchedules>;
const alertMock = jest.fn();
let warnSpy: jest.SpyInstance;
const props = {
  runnerUrl: "http://runner",
  runnerToken: "token",
  currentCwd: "/work",
  currentModelRef: "openai-codex/gpt-5.6",
  currentReasoningEffort: "high" as const,
  currentThreadId: "thread-current",
  directories: [{ path: "/work", displayName: "Work" }],
  modelOptions: [{ value: "openai-codex/gpt-5.6", label: "GPT-5.6" }],
  thinkOptions: ["low", "high"] as const,
};
const schedule = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Morning",
  enabled: true,
  startLocal: "2026-08-14T09:07:00",
  timeZone: "Asia/Tokyo",
  rrule: null,
  action: {
    kind: "llm" as const,
    cwd: "/work",
    modelRef: "openai-codex/gpt-5.6",
    reasoningEffort: "high" as const,
    prompt: "Check",
    threadId: null,
  },
  nextOccurrenceAt: null,
  lastDispatch: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  Alert.alert = alertMock;
  warnSpy = jest.spyOn(console, "warn").mockImplementation((...args) => {
    if (!String(args[0] || "").includes("SafeAreaView has been deprecated")) {
      throw new Error(`unexpected console.warn: ${String(args[0] || "")}`);
    }
  });
  mockGet.mockResolvedValue({ revision: 0, schedules: [] });
});

afterEach(() => warnSpy.mockRestore());

test("shows loading failure and retries without treating local state as saved", async () => {
  mockGet.mockRejectedValueOnce(new Error("Runner unavailable"));
  const view = await render(<CodexScheduleSettings {...props} />);
  await act(async () => fireEvent.press(view.getByLabelText("スケジュール実行")));
  expect(await view.findByText("Runner unavailable")).toBeTruthy();
  await act(async () => fireEvent.press(view.getByText("再試行")));
  await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  expect(await view.findByText("スケジュールはありません。")).toBeTruthy();
});

test("new editor exposes native pickers and reuses directory, model, and effort options", async () => {
  const view = await render(<CodexScheduleSettings {...props} />);
  await act(async () => fireEvent.press(view.getByLabelText("スケジュール実行")));
  await view.findByText("スケジュールはありません。");
  await act(async () => fireEvent.press(view.getByLabelText("スケジュールを追加")));
  expect(await view.findByLabelText("開始日")).toBeTruthy();
  expect(view.getByLabelText("開始時刻")).toBeTruthy();
  expect(view.getByLabelText("ディレクトリ")).toBeTruthy();
  expect(view.getByLabelText("モデル")).toBeTruthy();
  expect(view.getByLabelText("思考レベル")).toBeTruthy();
  expect(view.getByLabelText("実行先")).toBeTruthy();
  expect(view.getByLabelText("実行種別")).toBeTruthy();
});

test("script execution browses the selected directory and saves the chosen .sh action", async () => {
  const directoryResponse = {
    basePath: "/work",
    entries: [
      { kind: "file", name: "ignore.txt", path: "/work/ignore.txt" },
      { kind: "file", name: "scheduled.sh", path: "/work/scheduled.sh" },
    ],
  };
  const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(directoryResponse),
  } as Response);
  mockPut.mockResolvedValue({ revision: 1, schedules: [] });
  const view = await render(<CodexScheduleSettings {...props} />);
  await act(async () => fireEvent.press(view.getByLabelText("スケジュール実行")));
  await view.findByText("スケジュールはありません。");
  await act(async () => fireEvent.press(view.getByLabelText("スケジュールを追加")));
  await act(async () => fireEvent.changeText(view.getByLabelText("スケジュール名"), "Shell"));
  await act(async () => fireEvent.press(view.getByLabelText("実行種別")));
  await act(async () => fireEvent.press(view.getAllByText("実行ファイル").at(-1)!));
  await act(async () => fireEvent.press(view.getByLabelText("実行ファイル")));
  expect(await view.findByText("scheduled.sh")).toBeTruthy();
  expect(view.queryByText("ignore.txt")).toBeNull();
  await act(async () => fireEvent.press(view.getByLabelText("scheduled.shを選択")));
  await act(async () => fireEvent.press(view.getByLabelText("編集を閉じる")));
  await act(async () => fireEvent.press(view.getByLabelText("スケジュールを保存")));
  expect(fetchSpy).toHaveBeenCalledWith(
    expect.stringContaining("%2Fwork"),
    expect.objectContaining({ headers: { authorization: "Bearer token" } }),
  );
  expect(mockPut).toHaveBeenCalledWith(
    expect.anything(),
    0,
    [expect.objectContaining({
      action: { kind: "script", cwd: "/work", scriptPath: "/work/scheduled.sh" },
    })],
  );
});

test("revision conflict offers a reload and never marks the draft saved", async () => {
  mockPut.mockRejectedValue(new CodexScheduleApiError("conflict", 409, "revision_conflict", 3));
  const view = await render(<CodexScheduleSettings {...props} />);
  await act(async () => fireEvent.press(view.getByLabelText("スケジュール実行")));
  await view.findByText("スケジュールはありません。");
  await act(async () => fireEvent.press(view.getByLabelText("スケジュールを追加")));
  await view.findByLabelText("スケジュール名");
  await act(async () => fireEvent.changeText(view.getByLabelText("スケジュール名"), "Morning"));
  await act(async () => fireEvent.changeText(view.getByLabelText("プロンプト"), "Check the project"));
  await act(async () => fireEvent.press(view.getByLabelText("編集を閉じる")));
  await act(async () => fireEvent.press(view.getByLabelText("スケジュールを保存")));
  expect(alertMock).toHaveBeenCalledWith(
    "別の端末で更新されています",
    expect.any(String),
    expect.arrayContaining([expect.objectContaining({ text: "再読込" })]),
  );
  expect(view.getByLabelText("スケジュールを保存")).toBeEnabled();
  await act(async () => view.unmount());
});

test("native date picker normalizes its edited value back to startLocal", async () => {
  const onChange = jest.fn();
  const view = await render(
    <CodexScheduleEditor
      schedule={schedule}
      directories={props.directories}
      modelOptions={props.modelOptions}
      thinkOptions={props.thinkOptions}
      currentThreadId={props.currentThreadId}
      runnerUrl={props.runnerUrl}
      runnerToken={props.runnerToken}
      onChange={onChange}
      onClose={jest.fn()}
      onDelete={jest.fn()}
    />,
  );
  await act(async () => fireEvent(await view.findByLabelText("開始日"), "onChange", {}, new Date(2027, 1, 3, 12, 0)));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ startLocal: "2027-02-03T09:07:00" }));
});

test("editor follows the keyboard so focused text inputs remain visible", async () => {
  const view = await render(
    <CodexScheduleEditor
      schedule={schedule}
      directories={props.directories}
      modelOptions={props.modelOptions}
      thinkOptions={props.thinkOptions}
      currentThreadId={props.currentThreadId}
      runnerUrl={props.runnerUrl}
      runnerToken={props.runnerToken}
      onChange={jest.fn()}
      onClose={jest.fn()}
      onDelete={jest.fn()}
    />,
  );

  expect(await view.findByTestId("codex-schedule-editor-scroll")).toHaveProp("bottomOffset", 24);
});

test("editor can target only the current Codex chat or a new chat", async () => {
  const onChange = jest.fn();
  const view = await render(
    <CodexScheduleEditor
      schedule={schedule}
      directories={props.directories}
      modelOptions={props.modelOptions}
      thinkOptions={props.thinkOptions}
      currentThreadId={props.currentThreadId}
      runnerUrl={props.runnerUrl}
      runnerToken={props.runnerToken}
      onChange={onChange}
      onClose={jest.fn()}
      onDelete={jest.fn()}
    />,
  );

  await act(async () => fireEvent.press(await view.findByLabelText("実行先")));
  await act(async () => fireEvent.press(view.getByText("現在のチャット")));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
    action: expect.objectContaining({ threadId: "thread-current" }),
  }));
});

test("editor displays a saved script selection without LLM-only fields", async () => {
  const view = await render(
    <CodexScheduleEditor
      schedule={{
        ...schedule,
        action: { kind: "script", cwd: "/work", scriptPath: "/work/tasks/nightly.sh" },
      }}
      directories={props.directories}
      modelOptions={props.modelOptions}
      thinkOptions={props.thinkOptions}
      currentThreadId={props.currentThreadId}
      runnerUrl={props.runnerUrl}
      runnerToken={props.runnerToken}
      onChange={jest.fn()}
      onClose={jest.fn()}
      onDelete={jest.fn()}
    />,
  );

  expect(await view.findByText("/work/tasks/nightly.sh")).toBeTruthy();
  expect(view.queryByLabelText("モデル")).toBeNull();
  expect(view.queryByLabelText("プロンプト")).toBeNull();
});
