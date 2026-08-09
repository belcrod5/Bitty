import {
  mutatePersistedSettings,
  readPersistedSettingsField,
  SKIA_BOARD_STATE_FIELD,
} from "./persistedSettingsFile";

// Skiaボードの「ボードステート」(セッション/ファイルカードの自由配置・除外リスト・取り込み境界)の
// 純ロジック。永続化は設定JSONの SKIA_BOARD_STATE_FIELD に保存し、設定オートセーブ
// からは PRESERVED_SETTINGS_FIELDS 経由で保護される。
//
// - カード位置はグリッド単位の自由座標(col/row、1.0 = カード1枚+ギャップ)。
//   カード幅(画面回転など)に依存しないため、保存位置が壊れない。
// - ingestedUpdatedAtMs は「最後に取り込んだupdatedAt」のウォーターマーク。
//   これ以下のセッションは自動追加しない(過去分の一括流入防止)。

export const SKIA_BOARD_COLUMN_COUNT = 2;
const INITIAL_BOARD_CARD_COUNT = 6;

type SkiaBoardCardPosition = {
  col: number;
  row: number;
};

export type SkiaBoardSessionCard = SkiaBoardCardPosition & {
  kind: "session";
  sessionId: string;
};

export type SkiaBoardFileCard = SkiaBoardCardPosition & {
  kind: "file";
  rootDir: string;
  path: string;
  name: string;
  unavailable?: boolean;
};

export type SkiaBoardCard = SkiaBoardSessionCard | SkiaBoardFileCard;

export type SkiaBoardState = {
  cards: SkiaBoardCard[];
  excludedSessionIds: string[];
  ingestedUpdatedAtMs: number;
};

export type SkiaBoardSessionCandidate = {
  sessionId: string;
  updatedAt?: unknown;
};

export function skiaBoardCardId(card: SkiaBoardCard): string {
  return card.kind === "session"
    ? `session:${card.sessionId}`
    : `file:${card.rootDir}\n${card.path}`;
}

export function skiaBoardFileId(rootDirRaw: unknown, pathRaw: unknown): string {
  return `file:${String(rootDirRaw || "").trim()}\n${String(pathRaw || "").trim().replace(/\\/g, "/")}`;
}

function updatedAtMs(value: unknown) {
  const time = new Date(String(value || "")).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function skiaBoardGridPosition(index: number): { col: number; row: number } {
  return {
    col: index % SKIA_BOARD_COLUMN_COUNT,
    row: Math.floor(index / SKIA_BOARD_COLUMN_COUNT),
  };
}

// 既存カードと重ならない最初のグリッドセルを返す(新規カードの自動配置)。
// カードは自由座標なので「セル中心から1グリッド未満」を占有扱いにする。
export function findFreeSkiaBoardCell(cards: readonly SkiaBoardCard[]): { col: number; row: number } {
  for (let row = 0; ; row += 1) {
    for (let col = 0; col < SKIA_BOARD_COLUMN_COUNT; col += 1) {
      const occupied = cards.some(
        (card) => Math.abs(card.col - col) < 1 && Math.abs(card.row - row) < 1
      );
      if (!occupied) return { col, row };
    }
  }
}

export function parseSkiaBoardState(raw: unknown): SkiaBoardState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const cardsRaw = Array.isArray(record.cards) ? record.cards : [];
  const seenCardIds = new Set<string>();
  const cards: SkiaBoardCard[] = [];
  for (const cardRaw of cardsRaw) {
    if (!cardRaw || typeof cardRaw !== "object" || Array.isArray(cardRaw)) continue;
    const card = cardRaw as Record<string, unknown>;
    const col = Number(card.col);
    const row = Number(card.row);
    if (!Number.isFinite(col) || !Number.isFinite(row)) continue;
    if (card.kind === "file") {
      const rootDir = String(card.rootDir || "").trim();
      const path = String(card.path || "").trim().replace(/\\/g, "/");
      if (!rootDir || !path) continue;
      const name = String(card.name || "").trim()
        || path.split("/").filter(Boolean).pop()
        || path;
      const parsed: SkiaBoardFileCard = {
        kind: "file",
        rootDir,
        path,
        name,
        col,
        row,
        ...(card.unavailable === true ? { unavailable: true } : {}),
      };
      const id = skiaBoardCardId(parsed);
      if (seenCardIds.has(id)) continue;
      seenCardIds.add(id);
      cards.push(parsed);
      continue;
    }
    // kind の無い既存保存データは session カードとして移行する。
    const sessionId = String(card.sessionId || "").trim();
    if (!sessionId) continue;
    const parsed: SkiaBoardSessionCard = { kind: "session", sessionId, col, row };
    const id = skiaBoardCardId(parsed);
    if (seenCardIds.has(id)) continue;
    seenCardIds.add(id);
    cards.push(parsed);
  }
  const excludedSessionIds = Array.from(new Set(
    (Array.isArray(record.excludedSessionIds) ? record.excludedSessionIds : [])
      .map((value) => String(value || "").trim())
      .filter((value) => !!value)
  ));
  const ingestedUpdatedAtMsRaw = Number(record.ingestedUpdatedAtMs);
  if (cards.length <= 0 && excludedSessionIds.length <= 0) return null;
  return {
    cards,
    excludedSessionIds,
    ingestedUpdatedAtMs: Number.isFinite(ingestedUpdatedAtMsRaw)
      ? Math.max(0, ingestedUpdatedAtMsRaw)
      : 0,
  };
}

// 候補セッションをボードへ取り込む。変化がなければ同一参照を返す(永続化抑制)。
// - 保存済みステートが無い場合: 最新 INITIAL_BOARD_CARD_COUNT 件でグリッド初期化。
//   ウォーターマークは全候補の最大updatedAtにし、既存の過去分が後から流れ込まない。
// - 以降: 未搭載・未除外かつ updatedAt がウォーターマークより新しい候補だけを
//   空きセルへ追加する。既存カードの位置は動かさない。
export function ingestSkiaBoardSessions(
  state: SkiaBoardState | null,
  candidates: readonly SkiaBoardSessionCandidate[]
): SkiaBoardState | null {
  if (!state) {
    if (candidates.length <= 0) return null;
    return {
      cards: candidates.slice(0, INITIAL_BOARD_CARD_COUNT).map((candidate, index) => ({
        kind: "session" as const,
        sessionId: candidate.sessionId,
        ...skiaBoardGridPosition(index),
      })),
      excludedSessionIds: [],
      ingestedUpdatedAtMs: candidates.reduce(
        (max, candidate) => Math.max(max, updatedAtMs(candidate.updatedAt)),
        0
      ),
    };
  }
  if (
    state.cards.some((card) => card.kind === "file")
    && !state.cards.some((card) => card.kind === "session")
    && state.excludedSessionIds.length === 0
    && state.ingestedUpdatedAtMs === 0
  ) {
    const cards = state.cards.slice();
    for (const candidate of candidates.slice(0, INITIAL_BOARD_CARD_COUNT)) {
      cards.push({
        kind: "session",
        sessionId: candidate.sessionId,
        ...findFreeSkiaBoardCell(cards),
      });
    }
    return {
      ...state,
      cards,
      ingestedUpdatedAtMs: candidates.reduce(
        (max, candidate) => Math.max(max, updatedAtMs(candidate.updatedAt)),
        0
      ),
    };
  }
  const boardedSessionIds = new Set(state.cards.flatMap((card) => (
    card.kind === "session" ? [card.sessionId] : []
  )));
  const excludedSessionIds = new Set(state.excludedSessionIds);
  const additions = candidates
    .filter((candidate) => (
      !boardedSessionIds.has(candidate.sessionId)
      && !excludedSessionIds.has(candidate.sessionId)
      && updatedAtMs(candidate.updatedAt) > state.ingestedUpdatedAtMs
    ))
    // 古い順に空きセルへ積む(新しいものほど後ろのセル)。
    .sort((a, b) => updatedAtMs(a.updatedAt) - updatedAtMs(b.updatedAt));
  if (additions.length <= 0) return state;
  const cards = state.cards.slice();
  for (const candidate of additions) {
    cards.push({
      kind: "session",
      sessionId: candidate.sessionId,
      ...findFreeSkiaBoardCell(cards),
    });
  }
  return {
    ...state,
    cards,
    ingestedUpdatedAtMs: additions.reduce(
      (max, candidate) => Math.max(max, updatedAtMs(candidate.updatedAt)),
      state.ingestedUpdatedAtMs
    ),
  };
}

export function moveSkiaBoardCard(
  state: SkiaBoardState,
  cardId: string,
  col: number,
  row: number
): SkiaBoardState {
  if (!Number.isFinite(col) || !Number.isFinite(row)) return state;
  const index = state.cards.findIndex((card) => skiaBoardCardId(card) === cardId);
  if (index < 0) return state;
  const current = state.cards[index];
  if (current.col === col && current.row === row) return state;
  const cards = state.cards.slice();
  cards[index] = { ...current, col, row };
  return { ...state, cards };
}

// カードをボードから外し、以後の自動再追加を除外リストで防ぐ。
export function removeSkiaBoardSession(state: SkiaBoardState, sessionId: string): SkiaBoardState {
  if (!state.cards.some((card) => card.kind === "session" && card.sessionId === sessionId)) return state;
  return {
    ...state,
    cards: state.cards.filter((card) => card.kind !== "session" || card.sessionId !== sessionId),
    excludedSessionIds: state.excludedSessionIds.includes(sessionId)
      ? state.excludedSessionIds
      : [...state.excludedSessionIds, sessionId],
  };
}

export function addSkiaBoardSession(state: SkiaBoardState, sessionIdRaw: unknown): SkiaBoardState {
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return state;
  const alreadyAdded = state.cards.some(
    (card) => card.kind === "session" && card.sessionId === sessionId
  );
  const excludedSessionIds = state.excludedSessionIds.filter((id) => id !== sessionId);
  if (alreadyAdded) {
    return excludedSessionIds.length === state.excludedSessionIds.length
      ? state
      : { ...state, excludedSessionIds };
  }
  return {
    ...state,
    cards: [
      ...state.cards,
      { kind: "session", sessionId, ...findFreeSkiaBoardCell(state.cards) },
    ],
    excludedSessionIds,
  };
}

export function addSkiaBoardFile(
  state: SkiaBoardState,
  file: { rootDir: string; path: string; name: string }
): SkiaBoardState {
  const rootDir = String(file.rootDir || "").trim();
  const path = String(file.path || "").trim().replace(/\\/g, "/");
  if (!rootDir || !path) return state;
  const id = skiaBoardFileId(rootDir, path);
  const existingIndex = state.cards.findIndex((card) => skiaBoardCardId(card) === id);
  if (existingIndex >= 0) {
    const existing = state.cards[existingIndex];
    if (existing.kind !== "file" || !existing.unavailable) return state;
    const cards = state.cards.slice();
    cards[existingIndex] = {
      ...existing,
      name: String(file.name || "").trim() || path.split("/").filter(Boolean).pop() || path,
      unavailable: false,
    };
    return { ...state, cards };
  }
  return {
    ...state,
    cards: [
      ...state.cards,
      {
        kind: "file",
        rootDir,
        path,
        name: String(file.name || "").trim() || path.split("/").filter(Boolean).pop() || path,
        ...findFreeSkiaBoardCell(state.cards),
      },
    ],
  };
}

export function markSkiaBoardFileUnavailable(
  state: SkiaBoardState,
  rootDir: string,
  path: string
): SkiaBoardState {
  const id = skiaBoardFileId(rootDir, path);
  const index = state.cards.findIndex((card) => skiaBoardCardId(card) === id);
  if (index < 0) return state;
  const card = state.cards[index];
  if (card.kind !== "file" || card.unavailable) return state;
  const cards = state.cards.slice();
  cards[index] = { ...card, unavailable: true };
  return { ...state, cards };
}

export function removeSkiaBoardFile(
  state: SkiaBoardState,
  rootDir: string,
  path: string
): SkiaBoardState {
  const id = skiaBoardFileId(rootDir, path);
  if (!state.cards.some((card) => skiaBoardCardId(card) === id)) return state;
  return { ...state, cards: state.cards.filter((card) => skiaBoardCardId(card) !== id) };
}

// 現在の並び順のままグリッドへ整列する(ビューポートは触らない)。
export function tidySkiaBoardCards(state: SkiaBoardState): SkiaBoardState {
  let changed = false;
  const cards = state.cards.map((card, index) => {
    const position = skiaBoardGridPosition(index);
    if (card.col === position.col && card.row === position.row) return card;
    changed = true;
    return { ...card, ...position };
  });
  return changed ? { ...state, cards } : state;
}

export async function readPersistedSkiaBoardState(): Promise<SkiaBoardState | null> {
  return parseSkiaBoardState(await readPersistedSettingsField(SKIA_BOARD_STATE_FIELD));
}

export function writePersistedSkiaBoardState(state: SkiaBoardState): Promise<void> {
  return mutatePersistedSettings((current) => ({
    ...current,
    [SKIA_BOARD_STATE_FIELD]: state,
  }));
}
