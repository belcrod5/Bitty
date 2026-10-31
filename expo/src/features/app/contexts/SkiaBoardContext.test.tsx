import { act, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { SkiaBoardProvider, useSkiaBoard } from "./SkiaBoardContext";
import { fetchSkiaBoard } from "../utils/skiaBoardRunnerApi";

const mockSnapshots = new Set<() => void>();
let mockSnapshot = { connectionState: "connecting", generation: 0 };
const mockManager = {
  getSnapshot: () => mockSnapshot,
  subscribeSnapshot: (listener: () => void) => { mockSnapshots.add(listener); return () => { mockSnapshots.delete(listener); }; },
  subscribe: () => () => {},
};
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({ useRunnerWebSocketManager: () => mockManager }));
jest.mock("./ChatScreenContext", () => ({ useChatScreen: () => ({ runnerUrl: "http://runner", runnerToken: "token" }) }));
jest.mock("./ConversationContext", () => ({ useConversation: () => ({ registeredDirectories: [] }) }));
jest.mock("../utils/skiaBoardRunnerApi", () => ({ fetchSkiaBoard: jest.fn(), syncSkiaBoardIngestDirectories: jest.fn() }));
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
