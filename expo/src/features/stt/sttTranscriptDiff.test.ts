import { diffSttTranscript } from "./sttTranscriptDiff";

test("marks separated Japanese corrections while preserving the exact corrected transcript", () => {
  const parts = diffSttTranscript("今日わ東京で会いまふ", "今日は東京で会います");
  expect(parts).toEqual([
    { kind: "same", text: "今日" },
    { kind: "delete", text: "わ" }, { kind: "insert", text: "は" },
    { kind: "same", text: "東京で会いま" },
    { kind: "delete", text: "ふ" }, { kind: "insert", text: "す" },
  ]);
  expect(parts.filter((part) => part.kind !== "delete").map((part) => part.text).join(""))
    .toBe("今日は東京で会います");
});

test("locates insertions and deletion-only edits", () => {
  expect(diffSttTranscript("明日行く", "明日は行く")).toEqual([
    { kind: "same", text: "明日" }, { kind: "insert", text: "は" }, { kind: "same", text: "行く" },
  ]);
  expect(diffSttTranscript("明日は行く", "明日行く")).toEqual([
    { kind: "same", text: "明日" }, { kind: "delete", text: "は" }, { kind: "same", text: "行く" },
  ]);
});

test("does not split emoji graphemes and bounds long comparisons", () => {
  expect(diffSttTranscript("家族👨‍👩‍👧で", "家族👩‍👧で")).toEqual([
    { kind: "same", text: "家族" },
    { kind: "delete", text: "👨‍👩‍👧" }, { kind: "insert", text: "👩‍👧" },
    { kind: "same", text: "で" },
  ]);
  const parts = diffSttTranscript(`前${"あ".repeat(300)}後`, `前${"い".repeat(300)}後`);
  expect(parts).toEqual([
    { kind: "same", text: "前" }, { kind: "delete", text: "あ".repeat(300) },
    { kind: "insert", text: "い".repeat(300) }, { kind: "same", text: "後" },
  ]);
});
