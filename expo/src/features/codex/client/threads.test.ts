import { runCodexRpcSession } from "./rpcSession";
import { readCodexAppServerThread } from "./threads";

jest.mock("./rpcSession", () => ({
  ...jest.requireActual("./rpcSession"),
  runCodexRpcSession: jest.fn(),
}));

const mockRunCodexRpcSession = jest.mocked(runCodexRpcSession);

beforeEach(() => {
  mockRunCodexRpcSession.mockReset();
});

it("reads metadata without replaying saved turns", async () => {
  const rpc = jest.fn(async (method: string) => {
    if (method === "thread/read") return { thread: { id: "thread-1", status: "idle" } };
    throw new Error(method);
  });
  mockRunCodexRpcSession.mockImplementation(async (options) => options.run(rpc as any));

  const result = await readCodexAppServerThread({ wsUrl: "ws://runner", threadId: "thread-1" });

  expect(rpc).toHaveBeenNthCalledWith(1, "thread/read", {
    threadId: "thread-1",
    includeTurns: false,
  });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(result.messages).toEqual([]);
});

it("resumes a not-loaded thread without returning all turns", async () => {
  const rpc = jest.fn(async (method: string) => {
    if (method === "thread/read") throw new Error("thread not loaded: thread-1");
    if (method === "thread/resume") return {
      thread: { id: "thread-1", status: "idle" },
      initialTurnsPage: { data: [], nextCursor: null },
    };
    throw new Error(method);
  });
  mockRunCodexRpcSession.mockImplementation(async (options) => options.run(rpc as any));

  await readCodexAppServerThread({ wsUrl: "ws://runner", threadId: "thread-1" });

  expect(rpc).toHaveBeenCalledWith("thread/resume", {
    threadId: "thread-1",
    excludeTurns: true,
  });
  expect(rpc).not.toHaveBeenCalledWith("thread/turns/list", expect.anything());
});

it("keeps active state without loading turns", async () => {
  const rpc = jest.fn().mockResolvedValue({
    thread: { id: "thread-1", status: "active", updatedAt: "2026-07-01T00:00:00Z" },
  });
  mockRunCodexRpcSession.mockImplementation(async (options) => options.run(rpc as any));

  const result = await readCodexAppServerThread({ wsUrl: "ws://runner", threadId: "thread-1" });

  expect(result.hasRunningTurn).toBe(true);
  expect(result.runningTurn?.summary).toBe("応答生成中");
  expect(rpc).toHaveBeenCalledTimes(1);
});
