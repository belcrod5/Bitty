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
  return { orchestratorId: owner, revision: 2, settings: { enabled: false, intervalMinutes: 60,
    prompt: `${owner} periodic prompt`, systemInstruction: "" }, nextOccurrenceAt: null,
    lastDispatch: null, legacyScheduleCount: 0, legacyEnabledCount: 0, legacyRecurrence: null };
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
    { enabled: false, intervalMinutes: 45, prompt: "Suggest something useful", systemInstruction: "Use one concise suggestion" });
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

test("discloses active legacy timers and calendar conversion, with prior skipped status", async () => {
  getMock.mockResolvedValueOnce({ ...snapshot(), legacyScheduleCount: 2, legacyEnabledCount: 2,
    legacyRecurrence: { startLocal: "2026-01-31T09:00:00", timeZone: "Asia/Tokyo", rrule: "FREQ=MONTHLY" },
    lastDispatch: { occurrenceAt: "2026-11-15T00:00:00.000Z", claimedAt: "2026-11-15T00:00:00.000Z",
      updatedAt: "2026-11-15T00:00:00.000Z", definitionHash: "a".repeat(64), status: "skipped", result: null,
      errorCode: "session_busy", errorMessage: "Busy" } });
  const view = await render(<OrchestratorScheduleSettings {...props} />);
  expect(await view.findByText(/旧設定2件（有効2件）/)).toBeTruthy();
  expect(view.getByText(/現在の旧日程：毎月/)).toBeTruthy();
  expect(view.getByText(/前回：スキップ（実行中・確認待ち）/)).toBeTruthy();
});
