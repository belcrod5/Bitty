import {
  categorizeHttpUrl,
  getNetworkUsageSnapshot,
  recordHttpNetworkUsage,
  recordNetworkUsage,
  resetNetworkUsage,
  utf8ByteLength,
} from "./networkUsageMetrics";

describe("utf8ByteLength", () => {
  it("counts ascii as 1 byte per char", () => {
    expect(utf8ByteLength("abc123")).toBe(6);
  });

  it("counts japanese as 3 bytes per char", () => {
    expect(utf8ByteLength("こんにちは")).toBe(15);
  });

  it("counts surrogate pairs as 4 bytes", () => {
    expect(utf8ByteLength("😀")).toBe(4);
  });

  it("counts 2-byte range chars", () => {
    expect(utf8ByteLength("é")).toBe(2);
  });

  it("returns 0 for empty string", () => {
    expect(utf8ByteLength("")).toBe(0);
  });
});

describe("categorizeHttpUrl", () => {
  it("categorizes known runner endpoints", () => {
    expect(categorizeHttpUrl("https://runner.example/session-messages?sessionId=a")).toBe("session-messages");
    expect(categorizeHttpUrl("https://runner.example/session-summaries")).toBe("session-summaries");
    expect(categorizeHttpUrl("https://runner.example/tts-media/abc.wav")).toBe("tts-media");
    expect(categorizeHttpUrl("https://runner.example/client-logs")).toBe("other");
    expect(categorizeHttpUrl("")).toBe("other");
  });
});

describe("network usage accumulation", () => {
  beforeEach(() => {
    resetNetworkUsage();
  });

  it("accumulates per-route and per-category counters into totals", () => {
    recordNetworkUsage("runner-ws", 100, 200);
    recordNetworkUsage("runner-ws", 1, 2);
    recordNetworkUsage("stream-tts", 10, 20);
    recordHttpNetworkUsage("https://runner.example/session-messages?x=1", 5, 5000);
    recordHttpNetworkUsage("https://runner.example/tts-media/abc.wav", 0, 300);
    recordHttpNetworkUsage("https://example.com/anything", 7, 70);

    const snapshot = getNetworkUsageSnapshot();
    expect(snapshot.runnerWs).toEqual({ sentBytes: 101, receivedBytes: 202 });
    expect(snapshot.streamTts).toEqual({ sentBytes: 10, receivedBytes: 20 });
    expect(snapshot.httpByCategory["session-messages"]).toEqual({ sentBytes: 5, receivedBytes: 5000 });
    expect(snapshot.httpByCategory["tts-media"]).toEqual({ sentBytes: 0, receivedBytes: 300 });
    expect(snapshot.httpByCategory.other).toEqual({ sentBytes: 7, receivedBytes: 70 });
    expect(snapshot.http).toEqual({ sentBytes: 12, receivedBytes: 5370 });
    expect(snapshot.totalSentBytes).toBe(123);
    expect(snapshot.totalReceivedBytes).toBe(5592);
  });

  it("ignores negative and non-finite values", () => {
    recordNetworkUsage("runner-ws", -10, Number.NaN);
    recordHttpNetworkUsage("https://example.com/", Number.POSITIVE_INFINITY, -1);
    const snapshot = getNetworkUsageSnapshot();
    expect(snapshot.totalSentBytes).toBe(0);
    expect(snapshot.totalReceivedBytes).toBe(0);
  });

  it("reset clears counters and refreshes the start time", () => {
    recordNetworkUsage("stream-tts", 1, 1);
    const before = getNetworkUsageSnapshot();
    resetNetworkUsage();
    const after = getNetworkUsageSnapshot();
    expect(after.totalSentBytes).toBe(0);
    expect(after.totalReceivedBytes).toBe(0);
    expect(after.sinceMs).toBeGreaterThanOrEqual(before.sinceMs);
  });

  it("snapshot is a copy detached from later records", () => {
    recordNetworkUsage("runner-ws", 1, 1);
    const snapshot = getNetworkUsageSnapshot();
    recordNetworkUsage("runner-ws", 1, 1);
    expect(snapshot.runnerWs).toEqual({ sentBytes: 1, receivedBytes: 1 });
  });
});
