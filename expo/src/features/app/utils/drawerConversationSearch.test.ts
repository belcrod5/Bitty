import {
  listDrawerConversationSearchDirectories,
  searchDrawerConversations,
} from "./drawerConversationSearch";

afterEach(() => {
  jest.restoreAllMocks();
});

test("loads and deduplicates searchable workspaces from the runner", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      workspaces: [
        { canonicalRoot: " /work/one " },
        { canonicalRoot: "/work/one" },
        { canonicalRoot: "/work/two" },
      ],
    }),
  } as Response);

  await expect(listDrawerConversationSearchDirectories({
    runnerUrl: "http://runner/",
    runnerToken: " token ",
  })).resolves.toEqual(["/work/one", "/work/two"]);

  const [requestUrl, requestInit] = fetchMock.mock.calls[0];
  expect(new URL(String(requestUrl)).pathname).toBe("/agent/workspaces");
  expect(requestInit).toEqual(expect.objectContaining({
    headers: { authorization: "Bearer token" },
  }));
});

test("searches conversation history with the registered directory scope and options", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      results: [{
        sessionRef: { backendId: " codex ", nativeSessionId: " session-1 " },
        canonicalCwd: " /work/one ",
        sessionCreatedAt: " 2026-08-01T00:00:00.000Z ",
        messageId: " message-1 ",
        role: " Assistant ",
        createdAt: " 2026-08-02T00:00:00.000Z ",
        snippet: " matching text ",
        conversationCursor: " read-cursor ",
      }],
      cursor: " next ",
      partial: true,
    }),
  } as Response);

  const page = await searchDrawerConversations({
    runnerUrl: "http://runner/",
    runnerToken: " token ",
    query: " drawer search ",
    directories: ["/work/one", "/work/two"],
    backendId: "codex",
    order: "oldest",
    since: "2026-08-01T00:00:00.000Z",
    cursor: "cursor-1",
  });

  const [requestUrl, requestInit] = fetchMock.mock.calls[0];
  const url = new URL(String(requestUrl));
  expect(url.pathname).toBe("/agent/session-history/search");
  expect(url.searchParams.get("query")).toBe("drawer search");
  expect(url.searchParams.getAll("cwd")).toEqual(["/work/one", "/work/two"]);
  expect(url.searchParams.get("backendId")).toBe("codex");
  expect(url.searchParams.get("order")).toBe("oldest");
  expect(url.searchParams.get("since")).toBe("2026-08-01T00:00:00.000Z");
  expect(url.searchParams.get("cursor")).toBe("cursor-1");
  expect(requestInit).toEqual(expect.objectContaining({
    headers: { authorization: "Bearer token" },
  }));
  expect(page).toEqual({
    results: [{
      sessionRef: { backendId: "codex", nativeSessionId: "session-1" },
      canonicalCwd: "/work/one",
      sessionCreatedAt: "2026-08-01T00:00:00.000Z",
      messageId: "message-1",
      role: "assistant",
      createdAt: "2026-08-02T00:00:00.000Z",
      snippet: "matching text",
      conversationCursor: "read-cursor",
    }],
    cursor: "next",
    partial: true,
  });
});

test("uses the runner error message", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: "query is required" } }),
  } as Response);

  await expect(searchDrawerConversations({
    runnerUrl: "http://runner",
    runnerToken: "token",
    query: "",
    directories: ["/work"],
    backendId: "all",
    order: "newest",
  })).rejects.toThrow("query is required");
});

test("uses the HTTP status when the runner error body is empty", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue({
    ok: false,
    status: 502,
    json: async () => null,
  } as Response);

  await expect(listDrawerConversationSearchDirectories({
    runnerUrl: "http://runner",
    runnerToken: "token",
  })).rejects.toThrow("検索に失敗しました (502)");
});

test.each([
  { results: {} },
  {
    results: [{
      sessionRef: { backendId: "codex", nativeSessionId: "session-1" },
      canonicalCwd: "/work",
      messageId: "message-1",
      role: "tool",
      snippet: "text",
      conversationCursor: "cursor",
    }],
  },
  {
    results: [{
      sessionRef: { backendId: "codex", nativeSessionId: "" },
      canonicalCwd: "/work",
      messageId: "message-1",
      role: "user",
      snippet: "text",
      conversationCursor: "cursor",
    }],
  },
])("rejects a malformed successful response", async (payload) => {
  jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => payload,
  } as Response);

  await expect(searchDrawerConversations({
    runnerUrl: "http://runner",
    runnerToken: "token",
    query: "drawer",
    directories: ["/work"],
    backendId: "all",
    order: "newest",
  })).rejects.toThrow("検索結果の応答形式が不正です。");
});
