export const RUNNER_SESSION_PREFIX = "bitty_session_v1.";

export function isRunnerSessionToken(value: unknown): value is string {
  return typeof value === "string" && /^bitty_session_v1\.[A-Za-z0-9_-]{43,128}$/.test(value);
}

export type RunnerSession = {
  sessionId: string;
  expiresAt: string;
  ownerEmail: string;
  reauthenticatedUntil?: string;
};

export type RunnerLoginResult = RunnerSession & { token: string };
export type RunnerChallenge = { challengeId: string; expiresAt: string };
export type RunnerDevice = {
  id: string;
  name: string;
  os: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
  notificationStatus?: string;
};

export class RunnerLoginError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

// All callers use fixed /auth paths and the selected Runner origin. In particular,
// redirects must never carry the Bitty session or code body to an Access login page.
export async function requestRunnerLogin<T>(
  baseUrl: string,
  path: string,
  { token = "", body, method = body === undefined ? "GET" : "POST" }:
    { token?: string; body?: unknown; method?: string } = {},
): Promise<T> {
  const origin = new URL(baseUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) ||
    origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
    !path.startsWith("/auth/") || path.startsWith("//")) {
    throw new RunnerLoginError("invalid_runner_origin", 0);
  }
  const url = new URL(path, origin);
  if (url.origin !== origin.origin) throw new RunnerLoginError("invalid_runner_origin", 0);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url.toString(), {
      method, redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new RunnerLoginError(String(json?.error || "runner_unavailable"), response.status);
    if (!json || typeof json !== "object") throw new RunnerLoginError("invalid_authentication_response", 0);
    return json as T;
  } finally { clearTimeout(timeout); }
}

export function runnerLoginErrorMessage(error: unknown) {
  if (!(error instanceof RunnerLoginError)) return "通信できませんでした。接続設定を確認して再度お試しください。";
  switch (error.code) {
    case "authentication_required": return "ログインの期限が切れたか、端末が失効しました。再ログインしてください。";
    case "reauthentication_required": return "他の端末を失効するには、メールとAuthenticatorで再確認してください。";
    case "invalid_authentication": return "コードが違うか、期限が切れています。確認して再度お試しください。";
    case "authentication_rate_limited": return "試行回数の上限に達しました。しばらく待ってからお試しください。";
    case "authentication_unavailable": return "Mac側の本人認証設定が必要です。所有者登録とメール送信設定を確認してください。";
    case "invalid_runner_origin": return "初回はMacの接続設定QRを読み込んでください。";
    default: return "ログイン処理に失敗しました。接続設定を確認して再度お試しください。";
  }
}
