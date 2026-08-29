import type {
  DirectorySessionTreeState,
  RegisteredDirectoryEntry,
} from "../types/directorySessions";
import { formatLlmSessionDisplayTitle, parseOptionalSessionId } from "./llmSession";
import { clampContextUsedPct } from "./sessionRestore";
import { normalizeModelRef, parseLlmDirectory } from "./settingsParsers";

export type SessionHistoryContext = {
  backendId: string;
  sessionId: string;
  directory: string;
  directoryDisplayName: string;
  sessionTitle: string;
  updatedAt: string;
  modelRef: string;
  reasoningEffort: string;
  contextUsedPct: number | null;
};

type ResolveSessionHistoryContextArgs = {
  backendId?: unknown;
  sessionId: unknown;
  registeredDirectories: RegisteredDirectoryEntry[];
  directorySessionsById: Record<string, DirectorySessionTreeState>;
  sessionTitleOverridesById: Record<string, string>;
};

function deriveDirectoryDisplayName(pathRaw: unknown) {
  const path = parseLlmDirectory(pathRaw);
  const segments = path.split("/").filter(Boolean);
  return String(segments[segments.length - 1] || path).trim();
}

export function getCachedDirectorySessions(directoryState?: DirectorySessionTreeState) {
  return [
    ...(directoryState?.entries || []),
    ...Object.values(directoryState?.childrenByParentId || {}).flatMap((state) => state.entries),
  ];
}

// セッションのsubagentツリー(childrenByParentId)を持つ登録ディレクトリを解決する。
// キャッシュ済みセッションからの逆引きを優先しつつ、対象セッションが取得ウィンドウ外
// でもディレクトリパス一致で解決できるようフォールバックする。子ツリーの読み書きが
// 同じディレクトリに揃うよう、loader(useDirectorySessionTreeController)と表示側の
// 両方でこの解決を使うこと。
export function findDirectoryForSessionTree(
  registeredDirectories: RegisteredDirectoryEntry[],
  directorySessionsById: Record<string, DirectorySessionTreeState>,
  sessionIdsRaw: readonly string[],
  directoryPathRaw: unknown,
): RegisteredDirectoryEntry | null {
  const sessionIds = new Set(sessionIdsRaw.map((value) => String(value || "").trim()).filter(Boolean));
  const directoryPath = String(directoryPathRaw || "").trim();
  return (
    registeredDirectories.find((directory) => (
      getCachedDirectorySessions(directorySessionsById[directory.id])
        .some((session) => sessionIds.has(session.sessionId))
    ))
    || registeredDirectories.find((directory) => String(directory.path || "").trim() === directoryPath)
    || null
  );
}

export function resolveSessionHistoryContext({
  backendId: backendIdRaw,
  sessionId: sessionIdRaw,
  registeredDirectories,
  directorySessionsById,
  sessionTitleOverridesById,
}: ResolveSessionHistoryContextArgs): SessionHistoryContext | null {
  const sessionId = parseOptionalSessionId(sessionIdRaw);
  const backendId = String(backendIdRaw || "").trim();
  if (!sessionId) return null;
  for (const directory of registeredDirectories) {
    const directoryState = directorySessionsById[directory.id];
    const sessions = getCachedDirectorySessions(directoryState);
    const match = sessions.find(
      (entry) => parseOptionalSessionId(entry.sessionId) === sessionId && (
        !backendId || (String(entry.backendId || "codex").trim() || "codex") === backendId
      )
    );
    if (!match) continue;
    const directoryPath = parseLlmDirectory(match.directory || directory.path);
    const registeredDirectory = registeredDirectories.find(
      (item) => parseLlmDirectory(item.path) === directoryPath
    );
    const contextUsedPct = clampContextUsedPct(match.contextUsedPct);
    return {
      backendId: String(match.backendId || "codex").trim() || "codex",
      sessionId,
      directory: directoryPath,
      directoryDisplayName: String(
        registeredDirectory?.displayName ||
        deriveDirectoryDisplayName(directoryPath)
      ).trim(),
      sessionTitle: formatLlmSessionDisplayTitle(
        sessionTitleOverridesById[sessionId] ||
        match.firstUserMessage ||
        ""
      ),
      updatedAt: String(match.updatedAt || "").trim(),
      modelRef: normalizeModelRef(match.modelRef),
      reasoningEffort: String(match.reasoningEffort || "").trim(),
      contextUsedPct,
    };
  }
  return null;
}
