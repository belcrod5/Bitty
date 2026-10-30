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

export class RunnerClientStateConnectionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RunnerClientStateConnectionError";
  }
}

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
  const cached = entry?.url === url && entry.token === options.runnerToken ? entry : undefined;
  if (options.cache && options.operation) options.cache.entry = undefined;
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
      const fields = ["revision", "titleModelId", "titleReasoningEffort", "directories", "sessions", "composerHistory", "drafts"];
      const valid = options.operation && cached && etag && etag.replace(/^W\//, "") !== cached.etag.replace(/^W\//, "")
        && patch?.baseEtag === cached.etag && changes && typeof changes === "object" && !Array.isArray(changes)
        && changes.revision === cached.snapshot.revision + 1
        && Object.keys(changes).every((key) => fields.includes(key))
        && (!Object.hasOwn(changes, "directories") || Array.isArray(changes.directories)
          && changes.directories.every((value: RegisteredDirectoryEntry) => value && typeof value.id === "string"
            && typeof value.path === "string" && typeof value.displayName === "string" && typeof value.markerColor === "string"))
        && (!Object.hasOwn(changes, "composerHistory") || Array.isArray(changes.composerHistory)
          && changes.composerHistory.every((value: unknown) => typeof value === "string"))
        && ["sessions", "drafts"].every((key) => !Object.hasOwn(changes, key)
          || changes[key] && typeof changes[key] === "object" && !Array.isArray(changes[key])
            && Object.keys(changes[key]).every((sessionKey) => {
              try {
                const identity = JSON.parse(sessionKey);
                return Array.isArray(identity) && identity.length === 2
                  && identity.every((part) => typeof part === "string" && part.trim())
                  && runnerSessionKey(identity[0], identity[1]) === sessionKey;
              } catch { return false; }
            }))
        && (!changes.sessions || Object.values(changes.sessions as RunnerClientState["sessions"])
          .every((value) => value && typeof value.title === "string" && typeof value.markerColor === "string"
            && (value.note === undefined || typeof value.note === "string")))
        && (!changes.drafts || Object.values(changes.drafts as RunnerClientState["drafts"])
          .every((value) => value && typeof value.text === "string" && Number.isFinite(value.updatedAt)))
        && (!Object.hasOwn(changes, "titleModelId") || typeof changes.titleModelId === "string")
        && (!Object.hasOwn(changes, "titleReasoningEffort") || typeof changes.titleReasoningEffort === "string");
      if (!valid) {
        if (!options.operation) throw new Error("Runner returned a client-state patch without a valid mutation base");
        // Acknowledged writes are never replayed: composer.append is not
        // idempotent. Recover an unusable patch with one authoritative GET.
        return await requestRunnerClientState({ ...options, operation: undefined });
      }
      snapshot = { ...cached.snapshot, ...changes,
        sessions: changes.sessions ? { ...cached.snapshot.sessions, ...changes.sessions } : cached.snapshot.sessions };
    }
    if (!snapshot) throw new Error(String(payload?.message || `Runner HTTP ${response.status}`));
    if (options.cache) {
      const etag = response.headers?.get("etag");
      options.cache.entry = etag ? { url, token: options.runnerToken, etag, snapshot } : undefined;
    }
    return snapshot;
  } finally {
    clearTimeout(timeout);
  }
}
