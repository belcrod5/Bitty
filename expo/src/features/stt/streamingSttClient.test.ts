import { parseStreamingSttMessage, pcmRms, streamSttUrl } from "./streamingSttClient";

test("builds the dedicated streaming endpoint", () => {
  expect(streamSttUrl("https://runner.example.com/base?q=1")).toBe("wss://runner.example.com/stream-stt");
  expect(streamSttUrl("http://127.0.0.1:8788")).toBe("ws://127.0.0.1:8788/stream-stt");
});

test("accepts protocol messages and rejects malformed usage", () => {
  expect(parseStreamingSttMessage('{"type":"transcript","text":"abc","isFinal":false}'))
    .toEqual({ type: "transcript", text: "abc", isFinal: false });
  expect(parseStreamingSttMessage('{"type":"usage","usedSeconds":12,"limitSeconds":3600,"remainingSeconds":3588,"monthUtc":"2026-09","resetAt":"2026-10-01T00:00:00.000Z"}'))
    .toEqual({
      type: "usage",
      usedSeconds: 12,
      limitSeconds: 3600,
      remainingSeconds: 3588,
      monthUtc: "2026-09",
      resetAt: "2026-10-01T00:00:00.000Z",
    });
  expect(parseStreamingSttMessage('{"type":"usage","usedSeconds":"oops"}')).toBeNull();
  expect(parseStreamingSttMessage("not json")).toBeNull();
  expect(parseStreamingSttMessage('{"type":"done","reason":"speech_end_timeout","hasSpeech":true}'))
    .toEqual({ type: "done", reason: "speech_end_timeout", hasSpeech: true });
  expect(parseStreamingSttMessage('{"type":"done","reason":"recognition_segment_end","hasSpeech":true}'))
    .toEqual({ type: "done", reason: "recognition_segment_end", hasSpeech: true });
  expect(parseStreamingSttMessage('{"type":"done","reason":"speech_end_timeout","hasSpeech":true,"usage":null}'))
    .toBeNull();
});

test("computes normalized RMS from the PCM sent to the runner", () => {
  const pcm = new Uint8Array([0, 0, 0xff, 0x7f, 0x00, 0x80]);
  expect(pcmRms(pcm)).toBeGreaterThan(0.8);
  expect(pcmRms(new Uint8Array())).toBe(0);
});

test("continuation protocol validates revision and acknowledgment fields", () => {
  expect(streamSttUrl("https://runner.test/base?old=1", true)).toBe("wss://runner.test/stream-stt?continuation=1");
  for (const type of ["candidate", "candidate_invalidated", "committed"]) {
    const message = { type, revision: 1, ...(type === "committed" ? { accepted: false } : {}) };
    expect(parseStreamingSttMessage(JSON.stringify(message))).toEqual(message);
    for (const revision of [0, -1, 1.5, "1", null]) {
      expect(parseStreamingSttMessage(JSON.stringify({ ...message, revision }))).toBeNull();
    }
    expect(parseStreamingSttMessage(JSON.stringify({ ...message, extra: true }))).toBeNull();
  }
  expect(parseStreamingSttMessage('{"type":"committed","revision":1,"accepted":"true"}')).toBeNull();
  expect(parseStreamingSttMessage('{"type":"segment_start"}')).toEqual({ type: "segment_start" });
});
