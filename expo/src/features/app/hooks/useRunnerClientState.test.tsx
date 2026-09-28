import { act, renderHook, waitFor } from "@testing-library/react-native";
import { Alert, AppState } from "react-native";
import { useRunnerClientState } from "./useRunnerClientState";
import { mutatePersistedSettings, readPersistedSettings } from "../utils/persistedSettingsFile";

jest.mock("../utils/persistedSettingsFile", () => ({
  legacyRunnerUrls: (settings: Record<string, unknown>) => settings.legacyRunnerUrls || [],
  readPersistedSettings: jest.fn(),
  mutatePersistedSettings: jest.fn(),
}));

const mockRead = jest.mocked(readPersistedSettings);
const mockMutate = jest.mocked(mutatePersistedSettings);
const sessionKey = JSON.stringify(["codex", "session-1"]);
const legacySessionKey = JSON.stringify(["legacy", "session-1"]);
const directory = { id: "dir-1", path: "/work", displayName: "Work", markerColor: "green" as const };
const parseRegisteredDirectories = (value: unknown) => Array.isArray(value) ? value : [];
let local: Record<string, unknown>;
let server: {
  revision: number;
  directories: typeof directory[];
  sessions: Record<string, { title: string; markerColor: string }>;
  composerHistory: string[];
  drafts: Record<string, { text: string; updatedAt: number }>;
  migrationConflicts: { field: string; key: string; value: string }[];
};
let operations: Record<string, unknown>[];

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  local = { legacyRunnerUrls: ["http://runner.test"] };
  server = { revision: 0, directories: [], sessions: {}, composerHistory: [], drafts: {}, migrationConflicts: [] };
  operations = [];
  mockRead.mockImplementation(async () => local);
  mockMutate.mockImplementation(async (mutate) => { local = mutate(local); });
  jest.spyOn(AppState, "addEventListener").mockReturnValue({ remove: jest.fn() } as never);
  global.fetch = jest.fn(async (_url, init) => {
    const operation = init?.body ? JSON.parse(String(init.body)).operation : null;
    let migrationApplied: boolean | undefined;
    let migrationComplete: boolean | undefined;
    if (operation) {
      operations.push(operation);
      if (operation.type === "migrate") {
        migrationApplied = false;
        migrationComplete = true;
        for (const directory of operation.directories) {
          if (!server.directories.some((item) => item.path === directory.path)) {
            server.directories.push(directory);
            migrationApplied = true;
          }
        }
        for (const [key, value] of Object.entries(operation.sessions)) {
          if (!server.sessions[key]) {
            server.sessions[key] = value as { title: string; markerColor: string };
            migrationApplied = true;
          } else if (server.sessions[key].title !== (value as { title: string }).title) {
            const conflict = { field: "sessions.title", key, value: (value as { title: string }).title };
            if (!server.migrationConflicts.some((item) => JSON.stringify(item) === JSON.stringify(conflict))) {
              server.migrationConflicts.push(conflict);
              migrationApplied = true;
            }
          }
        }
        for (const text of operation.composerHistory) {
          if (!server.composerHistory.includes(text)) {
            server.composerHistory.push(text);
            migrationApplied = true;
          }
        }
        for (const [key, value] of Object.entries(operation.drafts)) {
          if (!server.drafts[key]) {
            server.drafts[key] = { text: (value as { text: string }).text, updatedAt: 1 };
            migrationApplied = true;
          } else if (server.drafts[key].text !== (value as { text: string }).text) migrationComplete = false;
        }
        if (migrationApplied) {
          server.revision++;
        }
      } else if (operation.type === "composer.append") {
        server.composerHistory.unshift(operation.text);
        server.revision++;
      } else if (operation.type === "draft.set") {
        const key = JSON.stringify([operation.backendId, operation.sessionId]);
        if (operation.text) server.drafts[key] = { text: operation.text, updatedAt: Date.now() };
        else delete server.drafts[key];
        server.revision++;
      }
    }
    return { ok: true, status: 200, json: async () => ({ snapshot: { ...server, migrationApplied, migrationComplete } }) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
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
    parseRegisteredDirectories,
    setRegisteredDirectories,
    setSessionTitleOverridesById,
    setSessionMarkerColorsById,
  }));
  return { ...hook, setRegisteredDirectories, setSessionTitleOverridesById };
}

test("migrates old device data once, then removes local authoritative fields", async () => {
  local = {
    legacyRunnerUrls: ["http://runner.test"],
    registeredDirectories: [directory],
    sessionTitleOverridesById: { "session-1": "Renamed" },
    composerMessageHistory: ["accepted"],
    composerDrafts: [{ sessionId: "session-1", text: "unsent", updatedAt: 1 }],
  };
  const { result, setSessionTitleOverridesById } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(operations.map((operation) => operation.type)).toEqual(["migrate"]);
  expect(server.sessions[legacySessionKey].title).toBe("Renamed");
  expect(setSessionTitleOverridesById).toHaveBeenCalledWith({ [legacySessionKey]: "Renamed" });
  expect(result.current.drafts[0]).toMatchObject({ backendId: "legacy", sessionId: "session-1", text: "unsent" });
  expect(local.registeredDirectories).toBeUndefined();
  expect(local.composerDrafts).toBeUndefined();
});

test("preserves legacy session metadata without guessing a backend", async () => {
  local = { legacyRunnerUrls: ["http://runner.test"], llmBackend: "claude", sessionTitleOverridesById: { "session-1": "Claude title" } };
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(server.sessions[legacySessionKey].title).toBe("Claude title");
  expect(server.sessions[sessionKey]).toBeUndefined();
});

test("a second device contributes legacy data without replacing provider-specific Runner data", async () => {
  local = { legacyRunnerUrls: ["http://runner.test"], sessionTitleOverridesById: { "session-1": "Old phone" } };
  server = { ...server, revision: 3, sessions: { [sessionKey]: { title: "Other device", markerColor: "none" } } };
  const { result, setSessionTitleOverridesById } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(operations.map((operation) => operation.type)).toEqual(["migrate"]);
  expect(setSessionTitleOverridesById).toHaveBeenCalledWith({
    [sessionKey]: "Other device", [legacySessionKey]: "Old phone",
  });
  expect(local.sessionTitleOverridesById).toBeUndefined();
});

test("conflicting old title is archived on Runner and removed from the device", async () => {
  local = { legacyRunnerUrls: ["http://runner.test"], sessionTitleOverridesById: { "session-1": "Old phone" } };
  server.sessions[legacySessionKey] = { title: "Current Runner", markerColor: "none" };
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(server.sessions[legacySessionKey].title).toBe("Current Runner");
  expect(server.migrationConflicts).toEqual([{ field: "sessions.title", key: legacySessionKey, value: "Old phone" }]);
  expect(local.sessionTitleOverridesById).toBeUndefined();
});

test("an offline migration cannot carry legacy titles to a different Runner after autosave", async () => {
  local = { runnerUrl: "http://old-runner.test", legacyRunnerUrls: ["http://old-runner.test"],
    sessionTitleOverridesById: { "session-1": "Keep on old Runner" } };
  const fetchImpl = global.fetch;
  global.fetch = jest.fn(async (url, init) => {
    if (String(url).startsWith("http://old-runner.test/")) throw new Error("offline");
    return fetchImpl(url, init);
  }) as typeof fetch;
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const props = {
    settingsLoaded: true, runnerUrl: "http://old-runner.test", localRunnerUrl: "", cloudflareRunnerUrl: "",
    runnerToken: "token", backendId: "codex",
    parseRegisteredDirectories,
    setRegisteredDirectories: jest.fn(), setSessionTitleOverridesById: jest.fn(), setSessionMarkerColorsById: jest.fn(),
  };
  const { result, rerender } = await renderHook((options: typeof props) => useRunnerClientState(options), {
    initialProps: props,
  });
  await waitFor(() => expect(warn).toHaveBeenCalled());
  local.runnerUrl = "http://new-runner.test";
  await rerender({ ...props, runnerUrl: "http://new-runner.test" });
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(operations).toEqual([]);
  expect(local.sessionTitleOverridesById).toEqual({ "session-1": "Keep on old Runner" });
  expect(server.sessions).toEqual({});
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
    parseRegisteredDirectories,
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
    parseRegisteredDirectories,
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
    runnerToken: "token", backendId: "codex", parseRegisteredDirectories,
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
    runnerToken: "token", backendId: "codex", parseRegisteredDirectories,
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
    parseRegisteredDirectories, setRegisteredDirectories: jest.fn(),
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
    parseRegisteredDirectories, setRegisteredDirectories: jest.fn(),
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
