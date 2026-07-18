import type {
  DirectorySessionTreeState,
  RegisteredDirectoryEntry,
} from "../components/AppDrawer";
import { parseOptionalSessionId } from "./llmSession";
import { clampContextUsedPct } from "./sessionRestore";
import { normalizeModelRef, parseLlmDirectory } from "./settingsParsers";

export type SessionHistoryContext = {
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

export function resolveSessionHistoryContext({
  sessionId: sessionIdRaw,
  registeredDirectories,
  directorySessionsById,
  sessionTitleOverridesById,
}: ResolveSessionHistoryContextArgs): SessionHistoryContext | null {
  const sessionId = parseOptionalSessionId(sessionIdRaw);
  if (!sessionId) return null;
  for (const directory of registeredDirectories) {
    const directoryState = directorySessionsById[directory.id];
    const sessions = getCachedDirectorySessions(directoryState);
    const match = sessions.find(
      (entry) => parseOptionalSessionId(entry.sessionId) === sessionId
    );
    if (!match) continue;
    const directoryPath = parseLlmDirectory(match.directory || directory.path);
    const registeredDirectory = registeredDirectories.find(
      (item) => parseLlmDirectory(item.path) === directoryPath
    );
    const contextUsedPct = clampContextUsedPct(match.contextUsedPct);
    return {
      sessionId,
      directory: directoryPath,
      directoryDisplayName: String(
        registeredDirectory?.displayName ||
        deriveDirectoryDisplayName(directoryPath)
      ).trim(),
      sessionTitle: String(
        sessionTitleOverridesById[sessionId] ||
        match.firstUserMessage ||
        ""
      ).replace(/\s+/g, " ").trim(),
      updatedAt: String(match.updatedAt || "").trim(),
      modelRef: normalizeModelRef(match.modelRef),
      reasoningEffort: String(match.reasoningEffort || "").trim(),
      contextUsedPct,
    };
  }
  return null;
}
