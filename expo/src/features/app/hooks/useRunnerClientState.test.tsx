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
    if (operation) {
      operations.push(operation);
      if (operation.type === "migrate") {
        migrationApplied = server.revision === 0;
        if (migrationApplied) {
          server.directories = operation.directories;
          server.sessions = operation.sessions;
          server.composerHistory = operation.composerHistory;
          server.drafts = Object.fromEntries(Object.entries(operation.drafts).map(([key, value]) => [key, {
            text: (value as { text: string }).text, updatedAt: 1,
          }]));
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
    return { ok: true, status: 200, json: async () => ({ snapshot: { ...server, migrationApplied } }) } as Response;
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
  expect(server.sessions[sessionKey].title).toBe("Renamed");
  expect(setSessionTitleOverridesById).toHaveBeenCalledWith({ [sessionKey]: "Renamed" });
  expect(result.current.drafts[0]).toMatchObject({ backendId: "codex", sessionId: "session-1", text: "unsent" });
  expect(local.registeredDirectories).toBeUndefined();
  expect(local.composerDrafts).toBeUndefined();
});

test("migrates legacy session metadata using the saved backend", async () => {
  local = { llmBackend: "claude", sessionTitleOverridesById: { "session-1": "Claude title" } };
  const { result } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(server.sessions[JSON.stringify(["claude", "session-1"])].title).toBe("Claude title");
  expect(server.sessions[sessionKey]).toBeUndefined();
});

test("existing Runner data wins without deleting different local legacy data", async () => {
  local = { sessionTitleOverridesById: { "session-1": "Old phone" } };
  server = { ...server, revision: 3, sessions: { [sessionKey]: { title: "Other device", markerColor: "none" } } };
  const { result, setSessionTitleOverridesById } = await renderState();
  await waitFor(() => expect(result.current.draftsLoaded).toBe(true));
  expect(operations).toEqual([]);
  expect(setSessionTitleOverridesById).toHaveBeenCalledWith({ [sessionKey]: "Other device" });
  expect(local.sessionTitleOverridesById).toEqual({ "session-1": "Old phone" });
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
