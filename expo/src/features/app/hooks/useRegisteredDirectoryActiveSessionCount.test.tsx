import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useRegisteredDirectoryActiveSessionCount } from "./useRegisteredDirectoryActiveSessionCount";

let mockDirectories = [{ path: "/one" }, { path: "/two" }];
let mockActiveScreen = "skia_board";
let mockConnected = true;
let mockGeneration = 1;
const mockHandlers = new Map<string, (message: { payload?: unknown }) => void>();
const mockRequest = jest.fn();
const mockManager = {
  request: mockRequest,
  subscribe: ({ op }: { op: string }, handler: (message: { payload?: unknown }) => void) => {
    mockHandlers.set(op, handler);
    return () => { mockHandlers.delete(op); };
  },
};

jest.mock("../contexts/AppShellContext", () => ({ useAppShell: () => ({ activeScreen: mockActiveScreen }) }));
jest.mock("../contexts/ConversationContext", () => ({ useConversation: () => ({ registeredDirectories: mockDirectories }) }));
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketSnapshot: () => ({ connected: mockConnected, generation: mockGeneration }),
  useRunnerWebSocketManager: () => mockManager,
}));

const result = (count: unknown) => ({ op: "sessions.active-count.result", payload: { count } });

beforeEach(() => {
  mockDirectories = [{ path: "/one" }, { path: "/two" }];
  mockActiveScreen = "skia_board";
  mockConnected = true;
  mockGeneration = 1;
  mockHandlers.clear();
  mockRequest.mockReset();
  mockRequest.mockResolvedValue(result(2));
});

afterEach(() => jest.restoreAllMocks());

test("requests all registered directories and refreshes after run lifecycle events", async () => {
  const hook = await renderHook(() => useRegisteredDirectoryActiveSessionCount());
  await waitFor(() => expect(hook.result.current).toBe(2));
  expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
    op: "sessions.active-count", payload: { cwds: ["/one", "/two"] },
  }), expect.any(Object));
  mockRequest.mockResolvedValue(result(3));
  await act(async () => { mockHandlers.get("event")?.({ payload: { type: "turn.completed" } }); });
  await waitFor(() => expect(hook.result.current).toBe(3));
  hook.unmount();
});

test("a slow scan is not displaced by reconciliation ticks and queues one lifecycle refresh", async () => {
  let reconcile!: () => void;
  jest.spyOn(global, "setInterval").mockImplementation((handler, delay) => {
    if (delay === 30_000) reconcile = handler as () => void;
    return 1 as unknown as ReturnType<typeof setInterval>;
  });
  let finishFirst!: (value: unknown) => void;
  mockRequest.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
  const hook = await renderHook(() => useRegisteredDirectoryActiveSessionCount());
  await act(async () => { reconcile(); reconcile(); reconcile(); });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await act(async () => { finishFirst(result(4)); });
  expect(hook.result.current).toBe(4);
  mockRequest.mockResolvedValue(result(5));
  let finishSecond!: (value: unknown) => void;
  mockRequest.mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve; }));
  await act(async () => { mockHandlers.get("event")?.({ payload: { type: "turn.started" } }); });
  await act(async () => { mockHandlers.get("event")?.({ payload: { type: "turn.completed" } }); });
  expect(mockRequest).toHaveBeenCalledTimes(2);
  await act(async () => { finishSecond(result(4)); });
  await act(async () => { await Promise.resolve(); });
  expect(mockRequest).toHaveBeenCalledTimes(3);
  expect(hook.result.current).toBe(5);
  hook.unmount();
});

test("ignores old-directory responses and displays unknown on failure", async () => {
  let finishOld!: (value: unknown) => void;
  mockRequest.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  const hook = await renderHook(({ version }: { version: number }) => {
    void version;
    return useRegisteredDirectoryActiveSessionCount();
  }, { initialProps: { version: 0 } });
  mockDirectories = [{ path: "/new" }];
  mockRequest.mockResolvedValueOnce(result(1));
  await hook.rerender({ version: 1 });
  await waitFor(() => expect(hook.result.current).toBe(1));
  await act(async () => { finishOld(result(9)); });
  expect(hook.result.current).toBe(1);
  mockRequest.mockRejectedValueOnce(new Error("offline"));
  await act(async () => { mockHandlers.get("event")?.({ payload: { type: "turn.failed" } }); });
  await waitFor(() => expect(hook.result.current).toBeNull());
  mockDirectories = [];
  await hook.rerender({ version: 2 });
  expect(hook.result.current).toBe(0);
  hook.unmount();
});
