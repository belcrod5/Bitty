import {
  moveChecklistItem,
  parseChecklistFile,
  serializeChecklistFile,
} from "./checklistFile";

test("parses checked and unchecked Markdown items while tolerating blank lines", () => {
  expect(parseChecklistFile("- [x] 完了\n\n- [ ] 未完了\n- [X] 大文字\n")).toEqual([
    { checked: true, text: "完了" },
    { checked: false, text: "未完了" },
    { checked: true, text: "大文字" },
  ]);
});

test("rejects non-checklist Markdown so saving cannot discard it", () => {
  expect(() => parseChecklistFile("# 見出し\n- [ ] 項目\n"))
    .toThrow("1行目がチェックリスト形式ではありません。");
});

test("serializes items in the canonical checklist format", () => {
  expect(serializeChecklistFile([
    { checked: true, text: " 完了 " },
    { checked: false, text: "未完了" },
  ])).toBe("- [x] 完了\n- [ ] 未完了\n");
  expect(serializeChecklistFile([])).toBe("");
});

test("moves an item and bounds the destination to the list", () => {
  const items = [
    { checked: false, text: "A" },
    { checked: false, text: "B" },
    { checked: false, text: "C" },
  ];
  expect(moveChecklistItem(items, 0, 2).map((item) => item.text)).toEqual(["B", "C", "A"]);
  expect(moveChecklistItem(items, 2, -10).map((item) => item.text)).toEqual(["C", "A", "B"]);
  expect(moveChecklistItem(items, 1, 1)).toBe(items);
});
