import { useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import {
  COMPOSER_DRAFT_LIMIT,
  COMPOSER_MESSAGE_HISTORY_LIMIT,
  type ComposerDraft,
  parseComposerDrafts,
  parseComposerMessageHistory,
  useComposerDraftSync,
} from "./useComposerPersistence";

afterEach(() => {
  jest.useRealTimers();
});

test("normalizes legacy history and caps it at 40 messages", () => {
  expect(parseComposerMessageHistory([" same ", "same", "", 123])).toEqual(["same", "same"]);
  expect(parseComposerMessageHistory(Array.from({ length: 41 }, (_, index) => `message ${index}`)))
    .toHaveLength(COMPOSER_MESSAGE_HISTORY_LIMIT);
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

test("clears every composer bound to a draft after an accepted send removes it", async () => {
  let drafts = [{ sessionId: "popup-session", text: "send me", updatedAt: 2 }];
  const { result, rerender } = await renderHook(() => {
    const [text, setText] = useState("");
    useComposerDraftSync({
      sessionId: "popup-session",
      text,
      drafts,
      loaded: true,
      setDraft: jest.fn(),
      setText,
    });
    return text;
  });
  await waitFor(() => expect(result.current).toBe("send me"));

  drafts = [];
  await rerender({});
  await waitFor(() => expect(result.current).toBe(""));
});

test("restores an unscoped legacy draft until a backend-specific draft exists", async () => {
  let drafts: ComposerDraft[] = [{ backendId: "legacy", sessionId: "shared", text: "old draft", updatedAt: 1 }];
  const { result, rerender } = await renderHook(() => {
    const [text, setText] = useState("");
    useComposerDraftSync({ backendId: "claude", sessionId: "shared", text, drafts,
      loaded: true, setDraft: jest.fn(), setText });
    return text;
  });
  await waitFor(() => expect(result.current).toBe("old draft"));
  drafts = [{ backendId: "claude", sessionId: "shared", text: "Claude draft", updatedAt: 2 }, ...drafts];
  await rerender({});
  await waitFor(() => expect(result.current).toBe("Claude draft"));
});
