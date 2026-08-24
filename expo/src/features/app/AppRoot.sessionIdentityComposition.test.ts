const { readFileSync } = jest.requireActual<typeof import("node:fs")>("node:fs");

test("keeps the resolved Backend identity through popup and selected-session read state", () => {
  const source = readFileSync(`${__dirname}/AppRoot.tsx`, "utf8");
  const markReadComposition = source.slice(
    source.indexOf("const markSessionReadFromContext"),
    source.indexOf("const markSelectedSessionUnreadFromContext")
  );
  const markUnreadComposition = source.slice(
    source.indexOf("const markSelectedSessionUnreadFromContext"),
    source.indexOf("const { refreshGitChangedFiles")
  );

  expect(source).toContain("markSessionReadFromContext(sessionId, params.source, directory, backendId)");
  expect(markReadComposition).toContain("backendId,");
  expect(markUnreadComposition).toContain("backendId: llmBackend");
});
