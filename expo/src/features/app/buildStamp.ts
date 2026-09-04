// EXPO_PUBLIC_* は babel-preset-expo が本番バンドル時に文字列リテラルへ
// インライン化する。`process.env.EXPO_PUBLIC_～` のメンバー式そのままの形が
// 変換対象なので、env を変数へ分解しないこと。
declare const process: { env: Record<string, string | undefined> };

export const BUILD_STAMP = (process.env.EXPO_PUBLIC_BUILD_STAMP || "").trim() || "dev";
