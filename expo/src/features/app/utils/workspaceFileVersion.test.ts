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


test("read and write transport preserve absolute POSIX path identity", async () => {
  const root = "/external/project ";
  const path = String.raw`/external/project /memo\copy.md `;
  const fetchMock = jest.fn()
    .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ path, content: "selected", version: "v1" }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, path, version: "v2" }) });
  global.fetch = fetchMock as typeof fetch;
  const opened = await fetchRunnerTextFileContent({ runnerUrl: "http://runner.test", runnerToken: "token", rootDir: root, path, timeoutMs: 1000 });
  expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("path")).toBe(path);
  expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("rootDir")).toBe(root);
  expect(opened.path).toBe(path);
  await writeWorkspaceTextFile({ runnerUrl: "http://runner.test", runnerToken: "token", rootDirectory: root, path, content: "updated", expectedVersion: opened.version });
  expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toMatchObject({ rootDir: root, path });
});
