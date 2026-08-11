export const SKIA_BOARD_CARD_HEIGHT = 112;
export const SKIA_BOARD_CARD_GAP = 18;
export const SKIA_BOARD_PADDING = 18;
export const SKIA_BOARD_MIN_CARD_WIDTH = 150;
export const SKIA_BOARD_MIN_SECTION_SIZE = 48;
const MIN_PERSISTED_SECTION_SIZE = 1;
export const SKIA_BOARD_MIN_SECTION_COL_SPAN = (
  (SKIA_BOARD_CARD_GAP + MIN_PERSISTED_SECTION_SIZE)
  / (SKIA_BOARD_MIN_CARD_WIDTH + SKIA_BOARD_CARD_GAP)
);
export const SKIA_BOARD_MIN_SECTION_ROW_SPAN = (
  (SKIA_BOARD_CARD_GAP + MIN_PERSISTED_SECTION_SIZE)
  / (SKIA_BOARD_CARD_HEIGHT + SKIA_BOARD_CARD_GAP)
);

export type SkiaBoardSectionRect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SkiaBoardSectionDragAction =
  | "move"
  | "resize-nw"
  | "resize-n"
  | "resize-ne"
  | "resize-e"
  | "resize-se"
  | "resize-s"
  | "resize-sw"
  | "resize-w";

// カードとセクションを同じグリッド座標へ保存し、画面幅に依存するcardWidthは
// 描画境界だけで適用する。span=1はカード1枚分の領域を表す。
export function cardPositionFromGrid(col: number, row: number, cardWidth: number) {
  return {
    x: SKIA_BOARD_PADDING + col * (cardWidth + SKIA_BOARD_CARD_GAP),
    y: SKIA_BOARD_PADDING + row * (SKIA_BOARD_CARD_HEIGHT + SKIA_BOARD_CARD_GAP),
  };
}

export function gridFromCardPosition(x: number, y: number, cardWidth: number) {
  return {
    col: (x - SKIA_BOARD_PADDING) / (cardWidth + SKIA_BOARD_CARD_GAP),
    row: (y - SKIA_BOARD_PADDING) / (SKIA_BOARD_CARD_HEIGHT + SKIA_BOARD_CARD_GAP),
  };
}

export function sectionRectFromGrid(
  section: { id: string; col: number; row: number; colSpan: number; rowSpan: number },
  cardWidth: number
): SkiaBoardSectionRect {
  const horizontalStep = cardWidth + SKIA_BOARD_CARD_GAP;
  const verticalStep = SKIA_BOARD_CARD_HEIGHT + SKIA_BOARD_CARD_GAP;
  return {
    id: section.id,
    x: SKIA_BOARD_PADDING + section.col * horizontalStep,
    y: SKIA_BOARD_PADDING + section.row * verticalStep,
    width: section.colSpan * horizontalStep - SKIA_BOARD_CARD_GAP,
    height: section.rowSpan * verticalStep - SKIA_BOARD_CARD_GAP,
  };
}

export function gridFromSectionRect(rect: SkiaBoardSectionRect, cardWidth: number) {
  const horizontalStep = cardWidth + SKIA_BOARD_CARD_GAP;
  const verticalStep = SKIA_BOARD_CARD_HEIGHT + SKIA_BOARD_CARD_GAP;
  return {
    col: (rect.x - SKIA_BOARD_PADDING) / horizontalStep,
    row: (rect.y - SKIA_BOARD_PADDING) / verticalStep,
    colSpan: (rect.width + SKIA_BOARD_CARD_GAP) / horizontalStep,
    rowSpan: (rect.height + SKIA_BOARD_CARD_GAP) / verticalStep,
  };
}

export function sectionRectFromPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number
) {
  "worklet";
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function pointIsInsideSection(
  section: SkiaBoardSectionRect,
  x: number,
  y: number
) {
  "worklet";
  return x >= section.x
    && x <= section.x + section.width
    && y >= section.y
    && y <= section.y + section.height;
}

export function sectionDragActionAtPoint(
  section: SkiaBoardSectionRect,
  x: number,
  y: number,
  scale: number
): SkiaBoardSectionDragAction | null {
  "worklet";
  const hitSize = 18 / Math.max(scale, 0.01);
  if (
    x < section.x - hitSize
    || x > section.x + section.width + hitSize
    || y < section.y - hitSize
    || y > section.y + section.height + hitSize
  ) return null;
  const west = Math.abs(x - section.x) <= hitSize;
  const east = Math.abs(x - section.x - section.width) <= hitSize;
  const north = Math.abs(y - section.y) <= hitSize;
  const south = Math.abs(y - section.y - section.height) <= hitSize;
  if (north && west) return "resize-nw";
  if (north && east) return "resize-ne";
  if (south && east) return "resize-se";
  if (south && west) return "resize-sw";
  if (north) return "resize-n";
  if (east) return "resize-e";
  if (south) return "resize-s";
  if (west) return "resize-w";
  return pointIsInsideSection(section, x, y) ? "move" : null;
}

export function transformSectionRect(
  section: SkiaBoardSectionRect,
  action: SkiaBoardSectionDragAction,
  deltaX: number,
  deltaY: number
): SkiaBoardSectionRect {
  "worklet";
  if (action === "move") {
    return { ...section, x: section.x + deltaX, y: section.y + deltaY };
  }
  const right = section.x + section.width;
  const bottom = section.y + section.height;
  const movesWest = action === "resize-w" || action === "resize-nw" || action === "resize-sw";
  const movesEast = action === "resize-e" || action === "resize-ne" || action === "resize-se";
  const movesNorth = action === "resize-n" || action === "resize-nw" || action === "resize-ne";
  const movesSouth = action === "resize-s" || action === "resize-sw" || action === "resize-se";
  const x = movesWest
    ? Math.min(section.x + deltaX, right - SKIA_BOARD_MIN_SECTION_SIZE)
    : section.x;
  const y = movesNorth
    ? Math.min(section.y + deltaY, bottom - SKIA_BOARD_MIN_SECTION_SIZE)
    : section.y;
  const nextRight = movesEast
    ? Math.max(section.x + SKIA_BOARD_MIN_SECTION_SIZE, right + deltaX)
    : right;
  const nextBottom = movesSouth
    ? Math.max(section.y + SKIA_BOARD_MIN_SECTION_SIZE, bottom + deltaY)
    : bottom;
  return {
    ...section,
    x,
    y,
    width: nextRight - x,
    height: nextBottom - y,
  };
}
