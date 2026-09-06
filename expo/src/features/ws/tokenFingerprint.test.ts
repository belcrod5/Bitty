import { tokenFingerprint, tokenLength } from "./tokenFingerprint";

// 期待値はprivate_runner/tests/token-fingerprint.test.mjsと共有のベクター。
// 両実装(FNV-1a 32bit)が一致しないとアプリ/runnerのログ突合が壊れるため、
// どちらか一方だけ変更してはならない。
test("matches the shared FNV-1a vectors used by the runner", () => {
  expect(tokenFingerprint("runner-token")).toBe("07b20b97");
  expect(tokenFingerprint("abc")).toBe("1a47e90b");
  expect(tokenFingerprint("expected-token")).toBe("d9c94259");
});

test("trims the token before fingerprinting", () => {
  expect(tokenFingerprint(" runner-token ")).toBe("07b20b97");
  expect(tokenLength(" runner-token ")).toBe("runner-token".length);
});

test("returns a placeholder for an empty token", () => {
  expect(tokenFingerprint("")).toBe("-");
  expect(tokenFingerprint("   ")).toBe("-");
  expect(tokenFingerprint(undefined)).toBe("-");
  expect(tokenLength("")).toBe(0);
});
