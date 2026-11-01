import { readRunnerResponseCache, writeRunnerResponseCache } from "./runnerResponseCache";
import { runnerResponseCacheKey } from "../../runnerWs/runnerConnectionIdentity";
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
  restoredIdentity?: string;
  requestNumber?: number;
  entry?: { url: string; token: string; identity?: string; etag: string; snapshot: RunnerClientState };
};

function validSnapshot(value: unknown): value is RunnerClientState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as RunnerClientState;
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.titleModelId !== "string"
    || typeof state.titleReasoningEffort !== "string" || !Array.isArray(state.directories)
    || !state.directories.every((item) => item && typeof item.id === "string" && typeof item.path === "string"
      && typeof item.displayName === "string" && typeof item.markerColor === "string")
    || !Array.isArray(state.composerHistory) || !state.composerHistory.every((item) => typeof item === "string")) return false;
  return ["sessions", "drafts"].every((name) => {
    const collection = state[name as "sessions" | "drafts"];
    return collection && typeof collection === "object" && !Array.isArray(collection)
      && Object.entries(collection).every(([key, item]) => {
        try {
          const parts = JSON.parse(key);
          if (!Array.isArray(parts) || parts.length !== 2 || !parts.every((part) => typeof part === "string" && part.trim())
            || runnerSessionKey(parts[0], parts[1]) !== key || !item) return false;
          const entry = item as unknown as Record<string, unknown>;
          return name === "sessions"
            ? typeof entry.title === "string" && typeof entry.markerColor === "string"
              && (entry.note === undefined || typeof entry.note === "string")
            : typeof entry.text === "string" && Number.isFinite(entry.updatedAt);
        } catch { return false; }
      });
  });
}

export class RunnerClientStateConnectionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RunnerClientStateConnectionError";
  }
}

export async function requestRunnerClientState(options: {
  runnerUrl: string;
  runnerToken: string;
  connectionIdentity?: string;
  operation?: Record<string, unknown>;
  cache?: RunnerClientStateCache;
}): Promise<RunnerClientState> {
  const requestNumber = options.cache ? options.cache.requestNumber = (options.cache.requestNumber || 0) + 1 : 0;
  const url = `${options.runnerUrl.replace(/\/+$/, "")}/client-state`;
  const key = options.connectionIdentity ? runnerResponseCacheKey(options.connectionIdentity) : undefined;
  if (options.cache && key && options.cache.restoredIdentity !== options.connectionIdentity) {
    options.cache.restoredIdentity = options.connectionIdentity;
    const restored = await readRunnerResponseCache("client-state", await key);
    if (restored && validSnapshot(restored.body) && options.cache.restoredIdentity === options.connectionIdentity && options.cache.requestNumber === requestNumber) {
      options.cache.entry = { url, token: options.runnerToken, identity: options.connectionIdentity, etag: restored.etag, snapshot: restored.body };
    }
  }
  const entry = options.cache?.entry;
  const cached = entry && entry.token === options.runnerToken && (entry.url === url
    || options.connectionIdentity && entry.identity === options.connectionIdentity) ? entry : undefined;
  if (options.cache && options.operation) {
    options.cache.entry = undefined;
    if (key) void writeRunnerResponseCache("client-state", key, null);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const init: RequestInit = {
      method: options.operation ? "POST" : "GET",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${options.runnerToken}`,
        ...(options.operation ? { "content-type": "application/json" } : {}),
      },
      ...(options.operation ? { body: JSON.stringify({ operation: options.operation, ...(cached ? { baseEtag: cached.etag } : {}) }) } : {}),
      signal: controller.signal,
    };
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...init.headers, ...(!options.operation && cached ? { "if-none-match": cached.etag } : {}) },
      });
      if (!options.operation && response.status === 304) {
        const etag = response.headers?.get("etag");
        if (cached && (!etag || etag.replace(/^W\//, "") === cached.etag.replace(/^W\//, ""))) return cached.snapshot;
        response = await fetch(url, init);
      }
    } catch (error) {
      throw new RunnerClientStateConnectionError(error);
    }
    const payload = await response.json().catch((error) => {
      if (!(error instanceof SyntaxError)) throw new RunnerClientStateConnectionError(error);
      return {};
    });
    if (!response.ok) throw new Error(String(payload?.message || `Runner HTTP ${response.status}`));
    let snapshot = payload?.snapshot as RunnerClientState | undefined;
    if (payload && Object.hasOwn(payload, "patch")) {
      const patch = payload.patch;
      const changes = patch?.changes;
      const etag = response.headers?.get("etag");
      const changesObject = changes && typeof changes === "object" && !Array.isArray(changes);
      const merged = changesObject && cached ? { ...cached.snapshot, ...changes,
        sessions: changes.sessions ? { ...cached.snapshot.sessions, ...changes.sessions } : cached.snapshot.sessions } : null;
      const valid = options.operation && cached && etag && etag.replace(/^W\//, "") !== cached.etag.replace(/^W\//, "")
        && patch?.baseEtag === cached.etag && changesObject && changes.revision === cached.snapshot.revision + 1
        && Object.keys(changes).every((name) => ["revision", "titleModelId", "titleReasoningEffort", "directories", "sessions", "composerHistory", "drafts"].includes(name))
        && (!Object.hasOwn(changes, "sessions") || changes.sessions && typeof changes.sessions === "object" && !Array.isArray(changes.sessions))
        && validSnapshot(merged);
      if (!valid) {
        if (!options.operation) throw new Error("Runner returned a client-state patch without a valid mutation base");
        // Acknowledged writes are never replayed: composer.append is not
        // idempotent. Recover an unusable patch with one authoritative GET.
        return await requestRunnerClientState({ ...options, operation: undefined });
      }
      snapshot = merged;
    }
    if (!validSnapshot(snapshot)) throw new Error(String(payload?.message || `Runner HTTP ${response.status}`));
    if (options.cache && options.cache.requestNumber === requestNumber) {
      const etag = response.headers?.get("etag");
      options.cache.entry = etag ? { url, token: options.runnerToken, identity: options.connectionIdentity, etag, snapshot } : undefined;
      if (key) void writeRunnerResponseCache("client-state", key, etag ? { etag, body: snapshot } : null);
    }
    return snapshot;
  } finally {
    clearTimeout(timeout);
  }
}
