import { act, renderHook, waitFor } from "@testing-library/react-native";
import { Alert, AppState } from "react-native";
import { useRunnerClientState } from "./useRunnerClientState";
const originalAppState = AppState.currentState;
const sessionKey = JSON.stringify(["codex", "session-1"]);
const directory = { id: "dir-1", path: "/work", displayName: "Work", markerColor: "green" as const };
let server: {
  revision: number;
  titleModelId: string;
  titleReasoningEffort: string;
  directories: typeof directory[];
  sessions: Record<string, { title: string; markerColor: string; note?: string }>;
  composerHistory: string[];
  drafts: Record<string, { text: string; updatedAt: number }>;
};
let operations: Record<string, unknown>[];

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  server = { revision: 0, titleModelId: "gpt-6-luna", titleReasoningEffort: "low", directories: [], sessions: {}, composerHistory: [], drafts: {} };
  operations = [];
  jest.spyOn(AppState, "addEventListener").mockReturnValue({ remove: jest.fn() } as never);
  global.fetch = jest.fn(async (_url, init) => {
    const operation = init?.body ? JSON.parse(String(init.body)).operation : null;
    if (operation) {
      operations.push(operation);
      if (operation.type === "composer.append") {
        server.composerHistory.unshift(operation.text);
        server.revision++;
      } else if (operation.type === "title-settings.set") {
        server.titleModelId = operation.modelId;
        server.titleReasoningEffort = operation.reasoningEffort;
        server.revision++;
      } else if (operation.type === "session.set") {
        const key = JSON.stringify([operation.backendId, operation.sessionId]);
        server.sessions[key] = { ...(server.sessions[key] || { title: "", markerColor: "none" }), note: operation.note };
        server.revision++;
      } else if (operation.type === "draft.set") {
        const key = JSON.stringify([operation.backendId, operation.sessionId]);
        if (operation.text) server.drafts[key] = { text: operation.text, updatedAt: Date.now() };
        else delete server.drafts[key];
        server.revision++;
      }
    }
    return { ok: true, status: 200, json: async () => ({ snapshot: JSON.parse(JSON.stringify(server)) }) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  AppState.currentState = originalAppState;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function renderState() {
  const setRegisteredDirectories = jest.fn();
  const setSessionTitleOverridesById = jest.fn();
  const setSessionMarkerColorsById = jest.fn();
  const hook = await renderHook(() => useRunnerClientState({
    settingsLoaded: true,
    runnerUrl: "http://runner.test",
    localRunnerUrl: "",
    cloudflareRunnerUrl: "",
    runnerToken: "token",
    backendId: "codex",
    setRegisteredDirectories,
    setSessionTitleOverridesById,
    setSessionMarkerColorsById,
  }));
  return { ...hook, setRegisteredDirectories, setSessionTitleOverridesById };
}

test("loads Runner state without sending a migration operation", async () => {
  server.sessions[sessionKey] = { title: "Runner title", markerColor: "red" };
  server.directories = [directory];
  const { result, setRegisteredDirectories, setSessionTitleOverridesById } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(result.current.titleModelId).toBe("gpt-6-luna");
  expect(result.current.titleReasoningEffort).toBe("low");
  expect(operations).toEqual([]);
  expect(setRegisteredDirectories).toHaveBeenCalledWith(expect.any(Function));
  expect(setSessionTitleOverridesById).toHaveBeenCalledWith({ [sessionKey]: "Runner title" });
});

test("15-second polling revalidates cached state and applies another device's update at the same revision", async () => {
  AppState.currentState = "active";
  let etag = '"original"';
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async (url, init) => {
    if ((init?.headers as Record<string, string>)["if-none-match"] === etag) {
      return { status: 304, ok: false, headers: { get: () => etag } } as unknown as Response;
    }
    const response = await originalFetch(url, init);
    return { ...response, headers: { get: () => etag } } as unknown as Response;
  }) as typeof fetch;
  server.sessions[sessionKey] = { title: "Before restore", markerColor: "red" };
  const { result, setSessionTitleOverridesById } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  const applications = setSessionTitleOverridesById.mock.calls.length;
  const requests = (global.fetch as jest.Mock).mock.calls.length;
  await act(async () => { jest.advanceTimersByTime(15_000); });
  await act(async () => Promise.resolve());
  expect(global.fetch).toHaveBeenCalledTimes(requests + 1);
  expect(setSessionTitleOverridesById).toHaveBeenCalledTimes(applications);

  server.sessions[sessionKey].title = "Restored on another device";
  etag = '"restored"';
  await act(async () => { jest.advanceTimersByTime(15_000); });
  await waitFor(() => expect(setSessionTitleOverridesById).toHaveBeenLastCalledWith({ [sessionKey]: "Restored on another device" }));
  expect(server.revision).toBe(0);
});

test("shows GPT-6 Luna/low for an older empty title setting", async () => {
  server.titleModelId = "";
  server.titleReasoningEffort = "high";
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(result.current.titleModelId).toBe("gpt-6-luna");
  expect(result.current.titleReasoningEffort).toBe("low");
  expect(operations).toEqual([]);
});
test("stores the title model and effort independently of main chat settings", async () => {
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  await act(async () => result.current.changeTitleSettings("gpt-6.1-luna", "medium"));
  await waitFor(() => expect(server.titleModelId).toBe("gpt-6.1-luna"));
  expect(result.current.titleModelId).toBe("gpt-6.1-luna");
  expect(result.current.titleReasoningEffort).toBe("medium");
  expect(operations).toEqual([{ type: "title-settings.set", modelId: "gpt-6.1-luna", reasoningEffort: "medium" }]);
});
test("history and drafts use item operations instead of replacing other devices' state", async () => {
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  await act(async () => result.current.recordMessage("hello"));
  await waitFor(() => expect(server.composerHistory).toEqual(["hello"]));
  jest.useFakeTimers();
  await act(async () => result.current.setDraft("session-1", "working", "codex"));
  await act(async () => { jest.advanceTimersByTime(300); });
  await act(async () => Promise.resolve());
  expect(server.drafts[sessionKey].text).toBe("working");
  expect(operations.map((operation) => operation.type)).toEqual(["composer.append", "draft.set"]);
});

test("clears only the accepted backend's draft when session IDs match", async () => {
  const codexKey = JSON.stringify(["codex", "shared"]);
  const claudeKey = JSON.stringify(["claude", "shared"]);
  server.drafts[codexKey] = { text: "keep Codex", updatedAt: 1 };
  server.drafts[claudeKey] = { text: "sent Claude", updatedAt: 2 };
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));

  await act(async () => result.current.clearDraft("shared", "claude"));
  await waitFor(() => expect(server.drafts[claudeKey]).toBeUndefined());
  expect(server.drafts[codexKey]?.text).toBe("keep Codex");
  expect(result.current.drafts).toEqual(expect.arrayContaining([
    expect.objectContaining({ backendId: "codex", sessionId: "shared", text: "keep Codex" }),
  ]));
});

test("queued mutations and debounced drafts stay with the Runner selected when they were made", async () => {
  const requests: { url: string; operation: Record<string, unknown> | null }[] = [];
  const fetchImpl = global.fetch;
  global.fetch = jest.fn(async (url, init) => {
    requests.push({ url: String(url), operation: init?.body ? JSON.parse(String(init.body)).operation : null });
    return fetchImpl(url, init);
  }) as typeof fetch;
  const props = {
    settingsLoaded: true, runnerUrl: "http://old-runner.test", localRunnerUrl: "", cloudflareRunnerUrl: "",
    runnerToken: "token", backendId: "codex",
    setRegisteredDirectories: jest.fn(), setSessionTitleOverridesById: jest.fn(), setSessionMarkerColorsById: jest.fn(),
  };
  const { result, rerender } = await renderHook((options: typeof props) => useRunnerClientState(options), {
    initialProps: props,
  });
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  await act(async () => {
    result.current.mutate({ type: "session.set", backendId: "codex", sessionId: "one", title: "Old Runner" });
    result.current.setDraft("one", "unfinished", "codex");
    await rerender({ ...props, runnerUrl: "http://new-runner.test" });
  });
  await act(async () => { jest.advanceTimersByTime(300); });
  await waitFor(() => expect(requests.filter((item) => item.operation?.type === "draft.set")).toHaveLength(1));
  expect(requests.filter((item) => item.operation?.type === "session.set" || item.operation?.type === "draft.set")
    .every((item) => item.url.startsWith("http://old-runner.test/"))).toBe(true);
});

test("editing the same draft after switching Runner still flushes the old Runner's pending text", async () => {
  const requests: { url: string; operation: Record<string, unknown> | null }[] = [];
  const fetchImpl = global.fetch;
  global.fetch = jest.fn(async (url, init) => {
    requests.push({ url: String(url), operation: init?.body ? JSON.parse(String(init.body)).operation : null });
    return fetchImpl(url, init);
  }) as typeof fetch;
  const props = {
    settingsLoaded: true, runnerUrl: "http://old-runner.test", localRunnerUrl: "", cloudflareRunnerUrl: "",
    runnerToken: "token", backendId: "codex",
    setRegisteredDirectories: jest.fn(), setSessionTitleOverridesById: jest.fn(), setSessionMarkerColorsById: jest.fn(),
  };
  const { result, rerender } = await renderHook((options: typeof props) => useRunnerClientState(options), {
    initialProps: props,
  });
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  await act(async () => result.current.setDraft("session-1", "old text"));
  await rerender({ ...props, runnerUrl: "http://new-runner.test" });
  await act(async () => result.current.setDraft("session-1", "new text"));
  await act(async () => { jest.advanceTimersByTime(300); });
  await waitFor(() => expect(requests.filter((item) => item.operation?.type === "draft.set")).toHaveLength(2));
  expect(requests.filter((item) => item.operation?.type === "draft.set").map((item) => [
    item.url, item.operation?.text,
  ])).toEqual([
    ["http://old-runner.test/client-state", "old text"],
    ["http://new-runner.test/client-state", "new text"],
  ]);
});

test("switching to an unreachable different Runner clears visible shared state and drafts", async () => {
  server.directories = [directory];
  server.sessions[sessionKey] = { title: "Old title", markerColor: "green" };
  server.drafts[sessionKey] = { text: "Old draft", updatedAt: 1 };
  const oldFetch = global.fetch;
  global.fetch = jest.fn((url, init) => String(url).startsWith("http://new-runner.test/")
    ? Promise.reject(new Error("offline")) : oldFetch(url, init)) as typeof fetch;
  const props = {
    settingsLoaded: true, runnerUrl: "http://runner.test", localRunnerUrl: "", cloudflareRunnerUrl: "",
    runnerToken: "token", backendId: "codex",
    setRegisteredDirectories: jest.fn(), setSessionTitleOverridesById: jest.fn(), setSessionMarkerColorsById: jest.fn(),
  };
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const { result, rerender } = await renderHook((options: typeof props) => useRunnerClientState(options), { initialProps: props });
  await waitFor(() => expect(result.current.drafts[0]?.text).toBe("Old draft"));

  await rerender({ ...props, runnerUrl: "http://new-runner.test" });
  await waitFor(() => expect(warn).toHaveBeenCalled());
  expect(result.current.draftsLoaded).toBe(false);
  expect(result.current.drafts).toEqual([]);
  expect(result.current.messages).toEqual([]);
  expect(props.setRegisteredDirectories).toHaveBeenLastCalledWith([]);
  expect(props.setSessionTitleOverridesById).toHaveBeenLastCalledWith({});
});

test("changing the token on the same URL also clears the previous Runner's draft", async () => {
  server.drafts[sessionKey] = { text: "Old account draft", updatedAt: 1 };
  const oldFetch = global.fetch;
  global.fetch = jest.fn((url, init) => init?.headers
    && (init.headers as Record<string, string>).authorization === "Bearer new-token"
    ? Promise.reject(new Error("unauthorized")) : oldFetch(url, init)) as typeof fetch;
  const props = {
    settingsLoaded: true, runnerUrl: "http://runner.test", localRunnerUrl: "", cloudflareRunnerUrl: "",
    runnerToken: "token", backendId: "codex",
    setRegisteredDirectories: jest.fn(), setSessionTitleOverridesById: jest.fn(), setSessionMarkerColorsById: jest.fn(),
  };
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const { result, rerender } = await renderHook((options: typeof props) => useRunnerClientState(options), { initialProps: props });
  await waitFor(() => expect(result.current.drafts[0]?.text).toBe("Old account draft"));
  await rerender({ ...props, runnerToken: "new-token" });
  await waitFor(() => expect(warn).toHaveBeenCalled());
  expect(result.current.drafts).toEqual([]);
  expect(result.current.draftsLoaded).toBe(false);
});

test("a debounced draft follows the healthy route of the same Runner", async () => {
  const requests: { url: string; operation: Record<string, unknown> | null }[] = [];
  const oldFetch = global.fetch;
  global.fetch = jest.fn(async (url, init) => {
    requests.push({ url: String(url), operation: init?.body ? JSON.parse(String(init.body)).operation : null });
    if (String(url).startsWith("http://local.test/") && init?.body) throw new Error("local route unavailable");
    return oldFetch(url, init);
  }) as typeof fetch;
  const props = {
    settingsLoaded: true, runnerUrl: "http://local.test", localRunnerUrl: "http://local.test",
    cloudflareRunnerUrl: "https://cloudflare.test", runnerToken: "token", backendId: "codex",
    setRegisteredDirectories: jest.fn(),
    setSessionTitleOverridesById: jest.fn(), setSessionMarkerColorsById: jest.fn(),
  };
  const { result, rerender } = await renderHook((options: typeof props) => useRunnerClientState(options), { initialProps: props });
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  await act(async () => result.current.setDraft("session-1", "unfinished"));
  await rerender({ ...props, runnerUrl: "https://cloudflare.test" });
  expect(result.current.drafts[0]?.text).toBe("unfinished");
  await act(async () => { jest.advanceTimersByTime(300); });
  await waitFor(() => expect(server.drafts[sessionKey]?.text).toBe("unfinished"));
  expect(requests.filter((item) => item.operation?.type === "draft.set").map((item) => item.url))
    .toEqual(["https://cloudflare.test/client-state"]);
});

test("a failed draft write is retried when the same Runner changes route", async () => {
  const oldFetch = global.fetch;
  const requests: string[] = [];
  global.fetch = jest.fn(async (url, init) => {
    if (init?.body && JSON.parse(String(init.body)).operation?.type === "draft.set") {
      requests.push(String(url));
      if (String(url).startsWith("http://local.test/")) throw new Error("local route unavailable");
    }
    return oldFetch(url, init);
  }) as typeof fetch;
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const props = {
    settingsLoaded: true, runnerUrl: "http://local.test", localRunnerUrl: "http://local.test",
    cloudflareRunnerUrl: "https://cloudflare.test", runnerToken: "token", backendId: "codex",
    setRegisteredDirectories: jest.fn(),
    setSessionTitleOverridesById: jest.fn(), setSessionMarkerColorsById: jest.fn(),
  };
  const { result, rerender } = await renderHook((options: typeof props) => useRunnerClientState(options), { initialProps: props });
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  await act(async () => result.current.setDraft("session-1", "offline text"));
  await act(async () => { jest.advanceTimersByTime(300); });
  await waitFor(() => expect(requests).toEqual(["http://local.test/client-state"]));
  await rerender({ ...props, runnerUrl: "https://cloudflare.test" });
  await waitFor(() => expect(server.drafts[sessionKey]?.text).toBe("offline text"));
  expect(requests).toEqual(["http://local.test/client-state", "https://cloudflare.test/client-state"]);
});

test("notes are awaited metadata-only saves with provider isolation and blank clearing", async () => {
  server.sessions[sessionKey] = { title: "Old data", markerColor: "red" };
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(result.current.sessionNotesById[sessionKey]).toBe("");
  const claudeKey = JSON.stringify(["claude", "session-1"]);
  await act(async () => { await result.current.saveSessionNote("claude", "session-1", "Reminder", "", result.current.scopeId); });
  expect(result.current.sessionNotesById[claudeKey]).toBe("Reminder");
  expect(result.current.sessionNotesById[sessionKey]).toBe("");
  expect(result.current.messages).toEqual([]);
  expect(result.current.drafts).toEqual([]);
  expect(operations).toEqual([{ type: "session.set", backendId: "claude", sessionId: "session-1", note: "Reminder", expectedNote: "" }]);
  await act(async () => { await result.current.saveSessionNote("claude", "session-1", "", "Reminder", result.current.scopeId); });
  expect(result.current.sessionNotesById[claudeKey]).toBe("");
});

test("failed note saves reject and retain the last saved note", async () => {
  server.sessions[sessionKey] = { title: "", markerColor: "none", note: "Saved" };
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  const oldFetch = global.fetch;
  global.fetch = jest.fn((url, init) => init?.body ? Promise.reject(new Error("offline")) : oldFetch(url, init)) as typeof fetch;
  await act(async () => {
    await expect(result.current.saveSessionNote("codex", "session-1", "Unsaved", "Saved", result.current.scopeId)).rejects.toThrow("offline");
  });
  expect(result.current.sessionNotesById[sessionKey]).toBe("Saved");
});

test("notes clear when Runner changes and stale editor scope cannot write to the new Runner", async () => {
  server.sessions[sessionKey] = { title: "", markerColor: "none", note: "Old Runner" };
  const props = {
    settingsLoaded: true, runnerUrl: "http://runner.test", localRunnerUrl: "", cloudflareRunnerUrl: "",
    runnerToken: "token", backendId: "codex",
    setRegisteredDirectories: jest.fn(), setSessionTitleOverridesById: jest.fn(), setSessionMarkerColorsById: jest.fn(),
  };
  const { result, rerender } = await renderHook((options: typeof props) => useRunnerClientState(options), { initialProps: props });
  await waitFor(() => expect(result.current.sessionNotesById[sessionKey]).toBe("Old Runner"));
  const oldScope = result.current.scopeId;
  const oldFetch = global.fetch;
  global.fetch = jest.fn((url, init) => String(url).startsWith("http://new-runner.test/")
    ? Promise.reject(new Error("offline")) : oldFetch(url, init)) as typeof fetch;
  jest.spyOn(console, "warn").mockImplementation(() => {});
  await rerender({ ...props, runnerUrl: "http://new-runner.test" });
  expect(result.current.sessionNotesById).toEqual({});
  await act(async () => {
    await expect(result.current.saveSessionNote("codex", "session-1", "Wrong Runner", "Old Runner", oldScope)).rejects.toThrow("Runner が切り替わりました");
  });
  expect(operations).toEqual([]);
});

test("failed metadata and draft transport use shared connection state without save alerts, then polling clears it", async () => {
  AppState.currentState = "active";
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  const oldFetch = global.fetch;
  global.fetch = jest.fn().mockRejectedValue(new Error("Aborted"));
  await act(async () => result.current.recordMessage("message"));
  await waitFor(() => expect(result.current.connectionInterrupted).toBe(true));
  await act(async () => result.current.setDraft("session-1", "draft"));
  await act(async () => { jest.advanceTimersByTime(300); });
  expect(alert).not.toHaveBeenCalled();
  expect(result.current.connectionInterrupted).toBe(true);
  global.fetch = oldFetch;
  await act(async () => { jest.advanceTimersByTime(15_000); });
  await waitFor(() => expect(result.current.connectionInterrupted).toBe(false));
  expect(server.drafts[sessionKey]?.text).toBe("draft");
  expect(alert).not.toHaveBeenCalled();
});

test.each([401, 409, 500])("HTTP %s still reports a real save failure", async (status) => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status, json: async () => ({ message: "Save rejected" }) });
  await act(async () => result.current.recordMessage("message"));
  await waitFor(() => expect(alert).toHaveBeenCalledWith("Runner に保存できません", "Save rejected"));
  expect(result.current.connectionInterrupted).toBe(false);
});

test("a late failure from the old Runner cannot mark the new Runner disconnected", async () => {
  const props = {
    settingsLoaded: true, runnerUrl: "http://runner.test", localRunnerUrl: "", cloudflareRunnerUrl: "",
    runnerToken: "token", backendId: "codex",
    setRegisteredDirectories: jest.fn(), setSessionTitleOverridesById: jest.fn(), setSessionMarkerColorsById: jest.fn(),
  };
  const { result, rerender } = await renderHook((options: typeof props) => useRunnerClientState(options), { initialProps: props });
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  const oldFetch = global.fetch;
  let rejectOld!: (error: Error) => void;
  global.fetch = jest.fn((url, init) => String(url).startsWith("http://runner.test/")
    ? new Promise<Response>((_resolve, reject) => { rejectOld = reject; }) : oldFetch(url, init)) as typeof fetch;
  await act(async () => result.current.recordMessage("old Runner"));
  await waitFor(() => expect(rejectOld).toBeDefined());
  await rerender({ ...props, runnerUrl: "http://new-runner.test" });
  await act(async () => { rejectOld(new Error("Aborted")); });
  expect(result.current.connectionInterrupted).toBe(false);
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(result.current.connectionInterrupted).toBe(false);
});
