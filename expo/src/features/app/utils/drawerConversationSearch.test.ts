import { searchDrawerConversations } from "./drawerConversationSearch";

afterEach(() => {
  jest.restoreAllMocks();
});

test("searches conversation history with the registered directory scope and options", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ results: [{ messageId: "message-1" }], cursor: "next", partial: true }),
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
  expect(page).toEqual({ results: [{ messageId: "message-1" }], cursor: "next", partial: true });
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
