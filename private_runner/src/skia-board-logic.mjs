// Skiaボードのボード状態(カード・セクション・除外リスト・取り込み境界)の純ロジック。
// expo/src/features/app/utils/skiaBoardState.ts からの移植。ボードの正本はランナーが
// 持つため、カード操作・整頓・自動取り込みの計算はすべてサーバー側で行う。
//
// - カード位置はグリッド単位の自由座標(col/row、1.0 = カード1枚+ギャップ)。
//   カード幅(画面回転など)に依存しないため、保存位置が壊れない。
// - ingestedUpdatedAtMs は「最後に取り込んだupdatedAt」のウォーターマーク。
//   これ以下のセッションは自動追加しない(過去分の一括流入防止)。
// - セッションカードは directory / backendId を持てる(カード単独でセッションサマリを
//   問い合わせるための拡張。アプリ版スキーマには無い)。
// - cardTextScale は端末ローカル設定のため、ランナー側stateには含めない。

export const SKIA_BOARD_COLUMN_COUNT = 2;

// セクション最小スパンはアプリ側 skiaBoardSectionGeometry.ts と同じ定義で算出する。
const SKIA_BOARD_CARD_HEIGHT = 112;
const SKIA_BOARD_CARD_GAP = 18;
const SKIA_BOARD_MIN_CARD_WIDTH = 150;
const MIN_PERSISTED_SECTION_SIZE = 1;
export const SKIA_BOARD_MIN_SECTION_COL_SPAN = (
  (SKIA_BOARD_CARD_GAP + MIN_PERSISTED_SECTION_SIZE)
  / (SKIA_BOARD_MIN_CARD_WIDTH + SKIA_BOARD_CARD_GAP)
);
export const SKIA_BOARD_MIN_SECTION_ROW_SPAN = (
  (SKIA_BOARD_CARD_GAP + MIN_PERSISTED_SECTION_SIZE)
  / (SKIA_BOARD_CARD_HEIGHT + SKIA_BOARD_CARD_GAP)
);

const INITIAL_BOARD_CARD_COUNT = 6;

export function skiaBoardCardId(card) {
  if (card.kind === "session") return `session:${card.sessionId}`;
  if (card.kind === "directory") return skiaBoardDirectoryId(card.directory);
  return skiaBoardFileId(card.rootDir, card.path);
}

export function skiaBoardDirectoryId(directoryRaw) {
  return `directory:${String(directoryRaw || "").trim()}`;
}

export function skiaBoardFileId(rootDirRaw, pathRaw) {
  return `file:${String(rootDirRaw || "").trim()}\n${String(pathRaw || "").trim().replace(/\\/g, "/")}`;
}

export function isAbsoluteRunnerHostPath(valueRaw) {
  const value = String(valueRaw || "").trim();
  return /^[/\\]/.test(value) || /^[a-z]:[/\\]/i.test(value);
}

function parseCardAppearance(card) {
  const displayNameOverride = String(card.displayNameOverride || "").trim();
  const imagePath = String(card.imagePath || "").trim();
  return {
    ...(displayNameOverride ? { displayNameOverride } : {}),
    ...(isAbsoluteRunnerHostPath(imagePath) ? { imagePath } : {}),
  };
}

function updatedAtMs(value) {
  const time = new Date(String(value || "")).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function skiaBoardGridPosition(index) {
  return {
    col: index % SKIA_BOARD_COLUMN_COUNT,
    row: Math.floor(index / SKIA_BOARD_COLUMN_COUNT),
  };
}

// 既存カードと重ならない最初のグリッドセルを返す(新規カードの自動配置)。
// カードは自由座標なので「セル中心から1グリッド未満」を占有扱いにする。
export function findFreeSkiaBoardCell(cards) {
  for (let row = 0; ; row += 1) {
    for (let col = 0; col < SKIA_BOARD_COLUMN_COUNT; col += 1) {
      const occupied = cards.some(
        (card) => Math.abs(card.col - col) < 1 && Math.abs(card.row - row) < 1
      );
      if (!occupied) return { col, row };
    }
  }
}

export function parseSkiaBoardSection(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const section = raw;
  const id = String(section.id || "").trim();
  const col = Number(section.col);
  const row = Number(section.row);
  const colSpan = Number(section.colSpan);
  const rowSpan = Number(section.rowSpan);
  const color = String(section.color || "").trim();
  const opacity = Number(section.opacity);
  if (
    !id
    || !Number.isFinite(col)
    || !Number.isFinite(row)
    || !Number.isFinite(colSpan)
    || !Number.isFinite(rowSpan)
    || colSpan < SKIA_BOARD_MIN_SECTION_COL_SPAN
    || rowSpan < SKIA_BOARD_MIN_SECTION_ROW_SPAN
    || !/^#[0-9a-f]{6}$/i.test(color)
    || !Number.isFinite(opacity)
  ) return null;
  return {
    id,
    label: String(section.label || "").trim() || "セクション",
    col,
    row,
    colSpan,
    rowSpan,
    color,
    opacity: Math.max(0, Math.min(1, opacity)),
    borderOnly: section.borderOnly === true,
  };
}

export function parseSkiaBoardCard(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const card = raw;
  const col = Number(card.col);
  const row = Number(card.row);
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  if (card.kind === "file") {
    const rootDir = String(card.rootDir || "").trim();
    const path = String(card.path || "").trim().replace(/\\/g, "/");
    if (!rootDir || !path) return null;
    return {
      kind: "file",
      rootDir,
      path,
      col,
      row,
      ...parseCardAppearance(card),
      ...(card.unavailable === true ? { unavailable: true } : {}),
    };
  }
  if (card.kind === "directory") {
    const directory = String(card.directory || "").trim();
    if (!directory) return null;
    return {
      kind: "directory",
      directory,
      col,
      row,
      ...parseCardAppearance(card),
    };
  }
  if (card.kind !== undefined && card.kind !== "session") return null;
  // kind の無い既存保存データは session カードとして移行する。
  const sessionId = String(card.sessionId || "").trim();
  if (!sessionId) return null;
  const directory = String(card.directory || "").trim();
  const backendId = String(card.backendId || "").trim();
  return {
    kind: "session",
    sessionId,
    ...(directory ? { directory } : {}),
    ...(backendId ? { backendId } : {}),
    col,
    row,
  };
}

// unknown入力を常に正規のボードstateへ正規化する(空でもオブジェクトを返す)。
// 保存済みデータの読み込みと差分opの適用対象に使う。
export function normalizeSkiaBoardState(raw) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const cardsRaw = Array.isArray(record.cards) ? record.cards : [];
  const seenCardIds = new Set();
  const cards = [];
  for (const cardRaw of cardsRaw) {
    const card = parseSkiaBoardCard(cardRaw);
    if (!card) continue;
    const id = skiaBoardCardId(card);
    if (seenCardIds.has(id)) continue;
    seenCardIds.add(id);
    cards.push(card);
  }
  const excludedSessionIds = Array.from(new Set(
    (Array.isArray(record.excludedSessionIds) ? record.excludedSessionIds : [])
      .map((value) => String(value || "").trim())
      .filter((value) => !!value)
  ));
  const sectionsRaw = Array.isArray(record.sections) ? record.sections : [];
  const seenSectionIds = new Set();
  const sections = [];
  for (const sectionRaw of sectionsRaw) {
    const section = parseSkiaBoardSection(sectionRaw);
    if (!section || seenSectionIds.has(section.id)) continue;
    seenSectionIds.add(section.id);
    sections.push(section);
  }
  const ingestedUpdatedAtMsRaw = Number(record.ingestedUpdatedAtMs);
  return {
    cards,
    sections,
    excludedSessionIds,
    ingestedUpdatedAtMs: Number.isFinite(ingestedUpdatedAtMsRaw)
      ? Math.max(0, ingestedUpdatedAtMsRaw)
      : 0,
  };
}

// アプリ版 parseSkiaBoardState と同じ「実質空なら null」の判定つきパース。
// 引き継ぎ(import)の入力検証に使う。
export function parseSkiaBoardState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = normalizeSkiaBoardState(raw);
  if (
    state.cards.length <= 0
    && state.sections.length <= 0
    && state.excludedSessionIds.length <= 0
  ) return null;
  return state;
}

export function emptySkiaBoardState() {
  return { cards: [], sections: [], excludedSessionIds: [], ingestedUpdatedAtMs: 0 };
}

export function moveSkiaBoardCard(state, cardId, colRaw, rowRaw) {
  const col = Number(colRaw);
  const row = Number(rowRaw);
  if (!Number.isFinite(col) || !Number.isFinite(row)) return state;
  const index = state.cards.findIndex((card) => skiaBoardCardId(card) === cardId);
  if (index < 0) return state;
  const current = state.cards[index];
  if (current.col === col && current.row === row) return state;
  const cards = state.cards.slice();
  cards[index] = { ...current, col, row };
  return { ...state, cards };
}

function addSkiaBoardSessionCard(state, card) {
  const alreadyAdded = state.cards.some(
    (current) => current.kind === "session" && current.sessionId === card.sessionId
  );
  const excludedSessionIds = state.excludedSessionIds.filter((id) => id !== card.sessionId);
  if (alreadyAdded) {
    return excludedSessionIds.length === state.excludedSessionIds.length
      ? state
      : { ...state, excludedSessionIds };
  }
  const { col: _col, row: _row, ...identity } = card;
  return {
    ...state,
    cards: [
      ...state.cards,
      { ...identity, ...findFreeSkiaBoardCell(state.cards) },
    ],
    excludedSessionIds,
  };
}

function addSkiaBoardFileCard(state, card) {
  const id = skiaBoardCardId(card);
  const existingIndex = state.cards.findIndex((current) => skiaBoardCardId(current) === id);
  if (existingIndex >= 0) {
    const existing = state.cards[existingIndex];
    if (existing.kind !== "file" || !existing.unavailable) return state;
    const cards = state.cards.slice();
    const { unavailable: _unavailable, ...availableCard } = existing;
    cards[existingIndex] = availableCard;
    return { ...state, cards };
  }
  const { col: _col, row: _row, unavailable: _unavailable, ...identity } = card;
  return {
    ...state,
    cards: [
      ...state.cards,
      { ...identity, ...findFreeSkiaBoardCell(state.cards) },
    ],
  };
}

function addSkiaBoardDirectoryCard(state, card) {
  const id = skiaBoardCardId(card);
  if (state.cards.some((current) => skiaBoardCardId(current) === id)) return state;
  const { col: _col, row: _row, ...identity } = card;
  return {
    ...state,
    cards: [
      ...state.cards,
      { ...identity, ...findFreeSkiaBoardCell(state.cards) },
    ],
  };
}

// カード追加。配置セルはサーバー側で計算する(送信側の col/row は無視)。
export function addSkiaBoardCard(state, cardRaw) {
  const card = parseSkiaBoardCard(
    cardRaw && typeof cardRaw === "object" && !Array.isArray(cardRaw)
      ? { ...cardRaw, col: 0, row: 0 }
      : cardRaw
  );
  if (!card) return state;
  if (card.kind === "session") return addSkiaBoardSessionCard(state, card);
  if (card.kind === "file") return addSkiaBoardFileCard(state, card);
  return addSkiaBoardDirectoryCard(state, card);
}

// カード削除。sessionカードは以後の自動再追加を除外リストで防ぐ。
export function removeSkiaBoardCard(state, cardId) {
  const index = state.cards.findIndex((card) => skiaBoardCardId(card) === cardId);
  if (index < 0) return state;
  const card = state.cards[index];
  const cards = state.cards.filter((_, cardIndex) => cardIndex !== index);
  if (card.kind !== "session") return { ...state, cards };
  return {
    ...state,
    cards,
    excludedSessionIds: state.excludedSessionIds.includes(card.sessionId)
      ? state.excludedSessionIds
      : [...state.excludedSessionIds, card.sessionId],
  };
}

export function upsertSkiaBoardSection(state, sectionRaw) {
  const parsed = parseSkiaBoardSection(sectionRaw);
  if (!parsed) return state;
  const index = state.sections.findIndex((section) => section.id === parsed.id);
  if (index < 0) {
    return { ...state, sections: [...state.sections, parsed] };
  }
  const current = state.sections[index];
  if (
    current.label === parsed.label
    && current.col === parsed.col
    && current.row === parsed.row
    && current.colSpan === parsed.colSpan
    && current.rowSpan === parsed.rowSpan
    && current.color === parsed.color
    && current.opacity === parsed.opacity
    && current.borderOnly === parsed.borderOnly
  ) return state;
  const sections = state.sections.slice();
  sections[index] = parsed;
  return { ...state, sections };
}

export function removeSkiaBoardSectionById(state, sectionIdRaw) {
  const sectionId = String(sectionIdRaw || "").trim();
  if (!state.sections.some((section) => section.id === sectionId)) return state;
  return { ...state, sections: state.sections.filter((section) => section.id !== sectionId) };
}

export function updateSkiaBoardCardAppearance(state, cardId, appearance) {
  const index = state.cards.findIndex((card) => skiaBoardCardId(card) === cardId);
  if (index < 0) return state;
  const card = state.cards[index];
  if (card.kind === "session") return state;
  const record = appearance && typeof appearance === "object" && !Array.isArray(appearance)
    ? appearance
    : {};
  const displayNameOverride = String(record.displayNameOverride || "").trim();
  const imagePathRaw = String(record.imagePath || "").trim();
  const imagePath = isAbsoluteRunnerHostPath(imagePathRaw) ? imagePathRaw : "";
  if (
    (card.displayNameOverride || "") === displayNameOverride
    && (card.imagePath || "") === imagePath
  ) return state;
  const cards = state.cards.slice();
  const { displayNameOverride: _oldName, imagePath: _oldImagePath, ...identity } = card;
  cards[index] = {
    ...identity,
    ...(displayNameOverride ? { displayNameOverride } : {}),
    ...(imagePath ? { imagePath } : {}),
  };
  return { ...state, cards };
}

export function renameSkiaBoardFileCard(state, rootDir, previousPath, nextPath) {
  const previousId = skiaBoardFileId(rootDir, previousPath);
  const nextNormalizedPath = String(nextPath || "").trim().replace(/\\/g, "/");
  if (!nextNormalizedPath) return state;
  const previousIndex = state.cards.findIndex((card) => skiaBoardCardId(card) === previousId);
  if (previousIndex < 0) return state;
  const previousCard = state.cards[previousIndex];
  if (previousCard.kind !== "file") return state;
  const nextId = skiaBoardFileId(rootDir, nextNormalizedPath);
  if (nextId === previousId) return state;
  if (state.cards.some((card, index) => index !== previousIndex && skiaBoardCardId(card) === nextId)) {
    return {
      ...state,
      cards: state.cards.filter((_, index) => index !== previousIndex),
    };
  }
  const cards = state.cards.slice();
  const { unavailable: _unavailable, ...availableCard } = previousCard;
  cards[previousIndex] = { ...availableCard, path: nextNormalizedPath };
  return { ...state, cards };
}

export function setSkiaBoardFileCardUnavailable(state, rootDir, path, unavailable) {
  const id = skiaBoardFileId(rootDir, path);
  const index = state.cards.findIndex((card) => skiaBoardCardId(card) === id);
  if (index < 0) return state;
  const card = state.cards[index];
  if (card.kind !== "file") return state;
  const next = unavailable === true;
  if (Boolean(card.unavailable) === next) return state;
  const cards = state.cards.slice();
  if (next) {
    cards[index] = { ...card, unavailable: true };
  } else {
    const { unavailable: _unavailable, ...availableCard } = card;
    cards[index] = availableCard;
  }
  return { ...state, cards };
}

// 表示中カードを現在のボード順で先に詰め、非表示カードは保持したまま後ろへ送る。
// 全カードへ重複しないrow-major座標を振るため、非表示カードの再登場時も重ならない。
export function tidySkiaBoardCards(
  state,
  visibleCardIds = state.cards.map(skiaBoardCardId)
) {
  const visibleIds = new Set(
    (Array.isArray(visibleCardIds) ? visibleCardIds : []).map((value) => String(value || ""))
  );
  const orderedCards = [
    ...state.cards.filter((card) => visibleIds.has(skiaBoardCardId(card))),
    ...state.cards.filter((card) => !visibleIds.has(skiaBoardCardId(card))),
  ];
  let changed = false;
  const cards = orderedCards.map((card, index) => {
    const position = skiaBoardGridPosition(index);
    if (
      card === state.cards[index]
      && card.col === position.col
      && card.row === position.row
    ) return card;
    changed = true;
    return { ...card, ...position };
  });
  return changed ? { ...state, cards } : state;
}

// 候補セッションをボードへ取り込む。変化がなければ同一参照を返す(永続化抑制)。
// - 保存済みカード/除外/ウォーターマークが無い場合: 最新 INITIAL_BOARD_CARD_COUNT 件で
//   グリッド初期化。ウォーターマークは全候補の最大updatedAtにし、過去分が後から流れ込まない。
// - 以降: 未搭載・未除外かつ updatedAt がウォーターマークより新しい候補だけを空きセルへ追加する。
export function ingestSkiaBoardSessions(state, candidates) {
  const sessionCardOf = (candidate, position) => {
    const directory = String(candidate.directory || "").trim();
    const backendId = String(candidate.backendId || "").trim();
    return {
      kind: "session",
      sessionId: candidate.sessionId,
      ...(directory ? { directory } : {}),
      ...(backendId ? { backendId } : {}),
      ...position,
    };
  };
  const needsInitialSessions = !state || (
    state.cards.length === 0
    && state.excludedSessionIds.length === 0
    && state.ingestedUpdatedAtMs === 0
  );
  if (needsInitialSessions) {
    if (candidates.length <= 0) return state;
    return {
      cards: candidates.slice(0, INITIAL_BOARD_CARD_COUNT).map((candidate, index) => (
        sessionCardOf(candidate, skiaBoardGridPosition(index))
      )),
      sections: state?.sections || [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: candidates.reduce(
        (max, candidate) => Math.max(max, updatedAtMs(candidate.updatedAt)),
        0
      ),
    };
  }
  if (
    state.cards.length > 0
    && !state.cards.some((card) => card.kind === "session")
    && state.excludedSessionIds.length === 0
    && state.ingestedUpdatedAtMs === 0
  ) {
    const cards = state.cards.slice();
    for (const candidate of candidates.slice(0, INITIAL_BOARD_CARD_COUNT)) {
      cards.push(sessionCardOf(candidate, findFreeSkiaBoardCell(cards)));
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
    cards.push(sessionCardOf(candidate, findFreeSkiaBoardCell(cards)));
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
