import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { OrchestratorScheduleSettings } from "./OrchestratorScheduleSettings";
import { CodexScheduleApiError, getOrchestratorSchedule, putOrchestratorSchedule } from "./codexScheduleApi";
import type { OrchestratorScheduleSnapshot } from "./codexScheduleTypes";

jest.mock("./codexScheduleApi", () => ({ ...jest.requireActual("./codexScheduleApi"),
  getOrchestratorSchedule: jest.fn(), putOrchestratorSchedule: jest.fn() }));
const getMock = jest.mocked(getOrchestratorSchedule);
const putMock = jest.mocked(putOrchestratorSchedule);
const props = { orchestratorId: "main", orchestratorName: "メイン", runnerUrl: "http://runner", runnerToken: "token" };
function snapshot(owner = "main"): OrchestratorScheduleSnapshot {
  return { orchestratorId: owner, revision: 2, settings: { enabled: false, trigger: { kind: "interval", minutes: 60 },
    prompt: `${owner} periodic prompt`, systemInstruction: "" }, nextOccurrenceAt: null,
    lastDispatch: null, legacyScheduleCount: 0, legacyEnabledCount: 0 };
}
beforeEach(() => { jest.clearAllMocks(); getMock.mockImplementation(async (_auth, id) => snapshot(id));
  putMock.mockImplementation(async (_auth, id, revision, settings) => ({ ...snapshot(id), revision: revision + 1, settings })); });

test("configures one disabled periodic setting without add, list, target or date controls", async () => {
  const view = await render(<OrchestratorScheduleSettings {...props} />);
  await view.findByLabelText("定期実行を有効にする");
  expect(view.queryByLabelText("スケジュールを追加")).toBeNull();
  expect(view.queryByLabelText("オーケストレーター")).toBeNull();
  expect(view.queryByLabelText("開始日")).toBeNull();
  expect(view.queryByLabelText("スケジュールを削除")).toBeNull();
  await fireEvent.changeText(view.getByLabelText("実行するプロンプト"), "Suggest something useful");
  await fireEvent.changeText(view.getByLabelText("定期実行の指示"), "Use one concise suggestion");
  await fireEvent.changeText(view.getByLabelText("実行間隔（分）"), "45");
  await fireEvent.press(view.getByLabelText("定期実行設定を保存"));
  await view.findByText("保存しました。");
  expect(putMock).toHaveBeenLastCalledWith({ runnerUrl: "http://runner", runnerToken: "token" }, "main", 2,
    { enabled: false, trigger: { kind: "interval", minutes: 45 }, prompt: "Suggest something useful", systemInstruction: "Use one concise suggestion" });
  await fireEvent(view.getByLabelText("定期実行を有効にする"), "valueChange", true);
  await fireEvent.press(view.getByLabelText("定期実行設定を保存"));
  await waitFor(() => expect(putMock).toHaveBeenLastCalledWith(expect.anything(), "main", 3, expect.objectContaining({ enabled: true, prompt: "Suggest something useful" })));
});

test("old owner reads and saves cannot replace a newly selected owner's configuration", async () => {
  let finishRead!: (value: OrchestratorScheduleSnapshot) => void;
  getMock.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
  const view = await render(<OrchestratorScheduleSettings {...props} />);
  await view.rerender(<OrchestratorScheduleSettings {...props} orchestratorId="other" />);
  await view.findByDisplayValue("other periodic prompt");
  await act(async () => finishRead(snapshot("main")));
  expect(view.queryByDisplayValue("main periodic prompt")).toBeNull();
  let finishSave!: (value: OrchestratorScheduleSnapshot) => void;
  putMock.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
  await fireEvent.press(view.getByLabelText("定期実行設定を保存"));
  await view.rerender(<OrchestratorScheduleSettings {...props} orchestratorId="third" />);
  await view.findByDisplayValue("third periodic prompt");
  await act(async () => finishSave(snapshot("other")));
  expect(view.getByDisplayValue("third periodic prompt")).toBeTruthy();
});

test("revision conflicts preserve edits and require explicit reload before retry", async () => {
  putMock.mockRejectedValueOnce(new CodexScheduleApiError("Changed", 409, "revision_conflict", 3));
  const view = await render(<OrchestratorScheduleSettings {...props} />);
  await view.findByDisplayValue("main periodic prompt");
  await fireEvent.changeText(view.getByLabelText("実行するプロンプト"), "Unsaved local draft");
  await fireEvent.press(view.getByLabelText("定期実行設定を保存"));
  expect(await view.findByText("別の画面で設定が変更されました。再読込して確認してください。")).toBeTruthy();
  expect(view.getByDisplayValue("Unsaved local draft")).toBeTruthy();
  expect(getMock).toHaveBeenCalledTimes(1);
});

test("discloses active legacy timers and preserves calendar timing, with prior skipped status", async () => {
  getMock.mockResolvedValueOnce({ ...snapshot(), legacyScheduleCount: 2, legacyEnabledCount: 2,
    settings: { ...snapshot().settings, enabled: true, trigger: { kind: "calendar", startLocal: "2026-01-31T09:00:00", timeZone: "Asia/Tokyo", rrule: "FREQ=MONTHLY" } },
    lastDispatch: { occurrenceAt: "2026-11-15T00:00:00.000Z", claimedAt: "2026-11-15T00:00:00.000Z",
      updatedAt: "2026-11-15T00:00:00.000Z", definitionHash: "a".repeat(64), status: "skipped", result: null,
      errorCode: "session_busy", errorMessage: "Busy" } });
  const view = await render(<OrchestratorScheduleSettings {...props} />);
  expect(await view.findByText(/旧設定2件（有効2件）/)).toBeTruthy();
  expect(view.getByText(/毎月・2026-01-31 09:00/)).toBeTruthy();
  expect(view.queryByLabelText("実行間隔（分）")).toBeNull();
  expect(view.getByText(/前回：スキップ（実行中・確認待ち）/)).toBeTruthy();
});

test("calendar wall time loads unchanged and prompt edits or disabling preserve its time and timezone", async () => {
  const trigger = { kind: "calendar" as const, startLocal: "2026-03-08T02:30:00", timeZone: "Asia/Tokyo", rrule: "FREQ=DAILY" as const };
  const nextOccurrenceAt = "2026-11-16T00:00:00.000Z";
  getMock.mockResolvedValueOnce({ ...snapshot(), settings: { ...snapshot().settings, enabled: true, trigger }, nextOccurrenceAt });
  const view = await render(<OrchestratorScheduleSettings {...props} />);
  await view.findByDisplayValue("02:30");
  expect(view.getByDisplayValue("2026-03-08")).toBeTruthy();
  expect(view.queryByLabelText("実行間隔（分）")).toBeNull();
  expect(view.getByText(`次回：${new Date(nextOccurrenceAt).toLocaleString(undefined, { timeZone: "Asia/Tokyo" })}（Asia/Tokyo）`)).toBeTruthy();
  await fireEvent.press(view.getByLabelText("定期実行設定を保存"));
  await view.findByText("保存しました。");
  expect(putMock).toHaveBeenLastCalledWith(expect.anything(), "main", 2, expect.objectContaining({ enabled: true, trigger }));
  await fireEvent.changeText(view.getByLabelText("実行するプロンプト"), "Changed prompt only");
  await fireEvent(view.getByLabelText("定期実行を有効にする"), "valueChange", false);
  await fireEvent.press(view.getByLabelText("定期実行設定を保存"));
  await waitFor(() => expect(putMock).toHaveBeenLastCalledWith(expect.anything(), "main", 3, expect.objectContaining({ enabled: false, trigger })));
});

test("switching calendar and interval sends only the selected trigger fields", async () => {
  const view = await render(<OrchestratorScheduleSettings {...props} />);
  await view.findByLabelText("実行方式");
  await fireEvent.press(view.getByLabelText("実行方式"));
  await fireEvent.press(view.getByText("日時指定（毎日○時など）"));
  await fireEvent.changeText(view.getByLabelText("開始日"), "2026-11-16");
  await fireEvent.changeText(view.getByLabelText("実行時刻"), "09:00");
  await fireEvent.changeText(view.getByLabelText("タイムゾーン"), "Asia/Tokyo");
  await fireEvent.press(view.getByLabelText("定期実行設定を保存"));
  await view.findByText("保存しました。");
  expect(putMock).toHaveBeenLastCalledWith(expect.anything(), "main", 2, expect.objectContaining({ trigger:
    { kind: "calendar", startLocal: "2026-11-16T09:00:00", timeZone: "Asia/Tokyo", rrule: "FREQ=DAILY" } }));
  await fireEvent.press(view.getByLabelText("実行方式"));
  await fireEvent.press(view.getByText("間隔指定（○分ごと）"));
  await fireEvent.changeText(view.getByLabelText("実行間隔（分）"), "120");
  await fireEvent.press(view.getByLabelText("定期実行設定を保存"));
  await waitFor(() => expect(putMock).toHaveBeenLastCalledWith(expect.anything(), "main", 3, expect.objectContaining({ trigger: { kind: "interval", minutes: 120 } })));
});

test("invalid calendar response preserves the typed date and prompt for correction", async () => {
  getMock.mockResolvedValueOnce({ ...snapshot(), settings: { ...snapshot().settings, trigger:
    { kind: "calendar", startLocal: "2026-11-16T09:00:00", timeZone: "Asia/Tokyo", rrule: "FREQ=DAILY" } } });
  putMock.mockRejectedValueOnce(new CodexScheduleApiError("startLocal is not a real local date and time", 400, "invalid_codex_schedules"));
  const view = await render(<OrchestratorScheduleSettings {...props} />);
  await view.findByDisplayValue("09:00");
  await fireEvent.changeText(view.getByLabelText("開始日"), "2026-02-30");
  await fireEvent.changeText(view.getByLabelText("実行するプロンプト"), "Preserved draft");
  await fireEvent.press(view.getByLabelText("定期実行設定を保存"));
  await view.findByText("startLocal is not a real local date and time");
  expect(view.getByDisplayValue("2026-02-30")).toBeTruthy(); expect(view.getByDisplayValue("Preserved draft")).toBeTruthy();
  expect(getMock).toHaveBeenCalledTimes(1);
});
