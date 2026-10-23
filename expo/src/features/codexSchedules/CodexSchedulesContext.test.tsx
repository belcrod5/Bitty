import { useEffect } from "react";
import { AppState, Text, type AppStateStatus } from "react-native";
import { act, render } from "@testing-library/react-native";
import { CodexSchedulesProvider, useCodexSchedules } from "./CodexSchedulesContext";
import { getCodexSchedules, putCodexSchedules } from "./codexScheduleApi";
import type { CodexSchedule, CodexScheduleSnapshot } from "./codexScheduleTypes";

jest.mock("./codexScheduleApi", () => ({ getCodexSchedules: jest.fn(), putCodexSchedules: jest.fn() }));
const mockGet = jest.mocked(getCodexSchedules);
const mockPut = jest.mocked(putCodexSchedules);
const auth = { runnerUrl: "http://runner", runnerToken: "token" };
let current: ReturnType<typeof useCodexSchedules>;
let onAppState: (state: AppStateStatus) => void;
const mounted = jest.fn();
const originalAppState = Object.getOwnPropertyDescriptor(AppState, "currentState")!;

function Probe() {
  current = useCodexSchedules();
  useEffect(() => { mounted(); }, []);
  return <Text>{[...current.scheduledThreadIds].sort().join(",") || "none"}</Text>;
}

function schedule(threadId: string | null, overrides: Partial<CodexSchedule> = {}): CodexSchedule {
  return {
    id: String(threadId), name: "", enabled: true, startLocal: "2026-10-24T09:00:00",
    timeZone: "Asia/Tokyo", rrule: null,
    action: { kind: "llm", cwd: "/work", modelRef: "openai-codex/gpt-6.1", reasoningEffort: "low", prompt: "Check", threadId },
    nextOccurrenceAt: "2026-10-24T00:00:00.000Z", lastDispatch: null, ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
  jest.clearAllMocks();
  Object.defineProperty(AppState, "currentState", { configurable: true, value: "active", writable: true });
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    onAppState = listener;
    return { remove: jest.fn() };
  });
  mockGet.mockResolvedValue({ revision: 0, schedules: [] });
});

afterEach(() => {
  Object.defineProperty(AppState, "currentState", originalAppState);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test("uses only enabled future LLM schedules targeting an existing thread", async () => {
  mockGet.mockResolvedValue({ revision: 1, schedules: [
    schedule("once"), schedule("repeat", { rrule: "FREQ=DAILY" }), schedule("once"),
    schedule("disabled", { enabled: false }), schedule("done", { nextOccurrenceAt: null }),
    schedule("past", { nextOccurrenceAt: "2026-10-22T00:00:00.000Z" }),
    schedule(null, { lastDispatch: { occurrenceAt: "2026-10-22T00:00:00.000Z", claimedAt: "", definitionHash: "",
      status: "fired", result: { kind: "llm", threadId: "created-thread", turnId: "turn" }, errorCode: "", errorMessage: "", updatedAt: "" } }),
    schedule("script", { action: { kind: "script", cwd: "/work", scriptPath: "/work/check.sh" } }),
    schedule("voice", { action: { kind: "voice", orchestratorId: "main", prompt: "Check" } }),
  ] });
  const view = await render(<CodexSchedulesProvider {...auth}><Probe /><Probe /></CodexSchedulesProvider>);
  expect(view.getAllByText("once,repeat")).toHaveLength(2);
  expect(mockGet).toHaveBeenCalledTimes(1);
});

test("publishes a save immediately and ignores an older pending read", async () => {
  const old = deferred<CodexScheduleSnapshot>();
  mockGet.mockReturnValueOnce(old.promise);
  mockPut.mockResolvedValue({ revision: 2, schedules: [schedule("saved")] });
  const view = await render(<CodexSchedulesProvider {...auth}><Probe /></CodexSchedulesProvider>);
  await act(async () => { await current.save(1, [schedule("saved")]); });
  expect(view.getByText("saved")).toBeTruthy();
  await act(async () => { old.resolve({ revision: 1, schedules: [] }); });
  expect(view.getByText("saved")).toBeTruthy();
});

test("a failed save releases an old pending read so the next refresh can recover", async () => {
  const old = deferred<CodexScheduleSnapshot>();
  mockGet.mockReturnValueOnce(old.promise);
  mockPut.mockRejectedValueOnce(new Error("conflict"));
  const view = await render(<CodexSchedulesProvider {...auth}><Probe /></CodexSchedulesProvider>);
  await act(async () => { await expect(current.save(1, [])).rejects.toThrow("conflict"); });
  mockGet.mockResolvedValueOnce({ revision: 2, schedules: [schedule("latest")] });
  await act(async () => { await current.refresh(); });
  await act(async () => { old.resolve({ revision: 1, schedules: [schedule("stale")] }); });
  expect(view.getByText("latest")).toBeTruthy();
});

test("expires the clock at the next occurrence and adopts the Runner's next recurrence", async () => {
  mockGet.mockResolvedValueOnce({ revision: 1, schedules: [schedule("repeat", {
    rrule: "FREQ=DAILY", nextOccurrenceAt: "2026-10-23T00:00:01.000Z",
  })] });
  const next = deferred<CodexScheduleSnapshot>();
  mockGet.mockReturnValueOnce(next.promise);
  const view = await render(<CodexSchedulesProvider {...auth}><Probe /></CodexSchedulesProvider>);
  expect(view.getByText("repeat")).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(1001); });
  expect(view.getByText("none")).toBeTruthy();
  await act(async () => { next.resolve({ revision: 1, schedules: [schedule("repeat", { rrule: "FREQ=DAILY" })] }); });
  expect(view.getByText("repeat")).toBeTruthy();
  expect(mockGet).toHaveBeenCalledTimes(2);
});

test("refreshes external changes while active and on foreground return", async () => {
  const view = await render(<CodexSchedulesProvider {...auth}><Probe /></CodexSchedulesProvider>);
  mockGet.mockResolvedValue({ revision: 1, schedules: [schedule("external")] });
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(view.getByText("external")).toBeTruthy();
  AppState.currentState = "background";
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(mockGet).toHaveBeenCalledTimes(2);
  mockGet.mockResolvedValue({ revision: 2, schedules: [] });
  Object.defineProperty(AppState, "currentState", { configurable: true, value: "active", writable: true });
  await act(async () => { onAppState("active"); });
  expect(view.getByText("none")).toBeTruthy();
});

test("Runner changes clear the old scope, ignore old responses and preserve child mounts", async () => {
  const old = deferred<CodexScheduleSnapshot>();
  mockGet.mockResolvedValueOnce({ revision: 1, schedules: [schedule("runner-a")] });
  const view = await render(<CodexSchedulesProvider {...auth}><Probe /></CodexSchedulesProvider>);
  expect(view.getByText("runner-a")).toBeTruthy();
  mockGet.mockReturnValueOnce(old.promise);
  await view.rerender(<CodexSchedulesProvider {...auth} runnerToken="other"><Probe /></CodexSchedulesProvider>);
  expect(view.getByText("none")).toBeTruthy();
  mockGet.mockResolvedValueOnce({ revision: 2, schedules: [schedule("runner-a-new")] });
  await view.rerender(<CodexSchedulesProvider {...auth}><Probe /></CodexSchedulesProvider>);
  await act(async () => { old.resolve({ revision: 9, schedules: [schedule("runner-b")] }); });
  expect(view.getByText("runner-a-new")).toBeTruthy();
  expect(mounted).toHaveBeenCalledTimes(1);
});

test("an old response stays invalid after returning to the same Runner credentials", async () => {
  const old = deferred<CodexScheduleSnapshot>();
  mockGet.mockReturnValueOnce(old.promise);
  const view = await render(<CodexSchedulesProvider {...auth}><Probe /></CodexSchedulesProvider>);
  await view.rerender(<CodexSchedulesProvider {...auth} runnerToken="other"><Probe /></CodexSchedulesProvider>);
  mockGet.mockResolvedValueOnce({ revision: 2, schedules: [schedule("latest")] });
  await view.rerender(<CodexSchedulesProvider {...auth}><Probe /></CodexSchedulesProvider>);
  await act(async () => { old.resolve({ revision: 1, schedules: [schedule("stale")] }); });
  expect(view.getByText("latest")).toBeTruthy();
  expect(mounted).toHaveBeenCalledTimes(1);
});

test("failed reads retain known schedules and concurrent refreshes share one request", async () => {
  mockGet.mockResolvedValueOnce({ revision: 1, schedules: [schedule("known")] });
  const view = await render(<CodexSchedulesProvider {...auth}><Probe /></CodexSchedulesProvider>);
  mockGet.mockRejectedValueOnce(new Error("offline"));
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(view.getByText("known")).toBeTruthy();
  const next = deferred<CodexScheduleSnapshot>();
  mockGet.mockReturnValueOnce(next.promise);
  await act(async () => {
    const first = current.refresh();
    expect(current.refresh()).toBe(first);
    next.resolve({ revision: 2, schedules: [] });
    await first;
  });
  expect(view.getByText("none")).toBeTruthy();
  expect(mockGet).toHaveBeenCalledTimes(3);
});
