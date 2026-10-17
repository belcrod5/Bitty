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

test.each(["", " \t"])("empty recognition results preserve the current segment (%j)", (empty) => {
  let state = applyStreamingTranscript(startStreamingTranscript("typed"), "途中", false);
  const partial = state;
  state = applyStreamingTranscript(state, empty, false);
  expect(state).toBe(partial);
  state = applyStreamingTranscript(state, empty, true);
  expect(displayStreamingTranscript(state)).toBe("typed 途中");
  expect(finalStreamingTranscript(state)).toBe("typed");
  expect(applyStreamingTranscript(state, empty, true)).toBe(state);
});

test("a nonempty final replaces the preserved partial with the provider correction", () => {
  let state = applyStreamingTranscript(startStreamingTranscript(""), "途中", false);
  state = applyStreamingTranscript(state, "", false);
  state = applyStreamingTranscript(state, "", true);
  state = applyStreamingTranscript(state, "訂正文", true);
  expect(finalStreamingTranscript(state)).toBe("訂正文");
});
