import { useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import {
  COMPOSER_DRAFTS_FIELD,
  COMPOSER_MESSAGE_HISTORY_FIELD,
  mutatePersistedSettings,
  readPersistedSettingsField,
} from "../utils/persistedSettingsFile";
import {
  COMPOSER_DRAFT_LIMIT,
  COMPOSER_MESSAGE_HISTORY_LIMIT,
  type ComposerDraft,
  parseComposerDrafts,
  parseComposerMessageHistory,
  useComposerDraftSync,
  useComposerPersistence,
} from "./useComposerPersistence";

jest.mock("../utils/persistedSettingsFile", () => ({
  COMPOSER_DRAFTS_FIELD: "composerDrafts",
  COMPOSER_MESSAGE_HISTORY_FIELD: "composerMessageHistory",
  readPersistedSettingsField: jest.fn(),
  mutatePersistedSettings: jest.fn(),
}));

const mockRead = jest.mocked(readPersistedSettingsField);
const mockMutate = jest.mocked(mutatePersistedSettings);
let persisted: Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  persisted = {};
  mockRead.mockImplementation(async (field) => persisted[field]);
  mockMutate.mockImplementation(async (mutate) => {
    persisted = mutate(persisted);
  });
});

afterEach(() => {
  jest.useRealTimers();
});

test("normalizes persisted history and keeps the latest 40 accepted messages", async () => {
  expect(parseComposerMessageHistory([" same ", "same", "", 123])).toEqual(["same", "same"]);
  const { result } = await renderHook(() => useComposerPersistence());
  await act(async () => Promise.resolve());
  await act(async () => {
    for (let index = 1; index <= 41; index += 1) {
      result.current.recordMessage(`message ${index}`);
    }
  });
  expect(result.current.messages).toHaveLength(COMPOSER_MESSAGE_HISTORY_LIMIT);
  expect(result.current.messages[0]).toBe("message 41");
  expect(result.current.messages.at(-1)).toBe("message 2");
});

test("parses one exact-text draft per session, newest first, capped at ten", () => {
  const input = Array.from({ length: 12 }, (_, index) => ({
    sessionId: `session-${index}`,
    text: ` draft ${index} `,
    updatedAt: index + 1,
  }));
  input.push({ sessionId: "session-11", text: "newest replacement", updatedAt: 20 });
  expect(parseComposerDrafts([...input, null, { sessionId: "", text: "bad", updatedAt: 30 }]))
    .toEqual(expect.arrayContaining([{ sessionId: "session-11", text: "newest replacement", updatedAt: 20 }]));
  expect(parseComposerDrafts([{ sessionId: "bad", text: "text", updatedAt: "30" }])).toEqual([]);
  expect(parseComposerDrafts(input)).toHaveLength(COMPOSER_DRAFT_LIMIT);
  expect(parseComposerDrafts(input)[0].text).toBe("newest replacement");
});

test("restores, debounces updates, limits sessions, and clears only the accepted session", async () => {
  persisted[COMPOSER_DRAFTS_FIELD] = [{ sessionId: "restored", text: "saved text", updatedAt: 1 }];
  const { result } = await renderHook(() => useComposerPersistence());
  await act(async () => Promise.resolve());
  expect(result.current.draftsLoaded).toBe(true);
  expect(result.current.drafts.find((draft) => draft.sessionId === "restored")?.text).toBe("saved text");

  jest.useFakeTimers();
  await act(async () => {
    for (let index = 0; index < 11; index += 1) {
      result.current.setDraft(`new-${index}`, `text ${index}`);
    }
  });
  expect(mockMutate).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(300));
  await act(async () => Promise.resolve());
  expect(mockMutate).toHaveBeenCalledTimes(1);
  expect(parseComposerDrafts(persisted[COMPOSER_DRAFTS_FIELD])).toHaveLength(10);

  await act(async () => result.current.clearDraft("new-10"));
  await act(async () => Promise.resolve());
  expect(result.current.drafts.find((draft) => draft.sessionId === "new-10")).toBeUndefined();
  expect(result.current.drafts.find((draft) => draft.sessionId === "new-9")?.text).toBe("text 9");
  expect(mockMutate).toHaveBeenCalledTimes(2);
});

test("restores each session once and persists source-of-truth updates from any input path", async () => {
  let drafts = [{ sessionId: "local-session", text: "local draft", updatedAt: 2 }];
  const setDraft = jest.fn();
  const { result, rerender } = await renderHook(({ sessionId }: { sessionId: string }) => {
    const [text, setText] = useState("");
    useComposerDraftSync({ sessionId, text, drafts, loaded: true, setDraft, setText });
    return { text, setText };
  }, { initialProps: { sessionId: "local-session" } });
  await waitFor(() => expect(result.current.text).toBe("local draft"));

  setDraft.mockClear();
  await act(async () => result.current.setText("voice input"));
  await waitFor(() => expect(setDraft).toHaveBeenCalledWith("local-session", "voice input"));
  expect(result.current.text).toBe("voice input");

  await rerender({ sessionId: "local-session" });
  expect(result.current.text).toBe("voice input");

  drafts = [{ sessionId: "server-session", text: "server draft", updatedAt: 3 }];
  await rerender({ sessionId: "server-session" });
  await waitFor(() => expect(result.current.text).toBe("server draft"));
});

test("keeps a newer source update when persisted drafts finish loading", async () => {
  let loaded = false;
  let drafts: ComposerDraft[] = [];
  const setDraft = jest.fn();
  const { result, rerender } = await renderHook(() => {
    const [text, setText] = useState("");
    useComposerDraftSync({
      sessionId: "local-session", text, drafts, loaded, setDraft, setText,
    });
    return { text, setText };
  });

  await act(async () => result.current.setText("spoken before load"));
  await waitFor(() => expect(setDraft).toHaveBeenCalledWith("local-session", "spoken before load"));

  loaded = true;
  drafts = [{ sessionId: "local-session", text: "older draft", updatedAt: 1 }];
  await rerender({});
  expect(result.current.text).toBe("spoken before load");
});
