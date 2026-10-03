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

test("requests the Runner's registered directory count and refreshes after shared execution changes", async () => {
  const hook = await renderHook(() => useRegisteredDirectoryActiveSessionCount());
  await waitFor(() => expect(hook.result.current).toBe(2));
  expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
    op: "sessions.active-count",
  }), expect.any(Object));
  expect(mockRequest.mock.calls[0][0]).not.toHaveProperty("payload");
  mockRequest.mockResolvedValue(result(3));
  await act(async () => { mockHandlers.get("sessions_active_changed")?.({}); });
  await waitFor(() => expect(hook.result.current).toBe(3));
  hook.unmount();
});

test("coalesces lifecycle changes across a slow in-memory count request", async () => {
  let finishFirst!: (value: unknown) => void;
  mockRequest.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
  const hook = await renderHook(() => useRegisteredDirectoryActiveSessionCount());
  mockRequest.mockResolvedValue(result(5));
  await act(async () => {
    mockHandlers.get("sessions_active_changed")?.({});
    mockHandlers.get("sessions_active_changed")?.({});
    mockHandlers.get("sessions_active_changed")?.({});
  });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await act(async () => { finishFirst(result(4)); });
  await waitFor(() => expect(hook.result.current).toBe(5));
  expect(mockRequest).toHaveBeenCalledTimes(2);
  await act(async () => { mockHandlers.get("sessions_active_changed")?.({}); });
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
  await act(async () => { mockHandlers.get("sessions_active_changed")?.({}); });
  await waitFor(() => expect(hook.result.current).toBeNull());
  mockDirectories = [];
  mockRequest.mockResolvedValueOnce(result(0));
  await hook.rerender({ version: 2 });
  await waitFor(() => expect(hook.result.current).toBe(0));
  hook.unmount();
});
