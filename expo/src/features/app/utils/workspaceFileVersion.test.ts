import { fetchRunnerTextFileContent } from "./runnerFileContent";
import { writeWorkspaceTextFile } from "./workspaceFiles";

test("reads a file version and sends it back as the write precondition", async () => {
  const fetchMock = jest.fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        path: "project/note.md",
        content: "before",
        totalBytes: 6,
        version: "opened-version",
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, path: "project/note.md", version: "saved-version" }),
    });
  global.fetch = fetchMock as typeof fetch;

  const opened = await fetchRunnerTextFileContent({
    runnerUrl: "http://runner.test",
    runnerToken: "token",
    rootDir: "project",
    path: "project/note.md",
    timeoutMs: 1000,
  });
  const saved = await writeWorkspaceTextFile({
    runnerUrl: "http://runner.test",
    runnerToken: "token",
    rootDirectory: "project",
    path: "project/note.md",
    content: "after",
    expectedVersion: opened.version,
  });

  const writeBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
  expect(writeBody.expectedVersion).toBe("opened-version");
  expect(saved.version).toBe("saved-version");
});

test("rejects a write response without the next version", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, path: "project/note.md" }),
  }) as typeof fetch;

  await expect(writeWorkspaceTextFile({
    runnerUrl: "http://runner.test",
    runnerToken: "token",
    rootDirectory: "project",
    path: "project/note.md",
    content: "after",
    expectedVersion: "opened-version",
  })).rejects.toThrow("保存後のファイルバージョンを取得できませんでした。");
});
