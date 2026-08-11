import {
  cardPositionFromGrid,
  gridFromSectionRect,
  pointIsInsideSection,
  sectionDragActionAtPoint,
  sectionRectFromGrid,
  sectionRectFromPoints,
  SKIA_BOARD_CARD_GAP,
  SKIA_BOARD_MIN_SECTION_COL_SPAN,
  SKIA_BOARD_MIN_SECTION_ROW_SPAN,
  transformSectionRect,
} from "./skiaBoardSectionGeometry";

const section = { id: "section:1", x: 100, y: 80, width: 240, height: 160 };

describe("Skia board section geometry", () => {
  it("keeps section geometry aligned with card grid positions when card width changes", () => {
    const wideRect = { id: "section:1", x: 306, y: 148, width: 558, height: 242 };
    const grid = gridFromSectionRect(wideRect, 270);
    const narrowRect = sectionRectFromGrid({ id: wideRect.id, ...grid }, 150);

    expect(wideRect.x).toBe(cardPositionFromGrid(grid.col, grid.row, 270).x);
    expect(narrowRect.x).toBe(cardPositionFromGrid(grid.col, grid.row, 150).x);
    expect(gridFromSectionRect(narrowRect, 150)).toEqual(grid);
    expect(narrowRect.width).toBe(
      grid.colSpan * (150 + SKIA_BOARD_CARD_GAP) - SKIA_BOARD_CARD_GAP
    );
  });

  it("keeps the smallest persisted spans positive at the rendering boundary", () => {
    const smallest = sectionRectFromGrid({
      id: "section:smallest",
      col: 0,
      row: 0,
      colSpan: SKIA_BOARD_MIN_SECTION_COL_SPAN,
      rowSpan: SKIA_BOARD_MIN_SECTION_ROW_SPAN,
    }, 150);

    expect(smallest.width).toBeCloseTo(1);
    expect(smallest.height).toBeCloseTo(1);
    expect(gridFromSectionRect(smallest, 150)).toMatchObject({
      colSpan: SKIA_BOARD_MIN_SECTION_COL_SPAN,
      rowSpan: SKIA_BOARD_MIN_SECTION_ROW_SPAN,
    });
  });

  it("normalizes a drawn rectangle in every direction", () => {
    expect(sectionRectFromPoints(300, 220, 100, 80)).toEqual({
      x: 100,
      y: 80,
      width: 200,
      height: 140,
    });
  });

  it("detects the interior and screen-sized resize edges", () => {
    expect(pointIsInsideSection(section, 200, 140)).toBe(true);
    expect(pointIsInsideSection(section, 99, 140)).toBe(false);
    expect(sectionDragActionAtPoint(section, 200, 140, 1)).toBe("move");
    expect(sectionDragActionAtPoint(section, 101, 81, 1)).toBe("resize-nw");
    expect(sectionDragActionAtPoint(section, 340, 160, 1)).toBe("resize-e");
    // 2倍ズームではボード座標上の判定幅を半分にして、画面上の幅を維持する。
    expect(sectionDragActionAtPoint(section, 110, 160, 2)).toBe("move");
  });

  it("moves and resizes without crossing the minimum size", () => {
    expect(transformSectionRect(section, "move", -20, 30)).toEqual({
      ...section,
      x: 80,
      y: 110,
    });
    expect(transformSectionRect(section, "resize-se", 60, 40)).toEqual({
      ...section,
      width: 300,
      height: 200,
    });
    expect(transformSectionRect(section, "resize-nw", 500, 500)).toEqual({
      ...section,
      x: 292,
      y: 192,
      width: 48,
      height: 48,
    });
  });
});
