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
  sessions: Record<string, { title: string; markerColor: RegisteredDirectoryEntry["markerColor"] }>;
  composerHistory: string[];
  drafts: Record<string, { text: string; updatedAt: number }>;
};

export async function requestRunnerClientState(options: {
  runnerUrl: string;
  runnerToken: string;
  operation?: Record<string, unknown>;
}): Promise<RunnerClientState> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${options.runnerUrl.replace(/\/+$/, "")}/client-state`, {
      method: options.operation ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${options.runnerToken}`,
        ...(options.operation ? { "content-type": "application/json" } : {}),
      },
      ...(options.operation ? { body: JSON.stringify({ operation: options.operation }) } : {}),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.snapshot) throw new Error(String(payload?.message || `Runner HTTP ${response.status}`));
    return payload.snapshot as RunnerClientState;
  } finally {
    clearTimeout(timeout);
  }
}
