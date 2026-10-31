import * as Crypto from "expo-crypto";

// Local and Cloudflare are routes to the same configured Runner.
export function runnerConnectionIdentity(runnerUrl: string, runnerToken: string, localRunnerUrl = "", cloudflareRunnerUrl = "") {
  const normalize = (value: string) => {
    const text = value.trim().replace(/\/+$/, "");
    if (!/^wss?:/.test(text)) return text;
    let url: URL;
    try { url = new URL(text); } catch { return text; }
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    if (url.pathname === "/runner-ws") url.pathname = "";
    return url.toString().replace(/\/+$/, "");
  };
  const url = normalize(runnerUrl), local = normalize(localRunnerUrl), cloudflare = normalize(cloudflareRunnerUrl);
  return JSON.stringify([cloudflare && local && (url === local || url === cloudflare) ? cloudflare : url, runnerToken]);
}

export const runnerResponseCacheKey = (identity: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, identity).catch(() => null);
