import React from "react";
import { act, render } from "@testing-library/react-native";
import { OrchestratorStatusProvider } from "./OrchestratorStatusContext";

let mockCredentials = { runnerUrl: "https://runner", runnerToken: "never-export-this" };
let mockSnapshot = { connected: true, generation: 1, appState: "active" };
let mockDiagnostics = { codexCliStatusText: "5h limit: 80% left\nWeekly limit: 60% left", codexAuthProfileId: "first",
  codexCliStatusFetchedAtMs: Date.now(), codexAuthSwitching: false, codexUsageLimitReached: false };
const mockStatus = { activities: [], orchestrators: [{ id: "main", name: "メイン", icon: "" },
  { id: "developer", name: "開発", icon: "" }], selectedId: "developer" };
const mockPublish = jest.fn(async (_json: string) => undefined);
const mockHandlers = new Map<string, () => void>();
const mockRequest = jest.fn();
const mockManager = { request: mockRequest, subscribe: ({ op }: { op: string }, handler: () => void) => {
  mockHandlers.set(op, handler); return () => mockHandlers.delete(op);
} };
jest.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => ({ setSnapshot: (json: string) => mockPublish(json) }) }));
jest.mock("./ChatScreenContext", () => ({ useChatScreen: () => mockCredentials }));
jest.mock("./ChatDiagnosticsContext", () => ({ useChatDiagnostics: () => mockDiagnostics }));
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketSnapshot: () => mockSnapshot, useRunnerWebSocketManager: () => mockManager,
}));
jest.mock("../hooks/useOrchestratorActivities", () => ({ useOrchestratorActivities: () => mockStatus }));
jest.mock("../hooks/useRegisteredDirectoryActiveSessionCount", () => ({ useRegisteredDirectoryActiveSessionCount: () => 7 }));

const response = (text: string) => ({ op: "voice.history.result", payload: { orchestratorId: "main",
  messages: [{ text: "private conversation" }], taskChecklist: { status: "present", markdown: "private original" },
  taskChecklistOverview: { status: "present", markdown: text } } });
const latest = () => JSON.parse(mockPublish.mock.calls.at(-1)![0]);
const advance = async () => { await act(async () => { jest.advanceTimersByTime(600); }); };
beforeEach(() => {
  jest.useFakeTimers();
  mockPublish.mockClear(); mockRequest.mockReset(); mockHandlers.clear();
  mockCredentials = { runnerUrl: "https://runner", runnerToken: "never-export-this" };
  mockSnapshot = { connected: true, generation: 1, appState: "active" };
  mockDiagnostics = { codexCliStatusText: "5h limit: 80% left\nWeekly limit: 60% left", codexAuthProfileId: "first",
    codexCliStatusFetchedAtMs: Date.now(), codexAuthSwitching: false, codexUsageLimitReached: false };
  mockRequest.mockResolvedValue(response("- [ ] 全体の概要"));
});
afterEach(() => jest.useRealTimers());

test("publishes shared global metrics and plain-text overview without credentials or raw history", async () => {
  mockRequest.mockResolvedValue(response("## **今日**\n- [ ] 全体の概要\n- [x] 確認した"));
  const screen = await render(<OrchestratorStatusProvider>{null}</OrchestratorStatusProvider>);
  await advance();
  expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.history", payload: { orchestratorId: "main" } });
  expect(latest()).toMatchObject({ runningCount: 7, overview: "今日\n全体の概要\n確認した", selectedId: "developer",
    fiveHourRemaining: 80, weeklyRemaining: 60 });
  expect(JSON.stringify(latest())).not.toMatch(/never-export-this|https:|private conversation|private original/u);
  screen.unmount();
});

test("keeps last snapshot on background, but clears metrics on foreground disconnect", async () => {
  const screen = await render(<OrchestratorStatusProvider>{null}</OrchestratorStatusProvider>);
  await advance();
  const calls = mockPublish.mock.calls.length;
  mockSnapshot = { ...mockSnapshot, connected: false, appState: "background" };
  await screen.rerender(<OrchestratorStatusProvider>{null}</OrchestratorStatusProvider>);
  await advance();
  expect(mockPublish).toHaveBeenCalledTimes(calls);
  mockSnapshot = { ...mockSnapshot, appState: "active" };
  await screen.rerender(<OrchestratorStatusProvider>{null}</OrchestratorStatusProvider>);
  expect(latest()).toMatchObject({ connected: false, runningCount: null, overview: "", fiveHourRemaining: null });
  screen.unmount();
});

test("invalidates prior Runner requests and uses the source controller account snapshot", async () => {
  let finishOld!: (value: unknown) => void;
  mockRequest.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  const screen = await render(<OrchestratorStatusProvider>{null}</OrchestratorStatusProvider>);
  await advance();
  mockCredentials = { runnerUrl: "https://other", runnerToken: "new-token" };
  mockDiagnostics = { ...mockDiagnostics, codexCliStatusFetchedAtMs: 0 };
  await screen.rerender(<OrchestratorStatusProvider>{null}</OrchestratorStatusProvider>);
  await advance();
  await act(async () => { finishOld(response("OLD RUNNER")); });
  await advance();
  expect(latest().overview).toBe("全体の概要");
  expect(latest().fiveHourRemaining).toBeNull();
  mockDiagnostics = { ...mockDiagnostics, codexAuthProfileId: "second", codexAuthSwitching: true };
  await screen.rerender(<OrchestratorStatusProvider>{null}</OrchestratorStatusProvider>);
  await advance();
  expect(latest().fiveHourRemaining).toBeNull();
  mockDiagnostics = { ...mockDiagnostics, codexAuthSwitching: false, codexCliStatusFetchedAtMs: 1_577_836_800_000,
    codexCliStatusText: "5h limit: 95% left" };
  await screen.rerender(<OrchestratorStatusProvider>{null}</OrchestratorStatusProvider>);
  await advance();
  expect(latest().fiveHourRemaining).toBe(95);
  screen.unmount();
});


test.each([undefined, { status: "pending" }, { status: "unavailable" }])(
  "does not fall back to raw tasks or chat when the display overview is %j", async (overview) => {
    mockRequest.mockResolvedValue({ op: "voice.history.result", payload: { orchestratorId: "main",
      taskChecklistOverview: overview, taskChecklist: { status: "present", markdown: "PRIVATE ORIGINAL" },
      messages: [{ text: "PRIVATE CHAT" }] } });
    const screen = await render(<OrchestratorStatusProvider>{null}</OrchestratorStatusProvider>);
    await advance();
    expect(latest().overview).toBe("");
    expect(JSON.stringify(latest())).not.toContain("PRIVATE");
    screen.unmount();
  },
);
