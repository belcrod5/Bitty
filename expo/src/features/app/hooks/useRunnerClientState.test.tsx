import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppState } from "react-native";
import { useRunnerClientState } from "./useRunnerClientState";
import { mutatePersistedSettings, readPersistedSettings } from "../utils/persistedSettingsFile";

jest.mock("../utils/persistedSettingsFile", () => ({
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
};
let operations: Record<string, unknown>[];

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  local = {};
  server = { revision: 0, directories: [], sessions: {}, composerHistory: [], drafts: {} };
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
          } else if (JSON.stringify(server.sessions[key]) !== JSON.stringify(value)) migrationComplete = false;
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
  local = { llmBackend: "claude", sessionTitleOverridesById: { "session-1": "Claude title" } };
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(server.sessions[legacySessionKey].title).toBe("Claude title");
  expect(server.sessions[sessionKey]).toBeUndefined();
});

test("a second device contributes legacy data without replacing provider-specific Runner data", async () => {
  local = { sessionTitleOverridesById: { "session-1": "Old phone" } };
  server = { ...server, revision: 3, sessions: { [sessionKey]: { title: "Other device", markerColor: "none" } } };
  const { result, setSessionTitleOverridesById } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(operations.map((operation) => operation.type)).toEqual(["migrate"]);
  expect(setSessionTitleOverridesById).toHaveBeenCalledWith({
    [sessionKey]: "Other device", [legacySessionKey]: "Old phone",
  });
  expect(local.sessionTitleOverridesById).toBeUndefined();
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
    settingsLoaded: true, runnerUrl: "http://old-runner.test", runnerToken: "token", backendId: "codex",
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
    settingsLoaded: true, runnerUrl: "http://old-runner.test", runnerToken: "token", backendId: "codex",
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
