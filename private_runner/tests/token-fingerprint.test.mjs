import assert from "node:assert/strict";
import test from "node:test";
import { tokenFingerprint } from "../src/token-fingerprint.mjs";

// 期待値はexpo/src/features/ws/tokenFingerprint.test.tsと共有のベクター。
// 両実装(FNV-1a 32bit)が一致しないとアプリ/runnerのログ突合が壊れるため、
// どちらか一方だけ変更してはならない。
test("matches the shared FNV-1a vectors used by the app", () => {
  assert.equal(tokenFingerprint("runner-token"), "07b20b97");
  assert.equal(tokenFingerprint("abc"), "1a47e90b");
  assert.equal(tokenFingerprint("expected-token"), "d9c94259");
});

test("trims the token and returns a placeholder for an empty token", () => {
  assert.equal(tokenFingerprint(" runner-token "), "07b20b97");
  assert.equal(tokenFingerprint(""), "-");
  assert.equal(tokenFingerprint(undefined), "-");
});
