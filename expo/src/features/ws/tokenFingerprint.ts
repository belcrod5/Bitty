// 診断ログ用のtoken指紋。秘密値そのものは絶対にログへ出さず、この一方向指紋と
// 長さだけで「どの世代のtokenがどこまで届いたか」を突合する。
// アルゴリズムはrunner側 private_runner/src/token-fingerprint.mjs (FNV-1a 32bit)と
// 同一で、runner起動ログの RUNNER_TOKEN_ID やupgradeログとそのまま比較できる。
export function tokenFingerprint(raw: unknown): string {
  const token = String(raw || "").trim();
  if (!token) return "-";
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function tokenLength(raw: unknown): number {
  return String(raw || "").trim().length;
}
