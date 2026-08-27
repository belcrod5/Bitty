import {
  addSkiaBoardDirectory,
  addSkiaBoardFile,
  addSkiaBoardSection,
  addSkiaBoardSession,
  markSkiaBoardFileUnavailable,
  moveSkiaBoardCard,
  removeSkiaBoardDirectory,
  removeSkiaBoardFile,
  removeSkiaBoardSection,
  removeSkiaBoardSession,
  renameSkiaBoardFile,
  tidySkiaBoardCards,
  updateSkiaBoardCardAppearance,
  updateSkiaBoardSection,
  type SkiaBoardCard,
  type SkiaBoardSection,
  type SkiaBoardState,
} from "./skiaBoardState";

// ランナーの POST /skia-board/ops へ送る操作。サーバー側 skia-board-logic.mjs の
// OP_APPLIERS と1:1対応する。楽観反映には applySkiaBoardOpLocally で同じ意味の
// ローカル純関数を適用し、サーバー確定時に正本へ置き換える。

export type SkiaBoardOp =
  | { type: "moveCard"; cardId: string; col: number; row: number }
  | { type: "addCard"; card: SkiaBoardAddCardPayload }
  | { type: "removeCard"; cardId: string }
  | { type: "upsertSection"; section: SkiaBoardSection }
  | { type: "removeSection"; sectionId: string }
  | { type: "updateCardAppearance"; cardId: string; displayNameOverride?: string; imagePath?: string }
  | { type: "renameFileCard"; rootDir: string; previousPath: string; nextPath: string }
  | { type: "setFileCardUnavailable"; rootDir: string; path: string; unavailable: boolean }
  | { type: "tidyCards"; visibleCardIds?: string[] };

// 追加カードは配置をサーバーが決めるため col/row を持たない。
export type SkiaBoardAddCardPayload =
  | { kind: "session"; sessionId: string; directory?: string; backendId?: string }
  | { kind: "file"; rootDir: string; path: string }
  | { kind: "directory"; directory: string };

function parseFileCardId(cardId: string): { rootDir: string; path: string } | null {
  if (!cardId.startsWith("file:")) return null;
  const separatorIndex = cardId.indexOf("\n");
  if (separatorIndex < 0) return null;
  return {
    rootDir: cardId.slice("file:".length, separatorIndex),
    path: cardId.slice(separatorIndex + 1),
  };
}

// opをローカルの純関数へ写像する。サーバー適用と同じ結果になることが前提
// (差異が出てもサーバー確定スナップショットの採用で収束する)。
export function applySkiaBoardOpLocally(state: SkiaBoardState, op: SkiaBoardOp): SkiaBoardState {
  switch (op.type) {
    case "moveCard":
      return moveSkiaBoardCard(state, op.cardId, op.col, op.row);
    case "addCard": {
      const card = op.card;
      if (card.kind === "session") {
        return addSkiaBoardSession(state, card.sessionId, {
          directory: card.directory,
          backendId: card.backendId,
        });
      }
      if (card.kind === "file") {
        return addSkiaBoardFile(state, { rootDir: card.rootDir, path: card.path });
      }
      return addSkiaBoardDirectory(state, { directory: card.directory });
    }
    case "removeCard": {
      if (op.cardId.startsWith("session:")) {
        return removeSkiaBoardSession(state, op.cardId.slice("session:".length));
      }
      if (op.cardId.startsWith("directory:")) {
        return removeSkiaBoardDirectory(state, op.cardId.slice("directory:".length));
      }
      const file = parseFileCardId(op.cardId);
      if (!file) return state;
      return removeSkiaBoardFile(state, file.rootDir, file.path);
    }
    case "upsertSection":
      return state.sections.some((section) => section.id === op.section.id)
        ? updateSkiaBoardSection(state, op.section.id, op.section)
        : addSkiaBoardSection(state, op.section);
    case "removeSection":
      return removeSkiaBoardSection(state, op.sectionId);
    case "updateCardAppearance":
      return updateSkiaBoardCardAppearance(state, op.cardId, {
        displayNameOverride: op.displayNameOverride,
        imagePath: op.imagePath,
      });
    case "renameFileCard":
      return renameSkiaBoardFile(state, op.rootDir, op.previousPath, op.nextPath);
    case "setFileCardUnavailable":
      return op.unavailable
        ? markSkiaBoardFileUnavailable(state, op.rootDir, op.path)
        : addSkiaBoardFile(state, { rootDir: op.rootDir, path: op.path });
    case "tidyCards":
      return tidySkiaBoardCards(state, op.visibleCardIds);
    default:
      return state;
  }
}

export function applySkiaBoardOpsLocally(
  state: SkiaBoardState,
  ops: readonly SkiaBoardOp[]
): SkiaBoardState {
  return ops.reduce((current, op) => applySkiaBoardOpLocally(current, op), state);
}

export function skiaBoardAddCardPayloadFromCard(card: SkiaBoardCard): SkiaBoardAddCardPayload {
  if (card.kind === "session") {
    return {
      kind: "session",
      sessionId: card.sessionId,
      ...(card.directory ? { directory: card.directory } : {}),
      ...(card.backendId ? { backendId: card.backendId } : {}),
    };
  }
  if (card.kind === "file") {
    return { kind: "file", rootDir: card.rootDir, path: card.path };
  }
  return { kind: "directory", directory: card.directory };
}
