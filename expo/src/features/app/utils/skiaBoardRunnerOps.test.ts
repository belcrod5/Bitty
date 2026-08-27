import { applySkiaBoardOpLocally, applySkiaBoardOpsLocally } from "./skiaBoardRunnerOps";
import type { SkiaBoardState } from "./skiaBoardState";

jest.mock("./persistedSettingsFile", () => ({
  SKIA_BOARD_STATE_FIELD: "skiaBoardState",
  readPersistedSettingsField: jest.fn(),
  mutatePersistedSettings: jest.fn(),
}));

function state(partial: Partial<SkiaBoardState> = {}): SkiaBoardState {
  return {
    cards: [],
    sections: [],
    excludedSessionIds: [],
    ingestedUpdatedAtMs: 0,
    cardTextScale: 1,
    ...partial,
  };
}

const section = {
  id: "section:1",
  label: "計画",
  col: 0.5,
  row: 1.25,
  colSpan: 2.5,
  rowSpan: 1.75,
  color: "#3b82f6",
  opacity: 0.2,
  borderOnly: false,
};

test("addCard places session cards with origin metadata", () => {
  const next = applySkiaBoardOpLocally(state(), {
    type: "addCard",
    card: { kind: "session", sessionId: "s1", directory: "/w", backendId: "codex" },
  });
  expect(next.cards).toEqual([{
    kind: "session",
    sessionId: "s1",
    directory: "/w",
    backendId: "codex",
    col: 0,
    row: 0,
  }]);
});

test("removeCard dispatches by card id prefix", () => {
  const base = state({
    cards: [
      { kind: "session", sessionId: "s1", col: 0, row: 0 },
      { kind: "directory", directory: "/w", col: 1, row: 0 },
      { kind: "file", rootDir: "/w", path: "a.md", col: 0, row: 1 },
    ],
  });
  const withoutSession = applySkiaBoardOpLocally(base, { type: "removeCard", cardId: "session:s1" });
  expect(withoutSession.excludedSessionIds).toEqual(["s1"]);
  const withoutDirectory = applySkiaBoardOpLocally(withoutSession, { type: "removeCard", cardId: "directory:/w" });
  const withoutFile = applySkiaBoardOpLocally(withoutDirectory, { type: "removeCard", cardId: "file:/w\na.md" });
  expect(withoutFile.cards).toEqual([]);
  expect(applySkiaBoardOpLocally(withoutFile, { type: "removeCard", cardId: "file:broken-id" })).toBe(withoutFile);
});

test("no-op inputs return the same state reference", () => {
  const base = state({
    cards: [{ kind: "session", sessionId: "s1", col: 0, row: 0 }],
    excludedSessionIds: ["s2"],
  });
  expect(applySkiaBoardOpLocally(base, { type: "moveCard", cardId: "session:missing", col: 1, row: 1 })).toBe(base);
  expect(applySkiaBoardOpLocally(base, { type: "addCard", card: { kind: "file", rootDir: "", path: "a.md" } })).toBe(base);
  expect(applySkiaBoardOpLocally(base, { type: "removeSection", sectionId: "none" })).toBe(base);
  expect(applySkiaBoardOpLocally(base, { type: "removeCard", cardId: "directory:/none" })).toBe(base);
  // sessionカードには外観設定を適用しない。
  expect(applySkiaBoardOpLocally(base, { type: "updateCardAppearance", cardId: "session:s1", displayNameOverride: "x" })).toBe(base);
  expect(applySkiaBoardOpLocally(base, { type: "renameFileCard", rootDir: "/w", previousPath: "none.md", nextPath: "b.md" })).toBe(base);
  expect(applySkiaBoardOpLocally(base, { type: "setFileCardUnavailable", rootDir: "/w", path: "none.md", unavailable: true })).toBe(base);
});

test("re-adding an excluded session clears the exclusion and duplicates are no-ops", () => {
  const base = state({
    cards: [{ kind: "session", sessionId: "s1", col: 0, row: 0 }],
    excludedSessionIds: ["s2"],
  });
  const readded = applySkiaBoardOpLocally(base, { type: "addCard", card: { kind: "session", sessionId: "s2" } });
  expect(readded.excludedSessionIds).toEqual([]);
  expect(readded.cards).toHaveLength(2);
  expect(applySkiaBoardOpLocally(readded, { type: "addCard", card: { kind: "session", sessionId: "s1" } })).toBe(readded);
});

test("upsertSection adds a section that does not exist yet", () => {
  const added = applySkiaBoardOpLocally(state(), { type: "upsertSection", section });
  expect(added.sections).toEqual([section]);
  const updated = applySkiaBoardOpLocally(added, { type: "upsertSection", section: { ...section, label: "改" } });
  expect(updated.sections).toHaveLength(1);
  expect(updated.sections[0].label).toBe("改");
});

test("section, appearance, rename, unavailable, move, and tidy ops map to board functions", () => {
  let board = applySkiaBoardOpsLocally(state(), [
    { type: "upsertSection", section },
    { type: "addCard", card: { kind: "file", rootDir: "/w", path: "a.md" } },
    { type: "moveCard", cardId: "file:/w\na.md", col: 3, row: 4 },
    { type: "updateCardAppearance", cardId: "file:/w\na.md", displayNameOverride: "ノート", imagePath: "/img.png" },
    { type: "renameFileCard", rootDir: "/w", previousPath: "a.md", nextPath: "b.md" },
    { type: "setFileCardUnavailable", rootDir: "/w", path: "b.md", unavailable: true },
  ]);
  expect(board.sections).toEqual([section]);
  expect(board.cards).toEqual([{
    kind: "file",
    rootDir: "/w",
    path: "b.md",
    displayNameOverride: "ノート",
    imagePath: "/img.png",
    col: 3,
    row: 4,
    unavailable: true,
  }]);

  board = applySkiaBoardOpsLocally(board, [
    { type: "setFileCardUnavailable", rootDir: "/w", path: "b.md", unavailable: false },
    { type: "upsertSection", section: { ...section, label: "改" } },
    { type: "tidyCards" },
    { type: "removeSection", sectionId: section.id },
  ]);
  expect(board.cards[0]).toMatchObject({ col: 0, row: 0, unavailable: false });
  expect(board.sections).toEqual([]);
});
