import type { RegisteredDirectoryEntry } from "../types/directorySessions";
import type { ReasoningEffort } from "./settingsParsers";

export const runnerSessionKey = (backendId: unknown, sessionId: unknown) => JSON.stringify([
  String(backendId || "codex").trim() || "codex",
  String(sessionId || "").trim(),
]);

export function runnerSessionValue<T>(values: Record<string, T>, backendId: unknown, sessionId: unknown): T | undefined {
  return values[runnerSessionKey(backendId, sessionId)];
}

export type RunnerClientState = {
  revision: number;
  titleModelId: string;
  titleReasoningEffort: ReasoningEffort;
  directories: RegisteredDirectoryEntry[];
  sessions: Record<string, { title: string; markerColor: RegisteredDirectoryEntry["markerColor"]; note?: string }>;
  composerHistory: string[];
  drafts: Record<string, { text: string; updatedAt: number }>;
};

export type RunnerClientStateCache = {
  entry?: { url: string; token: string; etag: string; snapshot: RunnerClientState };
};

export async function requestRunnerClientState(options: {
  runnerUrl: string;
  runnerToken: string;
  operation?: Record<string, unknown>;
  cache?: RunnerClientStateCache;
}): Promise<RunnerClientState> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  const url = `${options.runnerUrl.replace(/\/+$/, "")}/client-state`;
  const entry = options.cache?.entry;
  const cached = !options.operation && entry?.url === url && entry.token === options.runnerToken ? entry : undefined;
  if (options.cache && options.operation) options.cache.entry = undefined;
  try {
    const init: RequestInit = {
      method: options.operation ? "POST" : "GET",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${options.runnerToken}`,
        ...(options.operation ? { "content-type": "application/json" } : {}),
      },
      ...(options.operation ? { body: JSON.stringify({ operation: options.operation }) } : {}),
      signal: controller.signal,
    };
    let response = await fetch(url, {
      ...init,
      headers: { ...init.headers, ...(cached ? { "if-none-match": cached.etag } : {}) },
    });
    if (!options.operation && response.status === 304) {
      const etag = response.headers?.get("etag");
      if (cached && (!etag || etag.replace(/^W\//, "") === cached.etag.replace(/^W\//, ""))) return cached.snapshot;
      response = await fetch(url, init);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.snapshot) throw new Error(String(payload?.message || `Runner HTTP ${response.status}`));
    const snapshot = payload.snapshot as RunnerClientState;
    if (options.cache) {
      const etag = response.headers?.get("etag");
      options.cache.entry = etag ? { url, token: options.runnerToken, etag, snapshot } : undefined;
    }
    return snapshot;
  } finally {
    clearTimeout(timeout);
  }
}
