import { formatLlmSessionDisplayTitle } from "./utils/llmSession";

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

test("bounds custom title overrides before every panel snapshot update", () => {
  const source = readFileSync(`${__dirname}/AppRoot.tsx`, "utf8");
  const overrideProjectionStart = source.indexOf("let overrideTitle = \"\";");
  const overrideProjection = source.slice(
    overrideProjectionStart,
    source.indexOf("const clearPanelSnapshot", overrideProjectionStart)
  );
  const hydrationStart = source.indexOf("const hydratePanelFromSessionHistory = useCallback");
  const hydration = source.slice(
    hydrationStart,
    source.indexOf("const runtimeAfterHydration", hydrationStart)
  );

  expect(overrideProjection).toContain(
    "formatLlmSessionDisplayTitle(sessionTitleOverridesById[candidateSessionId])"
  );
  expect(overrideProjection).toContain("selectedSessionTitle: expectedTitle");
  expect(hydration).toContain("const overrideTitle = formatLlmSessionDisplayTitle(");
  expect(hydration).toContain("selectedSessionTitle,");

  const selectedSessionTitle = formatLlmSessionDisplayTitle(`custom ${"🙂".repeat(10_000)}`);
  expect(Array.from(selectedSessionTitle)).toHaveLength(200);
  expect(selectedSessionTitle.endsWith("🙂…")).toBe(true);
});
