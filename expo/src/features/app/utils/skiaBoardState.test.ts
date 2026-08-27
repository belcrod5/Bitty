import {
  addSkiaBoardDirectory,
  addSkiaBoardFile,
  addSkiaBoardSection,
  addSkiaBoardSession,
  findFreeSkiaBoardCell,
  ingestSkiaBoardSessions,
  isAbsoluteRunnerHostPath,
  markSkiaBoardFileUnavailable,
  moveSkiaBoardCard,
  normalizeSkiaBoardTextScale,
  parseSkiaBoardState,
  renameSkiaBoardFile,
  removeSkiaBoardDirectory,
  removeSkiaBoardSession,
  removeSkiaBoardFile,
  removeSkiaBoardSection,
  replacePersistedSkiaBoardState,
  skiaBoardCardId,
  skiaBoardCardDisplayName,
  skiaBoardDirectoryId,
  skiaBoardGridPosition,
  setSkiaBoardCardTextScale,
  subscribePersistedSkiaBoardStateReplaced,
  tidySkiaBoardCards,
  updateSkiaBoardCardAppearance,
  updateSkiaBoardSection,
  type SkiaBoardState,
} from "./skiaBoardState";
import { mutatePersistedSettings } from "./persistedSettingsFile";

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

function sessionCard(sessionId: string, col: number, row: number) {
  return { kind: "session" as const, sessionId, col, row };
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

function boardedSessionIds(state: SkiaBoardState | null | undefined) {
  return (state?.cards || []).flatMap((card) => card.kind === "session" ? [card.sessionId] : []);
}

describe("ingestSkiaBoardSessions", () => {
  it("initializes with the latest six candidates and a watermark over all candidates", () => {
    const state = ingestSkiaBoardSessions(
      null,
      Array.from({ length: 8 }, (_, index) => candidate(8 - index))
    );

    expect(boardedSessionIds(state)).toEqual([
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

  it("initializes latest-first from a scale-only persisted state and preserves its scale", () => {
    const scaleOnlyState = parseSkiaBoardState({
      cards: [],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1.2,
    });

    const state = ingestSkiaBoardSessions(
      scaleOnlyState,
      Array.from({ length: 8 }, (_, index) => candidate(8 - index))
    );

    expect(boardedSessionIds(state)).toEqual([
      "session-8",
      "session-7",
      "session-6",
      "session-5",
      "session-4",
      "session-3",
    ]);
    expect(state?.ingestedUpdatedAtMs).toBe(updatedAtMs(8));
    expect(state?.cardTextScale).toBe(1.2);
  });

  it("stacks only unboarded, unexcluded candidates newer than the watermark", () => {
    const state: SkiaBoardState = {
      cards: [sessionCard("session-3", 0.4, 0.1)],
      sections: [],
      excludedSessionIds: ["session-5"],
      ingestedUpdatedAtMs: updatedAtMs(3),
      cardTextScale: 1,
    };

    const next = ingestSkiaBoardSessions(state, [
      candidate(6),
      candidate(5), // 除外済み → 追加しない
      candidate(4),
      candidate(3), // 搭載済み
      candidate(2), // ウォーターマークより古い → 追加しない
    ]);

    expect(next).not.toBe(state);
    expect(boardedSessionIds(next)).toEqual([
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
      cards: [sessionCard("session-2", 0, 0)],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: updatedAtMs(2),
      cardTextScale: 1,
    };
    expect(ingestSkiaBoardSessions(state, [candidate(2), candidate(1)])).toBe(state);
  });

  it("initializes sessions alongside an existing directory shortcut", () => {
    const state: SkiaBoardState = {
      cards: [{
        kind: "directory",
        directory: "/workspace",
        col: 0,
        row: 0,
      }],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };

    const next = ingestSkiaBoardSessions(state, [candidate(1)]);

    expect(next?.cards).toHaveLength(2);
    expect(next?.cards[1]).toMatchObject({ kind: "session", sessionId: "session-1" });
  });
});

describe("findFreeSkiaBoardCell", () => {
  it("skips cells overlapped by free-form card positions", () => {
    // (0.3, 0.2) のカードは row0/row1 の4セルに部分的に重なる → 次の空きは(0,2)。
    const cell = findFreeSkiaBoardCell([
      sessionCard("a", 0.3, 0.2),
      sessionCard("b", 1, 0),
    ]);
    expect(cell).toEqual({ col: 0, row: 2 });

    // グリッドに揃ったカードだけなら隣のセルが空きになる。
    expect(findFreeSkiaBoardCell([sessionCard("a", 0, 0)])).toEqual({ col: 1, row: 0 });
  });
});

describe("removeSkiaBoardSession", () => {
  it("removes the card and prevents automatic re-addition", () => {
    const state: SkiaBoardState = {
      cards: [
        sessionCard("session-1", 0, 0),
        sessionCard("session-2", 1, 0),
      ],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: updatedAtMs(2),
      cardTextScale: 1,
    };

    const removed = removeSkiaBoardSession(state, "session-2");
    expect(boardedSessionIds(removed)).toEqual(["session-1"]);
    expect(removed.excludedSessionIds).toEqual(["session-2"]);

    // 除外済みセッションはupdatedAtが前進しても再追加されない。
    const reIngested = ingestSkiaBoardSessions(removed, [
      { sessionId: "session-2", updatedAt: "2026-07-01T00:00:00.000Z" },
      candidate(1),
    ]);
    expect(boardedSessionIds(reIngested)).toEqual(["session-1"]);
  });

  it("returns the same reference for a session that is not on the board", () => {
    const state: SkiaBoardState = {
      cards: [sessionCard("session-1", 0, 0)],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };
    expect(removeSkiaBoardSession(state, "session-9")).toBe(state);
  });
});

describe("manual board cards", () => {
  it("re-adds an excluded session and uses the first free cell", () => {
    const state: SkiaBoardState = {
      cards: [sessionCard("session-1", 0, 0)],
      sections: [],
      excludedSessionIds: ["session-2"],
      ingestedUpdatedAtMs: updatedAtMs(2),
      cardTextScale: 1,
    };
    const added = addSkiaBoardSession(state, "session-2");
    expect(boardedSessionIds(added)).toEqual(["session-1", "session-2"]);
    expect(added.cards[1]).toMatchObject({ col: 1, row: 0 });
    expect(added.excludedSessionIds).toEqual([]);
  });

  it("adds and removes files by root directory and path", () => {
    const state: SkiaBoardState = {
      cards: [sessionCard("session-1", 0, 0)],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };
    const added = addSkiaBoardFile(state, {
      rootDir: "/workspace",
      path: "docs/guide.md",
      name: "guide.md",
    });
    expect(added.cards[1]).toMatchObject({
      kind: "file",
      rootDir: "/workspace",
      path: "docs/guide.md",
      col: 1,
      row: 0,
    });
    expect(skiaBoardCardId(added.cards[1])).toBe("file:/workspace\ndocs/guide.md");
    expect(removeSkiaBoardFile(added, "/workspace", "docs/guide.md").cards).toEqual(state.cards);
  });

  it("adds and removes a directory shortcut by directory identity", () => {
    const state: SkiaBoardState = {
      cards: [sessionCard("session-1", 0, 0)],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };
    const added = addSkiaBoardDirectory(state, {
      directory: "/workspace/projects/bitty",
      name: "Bitty",
    });

    expect(added.cards[1]).toEqual({
      kind: "directory",
      directory: "/workspace/projects/bitty",
      col: 1,
      row: 0,
    });
    expect(skiaBoardCardId(added.cards[1])).toBe("directory:/workspace/projects/bitty");
    expect(skiaBoardDirectoryId(" /workspace/projects/bitty ")).toBe(
      "directory:/workspace/projects/bitty"
    );
    expect(addSkiaBoardDirectory(added, {
      directory: "/workspace/projects/bitty",
      name: "Renamed",
    })).toBe(added);
    expect(removeSkiaBoardDirectory(added, "/workspace/projects/bitty").cards).toEqual(
      state.cards
    );
  });

  it("keeps a moved or deleted file card in place and marks it unavailable", () => {
    const state: SkiaBoardState = {
      cards: [{
        kind: "file",
        rootDir: "/workspace",
        path: "docs/guide.md",
        col: 0.4,
        row: 2.1,
      }],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };

    const unavailable = markSkiaBoardFileUnavailable(state, "/workspace", "docs/guide.md");
    expect(unavailable.cards[0]).toEqual({ ...state.cards[0], unavailable: true });
    expect(markSkiaBoardFileUnavailable(unavailable, "/workspace", "docs/guide.md")).toBe(unavailable);
    expect(markSkiaBoardFileUnavailable(state, "/workspace", "missing.md")).toBe(state);

    // 同じパスが再作成されてExplorerから追加された場合は、位置を保って利用可能に戻す。
    const restored = addSkiaBoardFile(unavailable, {
      rootDir: "/workspace",
      path: "docs/guide.md",
      name: "guide restored.md",
    });
    expect(restored.cards[0]).toEqual({
      ...state.cards[0],
      unavailable: false,
    });
  });
});

describe("moveSkiaBoardCard / tidySkiaBoardCards", () => {
  it("moves a card to a free-form grid position", () => {
    const state: SkiaBoardState = {
      cards: [sessionCard("session-1", 0, 0)],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };
    const moved = moveSkiaBoardCard(state, "session:session-1", 1.25, -0.5);
    expect(moved.cards[0]).toMatchObject({ col: 1.25, row: -0.5 });
    expect(moveSkiaBoardCard(moved, "session:session-1", 1.25, -0.5)).toBe(moved);
    expect(moveSkiaBoardCard(moved, "unknown", 0, 0)).toBe(moved);
  });

  it("tidies cards back onto the grid in board order", () => {
    const state: SkiaBoardState = {
      cards: [
        sessionCard("session-1", 2.4, 5),
        sessionCard("session-2", -1, 0.2),
        sessionCard("session-3", 0.5, 0.5),
      ],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };
    const tidied = tidySkiaBoardCards(state);
    expect(tidied.cards.map((card) => [card.col, card.row])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(tidySkiaBoardCards(tidied)).toBe(tidied);
  });

  it("compacts visible cards first and retains hidden cards after them", () => {
    const state: SkiaBoardState = {
      cards: [
        sessionCard("visible-1", 4, 4),
        sessionCard("hidden", 5, 5),
        sessionCard("visible-2", 6, 6),
      ],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };

    const tidied = tidySkiaBoardCards(state, ["session:visible-1", "session:visible-2"]);

    expect(tidied.cards.map((card) => [skiaBoardCardId(card), card.col, card.row])).toEqual([
      ["session:visible-1", 0, 0],
      ["session:visible-2", 1, 0],
      ["session:hidden", 0, 1],
    ]);
  });
});

describe("board sections", () => {
  const state: SkiaBoardState = {
    cards: [],
    sections: [],
    excludedSessionIds: [],
    ingestedUpdatedAtMs: 0,
    cardTextScale: 1,
  };

  it("adds, edits, moves, and removes an independent section", () => {
    const added = addSkiaBoardSection(state, section());
    expect(added.sections).toEqual([section()]);
    expect(addSkiaBoardSection(added, section())).toBe(added);

    const updated = updateSkiaBoardSection(added, "section:1", {
      label: "実装",
      col: -0.25,
      colSpan: 3.5,
      color: "#22c55e",
      opacity: 0.6,
      borderOnly: true,
    });
    expect(updated.sections[0]).toEqual({
      ...section(),
      label: "実装",
      col: -0.25,
      colSpan: 3.5,
      color: "#22c55e",
      opacity: 0.6,
      borderOnly: true,
    });
    expect(removeSkiaBoardSection(updated, "section:1").sections).toEqual([]);
  });

  it("rejects invalid section updates and preserves other board state", () => {
    const added = addSkiaBoardSection(state, section());
    expect(addSkiaBoardSection(state, {
      ...section("section:tiny"),
      colSpan: Number.EPSILON,
      rowSpan: Number.EPSILON,
    })).toBe(state);
    expect(updateSkiaBoardSection(added, "section:1", { colSpan: 0 })).toBe(added);
    expect(updateSkiaBoardSection(added, "section:1", { color: "blue" })).toBe(added);
    expect(updateSkiaBoardSection(added, "section:1", {
      colSpan: Number.EPSILON,
      rowSpan: Number.EPSILON,
    })).toBe(added);
    expect(updateSkiaBoardSection(added, "missing", { label: "none" })).toBe(added);
    expect(removeSkiaBoardSection(added, "missing")).toBe(added);
  });

  it("migrates old payloads and sanitizes persisted sections", () => {
    expect(parseSkiaBoardState({
      cards: [],
      sections: [
        { ...section(), label: "", opacity: 3 },
        { ...section(), col: 9 },
        { ...section("section:bad"), color: "red" },
        {
          ...section("section:tiny"),
          colSpan: Number.EPSILON,
          rowSpan: Number.EPSILON,
        },
      ],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
    })?.sections).toEqual([{ ...section(), label: "セクション", opacity: 1 }]);
    expect(parseSkiaBoardState({
      cards: [sessionCard("session-1", 0, 0)],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
    })?.sections).toEqual([]);
  });

  it("keeps sections when sessions are initially ingested", () => {
    const sectionOnly = { ...state, sections: [section()] };
    const ingested = ingestSkiaBoardSessions(sectionOnly, [candidate(1)]);
    expect(ingested?.sections).toEqual([section()]);
    expect(boardedSessionIds(ingested)).toEqual(["session-1"]);
  });
});

describe("card text scale", () => {
  it("normalizes persisted values to the safe 0.8-1.2 range in 0.1 steps", () => {
    expect(normalizeSkiaBoardTextScale(undefined)).toBe(1);
    expect(normalizeSkiaBoardTextScale(null)).toBe(1);
    expect(normalizeSkiaBoardTextScale("")).toBe(1);
    expect(normalizeSkiaBoardTextScale(0.01)).toBe(0.8);
    expect(normalizeSkiaBoardTextScale(0.86)).toBe(0.9);
    expect(normalizeSkiaBoardTextScale(1.14)).toBe(1.1);
    expect(normalizeSkiaBoardTextScale(9)).toBe(1.2);
  });

  it("updates the existing board state without adding separate persistence", () => {
    const state: SkiaBoardState = {
      cards: [sessionCard("session-1", 0, 0)],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };
    expect(setSkiaBoardCardTextScale(state, 1.08).cardTextScale).toBe(1.1);
    expect(setSkiaBoardCardTextScale(state, 1)).toBe(state);
  });
});

describe("parseSkiaBoardState", () => {
  it("round-trips a serialized board state", () => {
    const state: SkiaBoardState = {
      cards: [
        sessionCard("session-1", 0.25, 1.5),
        sessionCard("session-2", 1, 0),
      ],
      sections: [],
      excludedSessionIds: ["session-9"],
      ingestedUpdatedAtMs: updatedAtMs(2),
      cardTextScale: 1.1,
    };
    expect(parseSkiaBoardState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("preserves the unavailable status of file cards", () => {
    expect(parseSkiaBoardState({
      cards: [{
        kind: "file",
        rootDir: "/workspace",
        path: "deleted.md",
        name: "deleted.md",
        col: 1,
        row: 2,
        unavailable: true,
      }],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
    })?.cards[0]).toMatchObject({ kind: "file", unavailable: true });
  });

  it("restores valid directory cards and drops malformed or unknown card kinds", () => {
    expect(parseSkiaBoardState({
      cards: [
        {
          kind: "directory",
          directory: "/workspace/projects/bitty",
          name: "Bitty",
          col: 1,
          row: 2,
        },
        { kind: "directory", directory: "", name: "Missing", col: 0, row: 0 },
        { kind: "future", sessionId: "must-not-migrate", col: 0, row: 0 },
      ],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
    })?.cards).toEqual([{
      kind: "directory",
      directory: "/workspace/projects/bitty",
      col: 1,
      row: 2,
    }]);
  });

  it("discards legacy names and restores only explicit appearance", () => {
    expect(parseSkiaBoardState({
      cards: [
        {
          kind: "file",
          rootDir: "/workspace",
          path: "docs/guide.md",
          name: "legacy.md",
          displayNameOverride: "Board guide",
          imagePath: "/Users/me/Pictures/guide.png",
          col: 0,
          row: 0,
        },
        {
          kind: "directory",
          directory: "/workspace",
          name: "legacy workspace",
          imagePath: "relative/image.png",
          col: 1,
          row: 0,
        },
      ],
      sections: [],
      excludedSessionIds: [],
    })?.cards).toEqual([
      {
        kind: "file",
        rootDir: "/workspace",
        path: "docs/guide.md",
        displayNameOverride: "Board guide",
        imagePath: "/Users/me/Pictures/guide.png",
        col: 0,
        row: 0,
      },
      { kind: "directory", directory: "/workspace", col: 1, row: 0 },
    ]);
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
      sections: [],
      excludedSessionIds: ["", "session-3", "session-3"],
      ingestedUpdatedAtMs: "not-a-number",
    })).toEqual({
      cards: [sessionCard("session-1", 0, 0)],
      sections: [],
      excludedSessionIds: ["session-3"],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    });
  });

  it("restores and bounds card text scale from the board payload", () => {
    expect(parseSkiaBoardState({
      cards: [],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 4,
    })?.cardTextScale).toBe(1.2);
    expect(parseSkiaBoardState({
      cards: [sessionCard("session-1", 0, 0)],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
    })?.cardTextScale).toBe(1);
    expect(parseSkiaBoardState({
      cards: [],
      sections: [],
      excludedSessionIds: [],
      cardTextScale: null,
    })).toBeNull();
    expect(parseSkiaBoardState({
      cards: [],
      sections: [],
      excludedSessionIds: [],
      cardTextScale: "",
    })).toBeNull();
  });
});

describe("board card appearance and file identity", () => {
  const state: SkiaBoardState = {
    cards: [
      { kind: "file", rootDir: "/workspace", path: "docs/guide.md", col: 0, row: 0 },
      { kind: "directory", directory: "/workspace/projects/bitty", col: 1, row: 0 },
    ],
    sections: [],
    excludedSessionIds: [],
    ingestedUpdatedAtMs: 0,
    cardTextScale: 1,
  };

  it("derives normal names and prefers explicit overrides", () => {
    const file = state.cards[0];
    const directory = state.cards[1];
    if (file.kind !== "file" || directory.kind !== "directory") throw new Error("bad fixture");
    expect(skiaBoardCardDisplayName(file)).toBe("guide.md");
    expect(skiaBoardCardDisplayName(directory, [{
      path: "/workspace/projects/bitty",
      displayName: "Bitty登録名",
    }])).toBe("Bitty登録名");
    expect(skiaBoardCardDisplayName({
      ...directory,
      displayNameOverride: "Board名",
    })).toBe("Board名");
  });

  it("sets and clears appearance without a display mode", () => {
    const cardId = skiaBoardCardId(state.cards[0]);
    const customized = updateSkiaBoardCardAppearance(state, cardId, {
      displayNameOverride: "Guide",
      imagePath: "/Users/me/Pictures/guide.png",
    });
    expect(customized.cards[0]).toMatchObject({
      displayNameOverride: "Guide",
      imagePath: "/Users/me/Pictures/guide.png",
    });
    expect(updateSkiaBoardCardAppearance(customized, cardId, {}).cards[0]).toEqual(state.cards[0]);
    expect(isAbsoluteRunnerHostPath("/tmp/image.png")).toBe(true);
    expect(isAbsoluteRunnerHostPath("C:\\Pictures\\image.png")).toBe(true);
    expect(isAbsoluteRunnerHostPath("Pictures/image.png")).toBe(false);
  });

  it("updates a renamed reference while preserving appearance and position", () => {
    const customized = updateSkiaBoardCardAppearance(state, skiaBoardCardId(state.cards[0]), {
      displayNameOverride: "Guide",
      imagePath: "/tmp/guide.png",
    });
    const renamed = renameSkiaBoardFile(customized, "/workspace", "docs/guide.md", "docs/new.md");
    expect(renamed.cards[0]).toEqual({
      kind: "file",
      rootDir: "/workspace",
      path: "docs/new.md",
      displayNameOverride: "Guide",
      imagePath: "/tmp/guide.png",
      col: 0,
      row: 0,
    });
  });

  it("keeps an existing destination and removes the renamed source", () => {
    const destination = {
      kind: "file" as const,
      rootDir: "/workspace",
      path: "docs/new.md",
      col: 2,
      row: 3,
    };
    const withDestination: SkiaBoardState = {
      ...state,
      cards: [state.cards[0], destination],
    };
    expect(renameSkiaBoardFile(
      withDestination,
      "/workspace",
      "docs/guide.md",
      "docs/new.md"
    ).cards).toEqual([destination]);
  });
});

describe("replacePersistedSkiaBoardState", () => {
  it("persists the replacement and notifies subscribers after the write", async () => {
    const mockMutate = jest.mocked(mutatePersistedSettings);
    mockMutate.mockClear();
    mockMutate.mockResolvedValue(undefined);
    const listener = jest.fn();
    const unsubscribe = subscribePersistedSkiaBoardStateReplaced(listener);
    const state: SkiaBoardState = {
      cards: [sessionCard("session-1", 0, 1)],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };

    await replacePersistedSkiaBoardState(state);

    expect(mockMutate).toHaveBeenCalledTimes(1);
    const mutate = mockMutate.mock.calls[0][0];
    expect(mutate({ runnerUrl: "http://kept" })).toEqual({
      runnerUrl: "http://kept",
      skiaBoardState: state,
    });
    expect(listener).toHaveBeenCalledWith(state);

    unsubscribe();
    listener.mockClear();
    await replacePersistedSkiaBoardState(state);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps notifying remaining subscribers when one listener throws", async () => {
    const mockMutate = jest.mocked(mutatePersistedSettings);
    mockMutate.mockClear();
    mockMutate.mockResolvedValue(undefined);
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const throwingListener = jest.fn(() => {
      throw new Error("listener failed");
    });
    const listener = jest.fn();
    const unsubscribeThrowing = subscribePersistedSkiaBoardStateReplaced(throwingListener);
    const unsubscribe = subscribePersistedSkiaBoardStateReplaced(listener);
    const state: SkiaBoardState = {
      cards: [],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };

    await expect(replacePersistedSkiaBoardState(state)).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledWith(state);

    unsubscribeThrowing();
    unsubscribe();
    jest.mocked(console.warn).mockRestore();
  });

  it("does not notify subscribers when the write fails", async () => {
    const mockMutate = jest.mocked(mutatePersistedSettings);
    mockMutate.mockClear();
    mockMutate.mockRejectedValue(new Error("write failed"));
    const listener = jest.fn();
    const unsubscribe = subscribePersistedSkiaBoardStateReplaced(listener);
    const state: SkiaBoardState = {
      cards: [],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
      cardTextScale: 1,
    };

    await expect(replacePersistedSkiaBoardState(state)).rejects.toThrow("write failed");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
