import {
  applyStreamingTranscript,
  displayStreamingTranscript,
  finalStreamingTranscript,
  startStreamingTranscript,
} from "./streamingTranscript";

test("replaces interim text instead of appending it", () => {
  let state = startStreamingTranscript("");
  state = applyStreamingTranscript(state, "A", false);
  state = applyStreamingTranscript(state, "AB", false);
  expect(displayStreamingTranscript(state)).toBe("AB");
});

test("moves final text once and preserves ordered final results", () => {
  let state = startStreamingTranscript("typed");
  state = applyStreamingTranscript(state, "途中", false);
  state = applyStreamingTranscript(state, "確定1", true);
  state = applyStreamingTranscript(state, "確定2", true);
  state = applyStreamingTranscript(state, "仮", false);

  expect(displayStreamingTranscript(state)).toBe("typed 確定1確定2仮");
  expect(finalStreamingTranscript(state)).toBe("typed 確定1確定2");
});

test("does not commit interim text when a session fails", () => {
  const state = applyStreamingTranscript(startStreamingTranscript("draft"), "unconfirmed", false);
  expect(finalStreamingTranscript(state)).toBe("draft");
});
