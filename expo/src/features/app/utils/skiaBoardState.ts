import {
  mutatePersistedSettings,
  readPersistedSettingsField,
  SKIA_BOARD_STATE_FIELD,
} from "./persistedSettingsFile";
import {
  SKIA_BOARD_MIN_SECTION_COL_SPAN,
  SKIA_BOARD_MIN_SECTION_ROW_SPAN,
} from "./skiaBoardSectionGeometry";

// Skiaボードの「ボードステート」(カードと独立セクションの自由配置・除外リスト・取り込み境界)の
// 純ロジック。永続化は設定JSONの SKIA_BOARD_STATE_FIELD に保存し、設定オートセーブ
// からは PRESERVED_SETTINGS_FIELDS 経由で保護される。
//
// - カード位置はグリッド単位の自由座標(col/row、1.0 = カード1枚+ギャップ)。
//   カード幅(画面回転など)に依存しないため、保存位置が壊れない。
// - ingestedUpdatedAtMs は「最後に取り込んだupdatedAt」のウォーターマーク。
//   これ以下のセッションは自動追加しない(過去分の一括流入防止)。

export const SKIA_BOARD_COLUMN_COUNT = 2;
export const SKIA_BOARD_DEFAULT_TEXT_SCALE = 1;
export const SKIA_BOARD_MIN_TEXT_SCALE = 0.8;
export const SKIA_BOARD_MAX_TEXT_SCALE = 1.2;
export const SKIA_BOARD_TEXT_SCALE_STEP = 0.1;
const INITIAL_BOARD_CARD_COUNT = 6;

type SkiaBoardCardPosition = {
  col: number;
  row: number;
};

type SkiaBoardCardAppearance = {
  displayNameOverride?: string;
  imagePath?: string;
};

export type SkiaBoardSessionCard = SkiaBoardCardPosition & {
  kind: "session";
  sessionId: string;
  // カード単独でランナーへサマリを問い合わせるための出所情報(ランナー側スキーマ拡張)。
  directory?: string;
  backendId?: string;
};

export type SkiaBoardFileCard = SkiaBoardCardPosition & SkiaBoardCardAppearance & {
  kind: "file";
  rootDir: string;
  path: string;
  unavailable?: boolean;
};

export type SkiaBoardDirectoryCard = SkiaBoardCardPosition & SkiaBoardCardAppearance & {
  kind: "directory";
  directory: string;
};

export type SkiaBoardCard =
  | SkiaBoardSessionCard
  | SkiaBoardFileCard
  | SkiaBoardDirectoryCard;

export type SkiaBoardSection = {
  id: string;
  label: string;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  color: string;
  opacity: number;
  borderOnly: boolean;
};

function parseSkiaBoardSection(raw: unknown): SkiaBoardSection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const section = raw as Record<string, unknown>;
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

export type SkiaBoardState = {
  cards: SkiaBoardCard[];
  sections: SkiaBoardSection[];
  excludedSessionIds: string[];
  ingestedUpdatedAtMs: number;
  cardTextScale: number;
};

export type SkiaBoardSessionCandidate = {
  sessionId: string;
  updatedAt?: unknown;
};

export function skiaBoardCardId(card: SkiaBoardCard): string {
  if (card.kind === "session") return `session:${card.sessionId}`;
  if (card.kind === "directory") return skiaBoardDirectoryId(card.directory);
  return `file:${card.rootDir}\n${card.path}`;
}

export function skiaBoardDirectoryId(directoryRaw: unknown): string {
  return `directory:${String(directoryRaw || "").trim()}`;
}

export function skiaBoardFileId(rootDirRaw: unknown, pathRaw: unknown): string {
  return `file:${String(rootDirRaw || "").trim()}\n${String(pathRaw || "").trim().replace(/\\/g, "/")}`;
}

export function isAbsoluteRunnerHostPath(valueRaw: unknown): boolean {
  const value = String(valueRaw || "").trim();
  return /^[/\\]/.test(value) || /^[a-z]:[/\\]/i.test(value);
}

function parseCardAppearance(card: Record<string, unknown>): SkiaBoardCardAppearance {
  const displayNameOverride = String(card.displayNameOverride || "").trim();
  const imagePath = String(card.imagePath || "").trim();
  return {
    ...(displayNameOverride ? { displayNameOverride } : {}),
    ...(isAbsoluteRunnerHostPath(imagePath) ? { imagePath } : {}),
  };
}

export function skiaBoardCardDisplayName(
  card: SkiaBoardFileCard | SkiaBoardDirectoryCard,
  registeredDirectories: readonly { path: string; displayName: string }[] = []
): string {
  if (card.displayNameOverride) return card.displayNameOverride;
  if (card.kind === "file") {
    return card.path.split("/").filter(Boolean).pop() || card.path;
  }
  const registeredName = registeredDirectories.find(
    (directory) => String(directory.path || "").trim() === card.directory
  )?.displayName;
  return String(registeredName || "").trim()
    || card.directory.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop()
    || card.directory;
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

export function normalizeSkiaBoardTextScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return SKIA_BOARD_DEFAULT_TEXT_SCALE;
  }
  const numeric = value;
  const stepped = Math.round(numeric / SKIA_BOARD_TEXT_SCALE_STEP) * SKIA_BOARD_TEXT_SCALE_STEP;
  return Math.max(
    SKIA_BOARD_MIN_TEXT_SCALE,
    Math.min(SKIA_BOARD_MAX_TEXT_SCALE, Number(stepped.toFixed(1)))
  );
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
      const parsed: SkiaBoardFileCard = {
        kind: "file",
        rootDir,
        path,
        col,
        row,
        ...parseCardAppearance(card),
        ...(card.unavailable === true ? { unavailable: true } : {}),
      };
      const id = skiaBoardCardId(parsed);
      if (seenCardIds.has(id)) continue;
      seenCardIds.add(id);
      cards.push(parsed);
      continue;
    }
    if (card.kind === "directory") {
      const directory = String(card.directory || "").trim();
      if (!directory) continue;
      const parsed: SkiaBoardDirectoryCard = {
        kind: "directory",
        directory,
        col,
        row,
        ...parseCardAppearance(card),
      };
      const id = skiaBoardCardId(parsed);
      if (seenCardIds.has(id)) continue;
      seenCardIds.add(id);
      cards.push(parsed);
      continue;
    }
    if (card.kind !== undefined && card.kind !== "session") continue;
    // kind の無い既存保存データは session カードとして移行する。
    const sessionId = String(card.sessionId || "").trim();
    if (!sessionId) continue;
    const directory = String(card.directory || "").trim();
    const backendId = String(card.backendId || "").trim();
    const parsed: SkiaBoardSessionCard = {
      kind: "session",
      sessionId,
      ...(directory ? { directory } : {}),
      ...(backendId ? { backendId } : {}),
      col,
      row,
    };
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
  const sectionsRaw = Array.isArray(record.sections) ? record.sections : [];
  const seenSectionIds = new Set<string>();
  const sections: SkiaBoardSection[] = [];
  for (const sectionRaw of sectionsRaw) {
    const section = parseSkiaBoardSection(sectionRaw);
    if (!section || seenSectionIds.has(section.id)) continue;
    seenSectionIds.add(section.id);
    sections.push(section);
  }
  const ingestedUpdatedAtMsRaw = Number(record.ingestedUpdatedAtMs);
  const hasStoredTextScale = (
    typeof record.cardTextScale === "number"
    && Number.isFinite(record.cardTextScale)
  );
  if (
    cards.length <= 0
    && sections.length <= 0
    && excludedSessionIds.length <= 0
    && !hasStoredTextScale
  ) return null;
  return {
    cards,
    sections,
    excludedSessionIds,
    ingestedUpdatedAtMs: Number.isFinite(ingestedUpdatedAtMsRaw)
      ? Math.max(0, ingestedUpdatedAtMsRaw)
      : 0,
    cardTextScale: normalizeSkiaBoardTextScale(record.cardTextScale),
  };
}

// 候補セッションをボードへ取り込む。変化がなければ同一参照を返す(永続化抑制)。
// - 保存済みカード/除外/ウォーターマークが無い場合: 最新 INITIAL_BOARD_CARD_COUNT 件で
//   グリッド初期化。文字倍率だけが保存済みなら、その値は引き継ぐ。
//   ウォーターマークは全候補の最大updatedAtにし、既存の過去分が後から流れ込まない。
// - 以降: 未搭載・未除外かつ updatedAt がウォーターマークより新しい候補だけを
//   空きセルへ追加する。既存カードの位置は動かさない。
export function ingestSkiaBoardSessions(
  state: SkiaBoardState | null,
  candidates: readonly SkiaBoardSessionCandidate[]
): SkiaBoardState | null {
  const needsInitialSessions = !state || (
    state.cards.length === 0
    && state.excludedSessionIds.length === 0
    && state.ingestedUpdatedAtMs === 0
  );
  if (needsInitialSessions) {
    if (candidates.length <= 0) return state;
    return {
      ...state,
      cards: candidates.slice(0, INITIAL_BOARD_CARD_COUNT).map((candidate, index) => ({
        kind: "session" as const,
        sessionId: candidate.sessionId,
        ...skiaBoardGridPosition(index),
      })),
      excludedSessionIds: [],
      sections: state?.sections || [],
      ingestedUpdatedAtMs: candidates.reduce(
        (max, candidate) => Math.max(max, updatedAtMs(candidate.updatedAt)),
        0
      ),
      cardTextScale: state?.cardTextScale ?? SKIA_BOARD_DEFAULT_TEXT_SCALE,
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

export function addSkiaBoardSection(
  state: SkiaBoardState,
  section: SkiaBoardSection
): SkiaBoardState {
  const parsed = parseSkiaBoardSection(section);
  if (!parsed || state.sections.some((current) => current.id === parsed.id)) return state;
  return { ...state, sections: [...state.sections, parsed] };
}

export function updateSkiaBoardSection(
  state: SkiaBoardState,
  sectionId: string,
  update: Partial<Omit<SkiaBoardSection, "id">>
): SkiaBoardState {
  const index = state.sections.findIndex((section) => section.id === sectionId);
  if (index < 0) return state;
  const current = state.sections[index];
  const next = parseSkiaBoardSection({ ...current, ...update, id: current.id });
  if (!next) return state;
  if (
    current.label === next.label
    && current.col === next.col
    && current.row === next.row
    && current.colSpan === next.colSpan
    && current.rowSpan === next.rowSpan
    && current.color === next.color
    && current.opacity === next.opacity
    && current.borderOnly === next.borderOnly
  ) return state;
  const sections = state.sections.slice();
  sections[index] = next;
  return { ...state, sections };
}

export function removeSkiaBoardSection(
  state: SkiaBoardState,
  sectionId: string
): SkiaBoardState {
  if (!state.sections.some((section) => section.id === sectionId)) return state;
  return { ...state, sections: state.sections.filter((section) => section.id !== sectionId) };
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

export function addSkiaBoardSession(
  state: SkiaBoardState,
  sessionIdRaw: unknown,
  meta: { directory?: string; backendId?: string } = {}
): SkiaBoardState {
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
  const directory = String(meta.directory || "").trim();
  const backendId = String(meta.backendId || "").trim();
  return {
    ...state,
    cards: [
      ...state.cards,
      {
        kind: "session",
        sessionId,
        ...(directory ? { directory } : {}),
        ...(backendId ? { backendId } : {}),
        ...findFreeSkiaBoardCell(state.cards),
      },
    ],
    excludedSessionIds,
  };
}

export function addSkiaBoardFile(
  state: SkiaBoardState,
  file: { rootDir: string; path: string; name?: string }
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
        ...findFreeSkiaBoardCell(state.cards),
      },
    ],
  };
}

export function addSkiaBoardDirectory(
  state: SkiaBoardState,
  target: { directory: string; name?: string }
): SkiaBoardState {
  const directory = String(target.directory || "").trim();
  if (!directory) return state;
  const id = skiaBoardDirectoryId(directory);
  if (state.cards.some((card) => skiaBoardCardId(card) === id)) return state;
  return {
    ...state,
    cards: [
      ...state.cards,
      { kind: "directory", directory, ...findFreeSkiaBoardCell(state.cards) },
    ],
  };
}

export function updateSkiaBoardCardAppearance(
  state: SkiaBoardState,
  cardId: string,
  appearance: SkiaBoardCardAppearance
): SkiaBoardState {
  const index = state.cards.findIndex((card) => skiaBoardCardId(card) === cardId);
  if (index < 0) return state;
  const card = state.cards[index];
  if (card.kind === "session") return state;
  const displayNameOverride = String(appearance.displayNameOverride || "").trim();
  const imagePathRaw = String(appearance.imagePath || "").trim();
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

export function renameSkiaBoardFile(
  state: SkiaBoardState,
  rootDir: string,
  previousPath: string,
  nextPath: string
): SkiaBoardState {
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

export function removeSkiaBoardDirectory(
  state: SkiaBoardState,
  directory: string
): SkiaBoardState {
  const id = skiaBoardDirectoryId(directory);
  if (!state.cards.some((card) => skiaBoardCardId(card) === id)) return state;
  return { ...state, cards: state.cards.filter((card) => skiaBoardCardId(card) !== id) };
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

// 表示中カードを現在のボード順で先に詰め、非表示カードは保持したまま後ろへ送る。
// 全カードへ重複しないrow-major座標を振るため、非表示カードの再登場時も重ならない。
export function tidySkiaBoardCards(
  state: SkiaBoardState,
  visibleCardIds: readonly string[] = state.cards.map(skiaBoardCardId)
): SkiaBoardState {
  const visibleIds = new Set(visibleCardIds);
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

export function setSkiaBoardCardTextScale(
  state: SkiaBoardState,
  value: unknown
): SkiaBoardState {
  const cardTextScale = normalizeSkiaBoardTextScale(value);
  return cardTextScale === state.cardTextScale ? state : { ...state, cardTextScale };
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

type PersistedSkiaBoardStateReplacedListener = (state: SkiaBoardState) => void;
const persistedStateReplacedListeners = new Set<PersistedSkiaBoardStateReplacedListener>();

// SkiaBoardProviderが購読し、UI外からの一括置換をメモリ上のボードstateへ反映する。
export function subscribePersistedSkiaBoardStateReplaced(
  listener: PersistedSkiaBoardStateReplacedListener
): () => void {
  persistedStateReplacedListeners.add(listener);
  return () => {
    persistedStateReplacedListeners.delete(listener);
  };
}

// ボードUI外(設定インポート等)からの一括置換。保存後に購読者へ通知しないと、
// ボードがメモリに保持する旧stateが次の永続化で置換内容を上書きしてしまう。
// リスナーの例外は保存済みという結果を覆さないよう、通知失敗として警告に留める。
export async function replacePersistedSkiaBoardState(state: SkiaBoardState): Promise<void> {
  await writePersistedSkiaBoardState(state);
  for (const listener of persistedStateReplacedListeners) {
    try {
      listener(state);
    } catch (error) {
      console.warn("[skia_board] board state replacement listener failed", error);
    }
  }
}
