// 診断ログ用のtoken指紋(FNV-1a 32bit)。秘密値はログへ出さず、この一方向指紋と
// 長さだけを記録する。expo側 src/features/ws/tokenFingerprint.ts と同一アルゴリズムで、
// アプリのrunner_ws診断ログとrunnerのupgradeログを直接突合できる。
export function tokenFingerprint(raw) {
  const token = String(raw || "").trim();
  if (!token) return "-";
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
