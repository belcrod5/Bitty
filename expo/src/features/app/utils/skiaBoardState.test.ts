import {
  findFreeSkiaBoardCell,
  ingestSkiaBoardSessions,
  moveSkiaBoardCard,
  parseSkiaBoardState,
  removeSkiaBoardSession,
  skiaBoardGridPosition,
  tidySkiaBoardCards,
  type SkiaBoardState,
} from "./skiaBoardState";

jest.mock("./persistedSettingsFile", () => ({
  SKIA_BOARD_STATE_FIELD: "skiaBoardState",
  readPersistedSettingsField: jest.fn(),
  mutatePersistedSettings: jest.fn(),
}));

function candidate(index: number) {
  return {
    sessionId: `session-${index}`,
    updatedAt: `2026-06-${String(index).padStart(2, "0")}T00:00:00.000Z`,
  };
}

function updatedAtMs(index: number) {
  return new Date(candidate(index).updatedAt).getTime();
}

describe("ingestSkiaBoardSessions", () => {
  it("initializes with the latest six candidates and a watermark over all candidates", () => {
    const state = ingestSkiaBoardSessions(
      null,
      Array.from({ length: 8 }, (_, index) => candidate(8 - index))
    );

    expect(state?.cards.map((card) => card.sessionId)).toEqual([
      "session-8",
      "session-7",
      "session-6",
      "session-5",
      "session-4",
      "session-3",
    ]);
    expect(state?.cards[2]).toMatchObject(skiaBoardGridPosition(2));
    // ウォーターマークは全候補の最大updatedAt(初期化時点の過去分は以後流入しない)。
    expect(state?.ingestedUpdatedAtMs).toBe(updatedAtMs(8));
    expect(state?.excludedSessionIds).toEqual([]);
  });

  it("returns null without candidates so a later full sync can initialize", () => {
    expect(ingestSkiaBoardSessions(null, [])).toBeNull();
  });

  it("stacks only unboarded, unexcluded candidates newer than the watermark", () => {
    const state: SkiaBoardState = {
      cards: [{ sessionId: "session-3", col: 0.4, row: 0.1 }],
      excludedSessionIds: ["session-5"],
      ingestedUpdatedAtMs: updatedAtMs(3),
    };

    const next = ingestSkiaBoardSessions(state, [
      candidate(6),
      candidate(5), // 除外済み → 追加しない
      candidate(4),
      candidate(3), // 搭載済み
      candidate(2), // ウォーターマークより古い → 追加しない
    ]);

    expect(next).not.toBe(state);
    expect(next?.cards.map((card) => card.sessionId)).toEqual([
      "session-3",
      "session-4",
      "session-6",
    ]);
    // 既存カードの位置は不変、新カードは重ならない空きセルへ古い順に配置。
    // (0.4, 0.1) のカードは row0/row1 の4セルへ部分的に重なるため row2 から埋まる。
    expect(next?.cards[0]).toMatchObject({ col: 0.4, row: 0.1 });
    expect(next?.cards[1]).toMatchObject({ col: 0, row: 2 });
    expect(next?.cards[2]).toMatchObject({ col: 1, row: 2 });
    expect(next?.ingestedUpdatedAtMs).toBe(updatedAtMs(6));
  });

  it("returns the same reference when nothing changes", () => {
    const state: SkiaBoardState = {
      cards: [{ sessionId: "session-2", col: 0, row: 0 }],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: updatedAtMs(2),
    };
    expect(ingestSkiaBoardSessions(state, [candidate(2), candidate(1)])).toBe(state);
  });
});

describe("findFreeSkiaBoardCell", () => {
  it("skips cells overlapped by free-form card positions", () => {
    // (0.3, 0.2) のカードは row0/row1 の4セルに部分的に重なる → 次の空きは(0,2)。
    const cell = findFreeSkiaBoardCell([
      { sessionId: "a", col: 0.3, row: 0.2 },
      { sessionId: "b", col: 1, row: 0 },
    ]);
    expect(cell).toEqual({ col: 0, row: 2 });

    // グリッドに揃ったカードだけなら隣のセルが空きになる。
    expect(findFreeSkiaBoardCell([{ sessionId: "a", col: 0, row: 0 }])).toEqual({ col: 1, row: 0 });
  });
});

describe("removeSkiaBoardSession", () => {
  it("removes the card and prevents automatic re-addition", () => {
    const state: SkiaBoardState = {
      cards: [
        { sessionId: "session-1", col: 0, row: 0 },
        { sessionId: "session-2", col: 1, row: 0 },
      ],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: updatedAtMs(2),
    };

    const removed = removeSkiaBoardSession(state, "session-2");
    expect(removed.cards.map((card) => card.sessionId)).toEqual(["session-1"]);
    expect(removed.excludedSessionIds).toEqual(["session-2"]);

    // 除外済みセッションはupdatedAtが前進しても再追加されない。
    const reIngested = ingestSkiaBoardSessions(removed, [
      { sessionId: "session-2", updatedAt: "2026-07-01T00:00:00.000Z" },
      candidate(1),
    ]);
    expect(reIngested?.cards.map((card) => card.sessionId)).toEqual(["session-1"]);
  });

  it("returns the same reference for a session that is not on the board", () => {
    const state: SkiaBoardState = {
      cards: [{ sessionId: "session-1", col: 0, row: 0 }],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
    };
    expect(removeSkiaBoardSession(state, "session-9")).toBe(state);
  });
});

describe("moveSkiaBoardCard / tidySkiaBoardCards", () => {
  it("moves a card to a free-form grid position", () => {
    const state: SkiaBoardState = {
      cards: [{ sessionId: "session-1", col: 0, row: 0 }],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
    };
    const moved = moveSkiaBoardCard(state, "session-1", 1.25, -0.5);
    expect(moved.cards[0]).toMatchObject({ col: 1.25, row: -0.5 });
    expect(moveSkiaBoardCard(moved, "session-1", 1.25, -0.5)).toBe(moved);
    expect(moveSkiaBoardCard(moved, "unknown", 0, 0)).toBe(moved);
  });

  it("tidies cards back onto the grid in board order", () => {
    const state: SkiaBoardState = {
      cards: [
        { sessionId: "session-1", col: 2.4, row: 5 },
        { sessionId: "session-2", col: -1, row: 0.2 },
        { sessionId: "session-3", col: 0.5, row: 0.5 },
      ],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
    };
    const tidied = tidySkiaBoardCards(state);
    expect(tidied.cards.map((card) => [card.col, card.row])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(tidySkiaBoardCards(tidied)).toBe(tidied);
  });
});

describe("parseSkiaBoardState", () => {
  it("round-trips a serialized board state", () => {
    const state: SkiaBoardState = {
      cards: [
        { sessionId: "session-1", col: 0.25, row: 1.5 },
        { sessionId: "session-2", col: 1, row: 0 },
      ],
      excludedSessionIds: ["session-9"],
      ingestedUpdatedAtMs: updatedAtMs(2),
    };
    expect(parseSkiaBoardState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("drops malformed cards and rejects empty or invalid payloads", () => {
    expect(parseSkiaBoardState(undefined)).toBeNull();
    expect(parseSkiaBoardState("broken")).toBeNull();
    expect(parseSkiaBoardState({ cards: [], excludedSessionIds: [] })).toBeNull();
    expect(parseSkiaBoardState({
      cards: [
        { sessionId: "session-1", col: 0, row: 0 },
        { sessionId: "session-1", col: 1, row: 1 },
        { sessionId: "", col: 0, row: 0 },
        { sessionId: "session-2", col: Number.NaN, row: 0 },
      ],
      excludedSessionIds: ["", "session-3", "session-3"],
      ingestedUpdatedAtMs: "not-a-number",
    })).toEqual({
      cards: [{ sessionId: "session-1", col: 0, row: 0 }],
      excludedSessionIds: ["session-3"],
      ingestedUpdatedAtMs: 0,
    });
  });
});
