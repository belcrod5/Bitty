import { collectGraphemes } from "unicode-segmenter/grapheme";

export type SttTranscriptDiffPart = { kind: "same" | "insert" | "delete"; text: string };
export type SttCorrectionPreview = { text: string; deadlineMs: number | null; parts: SttTranscriptDiffPart[] };

// Keep the quadratic comparison bounded for long transcripts. The fallback marks one
// coarse changed span after removing common grapheme prefixes and suffixes.
const MAX_COMPARE_GRAPHEMES = 256;

export function diffSttTranscript(original: string, corrected: string): SttTranscriptDiffPart[] {
  const before = collectGraphemes(original);
  const after = collectGraphemes(corrected);
  const parts: SttTranscriptDiffPart[] = [];
  const push = (kind: SttTranscriptDiffPart["kind"], text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };

  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  push("same", before.slice(0, start).join(""));

  const oldMiddle = before.slice(start, oldEnd);
  const newMiddle = after.slice(start, newEnd);
  if (oldMiddle.length > MAX_COMPARE_GRAPHEMES || newMiddle.length > MAX_COMPARE_GRAPHEMES) {
    push("delete", oldMiddle.join(""));
    push("insert", newMiddle.join(""));
  } else {
    const width = newMiddle.length + 1;
    const matches = new Uint16Array((oldMiddle.length + 1) * width);
    for (let i = oldMiddle.length - 1; i >= 0; i--) {
      for (let j = newMiddle.length - 1; j >= 0; j--) {
        const index = i * width + j;
        matches[index] = oldMiddle[i] === newMiddle[j]
          ? matches[index + width + 1] + 1
          : Math.max(matches[index + width], matches[index + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldMiddle.length || j < newMiddle.length) {
      if (i < oldMiddle.length && j < newMiddle.length && oldMiddle[i] === newMiddle[j]) {
        push("same", oldMiddle[i++]);
        j++;
      } else if (i < oldMiddle.length && (j === newMiddle.length
        || matches[(i + 1) * width + j] >= matches[i * width + j + 1])) {
        push("delete", oldMiddle[i++]);
      } else {
        push("insert", newMiddle[j++]);
      }
    }
  }
  push("same", before.slice(oldEnd).join(""));
  return parts;
}
