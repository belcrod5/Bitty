import { act, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { SkiaBoardProvider, useSkiaBoard } from "./SkiaBoardContext";
import { fetchSkiaBoard, postSkiaBoardOps } from "../utils/skiaBoardRunnerApi";

const mockSnapshots = new Set<() => void>();
let mockCredentials = { runnerUrl: "http://runner", runnerToken: "token" };
let mockSnapshot = { connectionState: "connecting", generation: 0 };
const mockManager = {
  getSnapshot: () => mockSnapshot,
  subscribeSnapshot: (listener: () => void) => { mockSnapshots.add(listener); return () => { mockSnapshots.delete(listener); }; },
  subscribe: () => () => {},
};
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({ useRunnerWebSocketManager: () => mockManager }));
jest.mock("./ChatScreenContext", () => ({ useChatScreen: () => mockCredentials }));
jest.mock("./ConversationContext", () => ({ useConversation: () => ({ registeredDirectories: [] }) }));
jest.mock("../utils/skiaBoardRunnerApi", () => ({ fetchSkiaBoard: jest.fn(), postSkiaBoardOps: jest.fn(), syncSkiaBoardIngestDirectories: jest.fn() }));
jest.mock("../utils/persistedSettingsFile", () => ({
  readPersistedSettingsField: jest.fn(async () => null),
  mutatePersistedSettings: jest.fn(async () => {}),
}));

test("foreground reconnect defers board refresh until ready, while inactive return on a live socket still refreshes", async () => {
  const listeners = new Set<(state: AppStateStatus) => void>();
  const spy = jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    listeners.add(listener);
    return { remove: () => { listeners.delete(listener); } };
  });
  jest.mocked(fetchSkiaBoard).mockResolvedValue({ initialized: true, revision: 1,
    board: { cards: [], sections: [], excludedSessionIds: [], ingestedUpdatedAtMs: 0, cardTextScale: 1 } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <SkiaBoardProvider>{children}</SkiaBoardProvider>;
  const { unmount } = await renderHook(useSkiaBoard, { wrapper });
  jest.mocked(fetchSkiaBoard).mockClear();
  await act(async () => { listeners.forEach((listener) => listener("active")); });
  expect(fetchSkiaBoard).not.toHaveBeenCalled();
  await act(async () => {
    mockSnapshot = { connectionState: "ready", generation: 1 };
    mockSnapshots.forEach((listener) => listener());
  });
  expect(fetchSkiaBoard).toHaveBeenCalledTimes(1);
  await act(async () => { mockSnapshots.forEach((listener) => listener()); });
  expect(fetchSkiaBoard).toHaveBeenCalledTimes(1);
  await act(async () => { listeners.forEach((listener) => listener("active")); });
  expect(fetchSkiaBoard).toHaveBeenCalledTimes(2);
  await unmount();
  spy.mockRestore();
});


test("GET validators stay in their auth scope and an old response cannot populate the new cache", async () => {
  const listeners = new Set<(state: AppStateStatus) => void>();
  const spy = jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    listeners.add(listener); return { remove: () => { listeners.delete(listener); } };
  });
  let resolve!: (snapshot: Awaited<ReturnType<typeof fetchSkiaBoard>>) => void;
  mockSnapshot = { connectionState: "connecting", generation: 0 };
  mockCredentials = { runnerUrl: "http://old", runnerToken: "old-token" };
  const board = { cards: [], sections: [], excludedSessionIds: [], ingestedUpdatedAtMs: 0, cardTextScale: 1 };
  jest.mocked(fetchSkiaBoard).mockReset();
  jest.mocked(fetchSkiaBoard).mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
    .mockResolvedValue({ initialized: true, revision: 2, board, etag: "new-tag" });
  const wrapper = ({ children }: { children: React.ReactNode }) => <SkiaBoardProvider>{children}</SkiaBoardProvider>;
  const hook = await renderHook(useSkiaBoard, { wrapper });
  mockCredentials = { runnerUrl: "http://new", runnerToken: "new-token" };
  await hook.rerender(undefined);
  await act(async () => { resolve({ initialized: true, revision: 99, board, etag: "old-tag" }); });
  expect(jest.mocked(fetchSkiaBoard).mock.calls[1]).toEqual([mockCredentials, undefined]);
  await act(async () => { mockSnapshot = { connectionState: "ready", generation: 1 }; mockSnapshots.forEach((callback) => callback()); });
  expect(jest.mocked(fetchSkiaBoard).mock.calls.at(-1)?.[1]?.etag).toBe("new-tag");
  await hook.unmount(); spy.mockRestore();
});


test("a failed edit during local-to-cloud handover stays queued and retries without changing the GET cache scope", async () => {
  const callbacks = new Set<(state: AppStateStatus) => void>();
  const spy = jest.spyOn(AppState, "addEventListener").mockImplementation((_event, callback) => {
    callbacks.add(callback); return { remove: () => { callbacks.delete(callback); } };
  });
  mockCredentials = { runnerUrl: "http://local", runnerToken: "token" };
  mockSnapshot = { connectionState: "ready", generation: 1 };
  const board = { cards: [], sections: [], excludedSessionIds: [], ingestedUpdatedAtMs: 0, cardTextScale: 1 };
  jest.mocked(fetchSkiaBoard).mockReset();
  jest.mocked(fetchSkiaBoard).mockResolvedValue({ initialized: true, revision: 1, board, etag: "initial" });
  let reject!: (error: Error) => void;
  jest.mocked(postSkiaBoardOps).mockReset();
  jest.mocked(postSkiaBoardOps).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
    .mockResolvedValue({ status: "ok", snapshot: { initialized: true, revision: 2, board: { ...board,
      cards: [{ kind: "session", sessionId: "edited", backendId: "codex", directory: "/work", col: 0, row: 0 }] } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <SkiaBoardProvider>{children}</SkiaBoardProvider>;
  const hook = await renderHook(useSkiaBoard, { wrapper });
  await act(async () => { hook.result.current.addSession({ sessionId: "edited", backendId: "codex", directory: "/work" }); });
  mockCredentials = { runnerUrl: "https://cloud", runnerToken: "token" }; await hook.rerender(undefined);
  await act(async () => { reject(new Error("old route disconnected")); });
  await act(async () => { callbacks.forEach((callback) => callback("active")); });
  expect(postSkiaBoardOps).toHaveBeenCalledTimes(2);
  expect(jest.mocked(postSkiaBoardOps).mock.calls[1][0]).toEqual(mockCredentials);
  expect(jest.mocked(postSkiaBoardOps).mock.calls[1][1].ops).toEqual(jest.mocked(postSkiaBoardOps).mock.calls[0][1].ops);
  expect(hook.result.current.hasSession("edited")).toBe(true);
  await hook.unmount(); spy.mockRestore();
});
