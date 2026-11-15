import type { ReactNode } from "react";
import { Text } from "react-native";
import { act, render, renderHook, waitFor } from "@testing-library/react-native";
import { RegisteredDirectoryActiveSessionCountProvider, useRegisteredDirectoryActiveSessionCount } from "./useRegisteredDirectoryActiveSessionCount";

let mockDirectories = [{ path: "/one" }, { path: "/two" }];
let mockAppState = "active";
let mockConnected = true;
let mockGeneration = 1;
const mockHandlers = new Map<string, (message: { payload?: unknown }) => void>();
const mockRequest = jest.fn();
const mockManager = {
  request: mockRequest,
  subscribe: jest.fn(({ op }: { op: string }, handler: (message: { payload?: unknown }) => void) => {
    mockHandlers.set(op, handler);
    return () => { mockHandlers.delete(op); };
  }),
};

jest.mock("../contexts/ConversationContext", () => ({ useConversation: () => ({ registeredDirectories: mockDirectories }) }));
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketSnapshot: () => ({ connected: mockConnected, generation: mockGeneration, appState: mockAppState }),
  useRunnerWebSocketManager: () => mockManager,
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <RegisteredDirectoryActiveSessionCountProvider>{children}</RegisteredDirectoryActiveSessionCountProvider>
);
const result = (count: unknown) => ({ op: "sessions.active-count.result", payload: { count } });

beforeEach(() => {
  mockDirectories = [{ path: "/one" }, { path: "/two" }];
  mockAppState = "active";
  mockConnected = true;
  mockGeneration = 1;
  mockHandlers.clear();
  mockManager.subscribe.mockClear();
  mockRequest.mockReset();
  mockRequest.mockResolvedValue(result(2));
});

afterEach(() => jest.restoreAllMocks());

test("requests the Runner's registered directory count and refreshes after shared execution changes", async () => {
  const hook = await renderHook(() => useRegisteredDirectoryActiveSessionCount(), { wrapper });
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
  const hook = await renderHook(() => useRegisteredDirectoryActiveSessionCount(), { wrapper });
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
  }, { initialProps: { version: 0 }, wrapper });
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


test("refreshes on foreground and reports unknown while backgrounded", async () => {
  const hook = await renderHook(({ version }: { version: number }) => {
    void version;
    return useRegisteredDirectoryActiveSessionCount();
  }, { initialProps: { version: 0 }, wrapper });
  await waitFor(() => expect(hook.result.current).toBe(2));
  mockAppState = "background";
  await hook.rerender({ version: 1 });
  expect(hook.result.current).toBeNull();
  expect(mockHandlers.has("sessions_active_changed")).toBe(false);
  mockAppState = "active";
  mockRequest.mockResolvedValue(result(4));
  await hook.rerender({ version: 2 });
  await waitFor(() => expect(hook.result.current).toBe(4));
  hook.unmount();
});


test("inactive does not trigger an extra request before the foreground revalidation", async () => {
  const hook = await renderHook(({ version }: { version: number }) => {
    void version; return useRegisteredDirectoryActiveSessionCount();
  }, { initialProps: { version: 0 }, wrapper });
  await waitFor(() => expect(hook.result.current).toBe(2));
  const requests = mockRequest.mock.calls.length;
  mockAppState = "inactive"; await hook.rerender({ version: 1 });
  expect(mockRequest).toHaveBeenCalledTimes(requests);
  mockAppState = "active"; await hook.rerender({ version: 2 });
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(requests + 1));
  await hook.unmount();
});

test("shares one request and subscription across the board and chat", async () => {
  function Consumer({ name }: { name: string }) {
    const count = useRegisteredDirectoryActiveSessionCount();
    return <Text testID={name}>{count ?? "--"}</Text>;
  }
  const content = (chatOpen: boolean) => (
    <RegisteredDirectoryActiveSessionCountProvider>
      <Consumer name="board" />
      {chatOpen ? <Consumer name="chat" /> : null}
    </RegisteredDirectoryActiveSessionCountProvider>
  );
  const screen = await render(content(true));
  await waitFor(() => expect(screen.getByTestId("chat").props.children).toBe(2));
  expect(screen.getByTestId("board").props.children).toBe(2);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockManager.subscribe).toHaveBeenCalledTimes(1);
  await screen.rerender(content(false));
  await screen.rerender(content(true));
  expect(screen.getByTestId("chat").props.children).toBe(2);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockManager.subscribe).toHaveBeenCalledTimes(1);
  mockRequest.mockResolvedValue(result(4));
  await act(async () => { mockHandlers.get("sessions_active_changed")?.({}); });
  await waitFor(() => expect(screen.getByTestId("board").props.children).toBe(4));
  expect(screen.getByTestId("chat").props.children).toBe(4);
  expect(mockRequest).toHaveBeenCalledTimes(2);
  await screen.unmount();
  expect(mockHandlers.size).toBe(0);
});
