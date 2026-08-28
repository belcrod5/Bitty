import test from "node:test";
import assert from "node:assert/strict";
import {
  addSkiaBoardCard,
  emptySkiaBoardState,
  findFreeSkiaBoardCell,
  ingestSkiaBoardSessions,
  moveSkiaBoardCard,
  normalizeSkiaBoardState,
  parseSkiaBoardState,
  removeSkiaBoardCard,
  removeSkiaBoardSectionById,
  renameSkiaBoardFileCard,
  setSkiaBoardFileCardUnavailable,
  skiaBoardCardId,
  tidySkiaBoardCards,
  updateSkiaBoardCardAppearance,
  upsertSkiaBoardSection,
} from "../src/skia-board-logic.mjs";

function sessionCard(sessionId, col, row, extra = {}) {
  return { kind: "session", sessionId, col, row, ...extra };
}

function baseState() {
  return {
    cards: [sessionCard("session-1", 0, 0), sessionCard("session-2", 1, 0)],
    sections: [],
    excludedSessionIds: [],
    ingestedUpdatedAtMs: 1000,
  };
}

function section(id = "section:1") {
  return {
    id,
    label: "計画",
    col: 0.5,
    row: 1.25,
    colSpan: 2.5,
    rowSpan: 1.75,
    color: "#3b82f6",
    opacity: 0.2,
    borderOnly: false,
  };
}

test("normalizeSkiaBoardState migrates legacy cards and dedupes", () => {
  const state = normalizeSkiaBoardState({
    cards: [
      { sessionId: "legacy", col: 0, row: 0 },
      { kind: "session", sessionId: "legacy", col: 1, row: 1 },
      { kind: "session", sessionId: "typed", col: 1, row: 0, directory: " /work ", backendId: "codex" },
      { kind: "file", rootDir: "", path: "a.md", col: 0, row: 1 },
    ],
    excludedSessionIds: ["x", "x", "", "y"],
    sections: [section(), section()],
    ingestedUpdatedAtMs: -5,
  });
  assert.deepEqual(state.cards, [
    { kind: "session", sessionId: "legacy", col: 0, row: 0 },
    { kind: "session", sessionId: "typed", directory: "/work", backendId: "codex", col: 1, row: 0 },
  ]);
  assert.deepEqual(state.excludedSessionIds, ["x", "y"]);
  assert.equal(state.sections.length, 1);
  assert.equal(state.ingestedUpdatedAtMs, 0);
});

test("parseSkiaBoardState returns null for effectively empty input", () => {
  assert.equal(parseSkiaBoardState(undefined), null);
  assert.equal(parseSkiaBoardState({ cards: [], ingestedUpdatedAtMs: 100 }), null);
  assert.notEqual(parseSkiaBoardState({ cards: [sessionCard("s", 0, 0)] }), null);
});

test("findFreeSkiaBoardCell skips occupied cells", () => {
  assert.deepEqual(findFreeSkiaBoardCell(baseState().cards), { col: 0, row: 1 });
});

test("addCard places a session card into a free cell and clears exclusion", () => {
  const state = { ...baseState(), excludedSessionIds: ["session-3"] };
  const next = addSkiaBoardCard(state, {
    kind: "session",
    sessionId: "session-3",
    directory: "/work",
    backendId: "codex",
  });
  assert.deepEqual(next.cards[2], {
    kind: "session",
    sessionId: "session-3",
    directory: "/work",
    backendId: "codex",
    col: 0,
    row: 1,
  });
  assert.deepEqual(next.excludedSessionIds, []);
  assert.equal(addSkiaBoardCard(next, { kind: "session", sessionId: "session-3" }), next);
});

test("addCard revives an unavailable file card in place", () => {
  const state = {
    ...emptySkiaBoardState(),
    cards: [{ kind: "file", rootDir: "/w", path: "a.md", col: 1, row: 2, unavailable: true }],
  };
  const next = addSkiaBoardCard(state, { kind: "file", rootDir: "/w", path: "a.md" });
  assert.deepEqual(next.cards, [{ kind: "file", rootDir: "/w", path: "a.md", col: 1, row: 2 }]);
});

test("addCard ignores client-provided coordinates", () => {
  const state = baseState();
  const next = addSkiaBoardCard(state, {
    kind: "session",
    sessionId: "session-3",
    col: "not-a-number",
    row: 99,
  });
  assert.deepEqual(next.cards[2], { kind: "session", sessionId: "session-3", col: 0, row: 1 });
});

test("removeCard excludes removed sessions but not files", () => {
  const state = {
    ...baseState(),
    cards: [...baseState().cards, { kind: "file", rootDir: "/w", path: "a.md", col: 0, row: 1 }],
  };
  const withoutSession = removeSkiaBoardCard(state, "session:session-1");
  assert.deepEqual(withoutSession.excludedSessionIds, ["session-1"]);
  assert.equal(withoutSession.cards.length, 2);
  const withoutFile = removeSkiaBoardCard(withoutSession, skiaBoardCardId(state.cards[2]));
  assert.deepEqual(withoutFile.excludedSessionIds, ["session-1"]);
  assert.equal(withoutFile.cards.length, 1);
  assert.equal(removeSkiaBoardCard(withoutFile, "session:missing"), withoutFile);
});

test("moveCard updates position and is a no-op for unknown ids", () => {
  const state = baseState();
  const moved = moveSkiaBoardCard(state, "session:session-1", 1.5, 2.25);
  assert.deepEqual(moved.cards[0], sessionCard("session-1", 1.5, 2.25));
  assert.equal(moveSkiaBoardCard(state, "session:none", 1, 1), state);
  assert.equal(moveSkiaBoardCard(state, "session:session-1", Number.NaN, 0), state);
});

test("upsertSection adds, updates, and rejects invalid sections", () => {
  const state = upsertSkiaBoardSection(emptySkiaBoardState(), section());
  assert.equal(state.sections.length, 1);
  const updated = upsertSkiaBoardSection(state, { ...section(), label: "変更" });
  assert.equal(updated.sections[0].label, "変更");
  assert.equal(upsertSkiaBoardSection(updated, { ...section(), label: "変更" }), updated);
  assert.equal(upsertSkiaBoardSection(updated, { ...section(), color: "red" }), updated);
  const removed = removeSkiaBoardSectionById(updated, "section:1");
  assert.equal(removed.sections.length, 0);
});

test("updateCardAppearance only applies to file and directory cards", () => {
  const state = {
    ...emptySkiaBoardState(),
    cards: [
      sessionCard("s", 0, 0),
      { kind: "directory", directory: "/w", col: 1, row: 0 },
    ],
  };
  assert.equal(
    updateSkiaBoardCardAppearance(state, "session:s", { displayNameOverride: "x" }),
    state
  );
  const next = updateSkiaBoardCardAppearance(state, "directory:/w", {
    displayNameOverride: "作業",
    imagePath: "relative/path.png",
  });
  assert.deepEqual(next.cards[1], { kind: "directory", directory: "/w", col: 1, row: 0, displayNameOverride: "作業" });
});

test("renameFileCard renames and collapses onto an existing destination", () => {
  const state = {
    ...emptySkiaBoardState(),
    cards: [
      { kind: "file", rootDir: "/w", path: "a.md", col: 0, row: 0, unavailable: true },
      { kind: "file", rootDir: "/w", path: "b.md", col: 1, row: 0 },
    ],
  };
  const renamed = renameSkiaBoardFileCard(state, "/w", "a.md", "c.md");
  assert.deepEqual(renamed.cards[0], { kind: "file", rootDir: "/w", path: "c.md", col: 0, row: 0 });
  const collapsed = renameSkiaBoardFileCard(state, "/w", "a.md", "b.md");
  assert.deepEqual(collapsed.cards, [state.cards[1]]);
});

test("setFileCardUnavailable toggles the flag", () => {
  const state = {
    ...emptySkiaBoardState(),
    cards: [{ kind: "file", rootDir: "/w", path: "a.md", col: 0, row: 0 }],
  };
  const marked = setSkiaBoardFileCardUnavailable(state, "/w", "a.md", true);
  assert.equal(marked.cards[0].unavailable, true);
  assert.equal(setSkiaBoardFileCardUnavailable(marked, "/w", "a.md", true), marked);
  const cleared = setSkiaBoardFileCardUnavailable(marked, "/w", "a.md", false);
  assert.equal("unavailable" in cleared.cards[0], false);
});

test("tidyCards packs visible cards first in row-major order", () => {
  const state = {
    ...emptySkiaBoardState(),
    cards: [
      sessionCard("a", 3, 5),
      sessionCard("b", 0, 9),
      sessionCard("c", 1, 1),
    ],
  };
  const tidied = tidySkiaBoardCards(state, ["session:b", "session:c"]);
  assert.deepEqual(
    tidied.cards.map((card) => [card.sessionId, card.col, card.row]),
    [["b", 0, 0], ["c", 1, 0], ["a", 0, 1]]
  );
  assert.equal(tidySkiaBoardCards(tidied, ["session:b", "session:c"]), tidied);
});

test("ingest initializes an empty board with the latest candidates", () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    sessionId: `session-${index}`,
    directory: "/work",
    backendId: "codex",
    updatedAt: `2026-06-0${index + 1}T00:00:00.000Z`,
  }));
  const state = ingestSkiaBoardSessions(null, candidates);
  assert.equal(state.cards.length, 6);
  assert.equal(state.cards[0].directory, "/work");
  assert.equal(state.ingestedUpdatedAtMs, new Date("2026-06-08T00:00:00.000Z").getTime());
});

test("ingest keeps existing sections when initializing a section-only board", () => {
  const state = {
    cards: [],
    sections: [section()],
    excludedSessionIds: [],
    ingestedUpdatedAtMs: 0,
  };
  const next = ingestSkiaBoardSessions(state, [
    { sessionId: "session-1", updatedAt: "2026-06-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(next.sections, [section()]);
  assert.deepEqual(next.cards.map((card) => card.sessionId), ["session-1"]);
});

test("ingest adds only new unexcluded sessions past the watermark", () => {
  const state = {
    ...baseState(),
    excludedSessionIds: ["excluded"],
    ingestedUpdatedAtMs: new Date("2026-06-05T00:00:00.000Z").getTime(),
  };
  const next = ingestSkiaBoardSessions(state, [
    { sessionId: "session-1", updatedAt: "2026-06-09T00:00:00.000Z" },
    { sessionId: "excluded", updatedAt: "2026-06-09T00:00:00.000Z" },
    { sessionId: "old", updatedAt: "2026-06-01T00:00:00.000Z" },
    { sessionId: "new", updatedAt: "2026-06-07T00:00:00.000Z", directory: "/work" },
  ]);
  assert.equal(next.cards.length, 3);
  assert.deepEqual(next.cards[2], {
    kind: "session",
    sessionId: "new",
    directory: "/work",
    col: 0,
    row: 1,
  });
  assert.equal(next.ingestedUpdatedAtMs, new Date("2026-06-07T00:00:00.000Z").getTime());
  assert.equal(ingestSkiaBoardSessions(next, [
    { sessionId: "old", updatedAt: "2026-06-01T00:00:00.000Z" },
  ]), next);
});
