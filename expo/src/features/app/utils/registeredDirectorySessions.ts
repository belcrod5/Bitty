type RegisteredDirectoryInput = {
  id: string;
  path: unknown;
  displayName?: unknown;
};

type SessionInput = {
  sessionId: unknown;
  updatedAt: unknown;
  cwd?: unknown;
};

type RegisteredDirectorySession<T extends SessionInput> = T & {
  directory: string;
  cwd: string;
  directoryDisplayName: string;
};

function sessionUpdatedAtMs(value: unknown) {
  const time = new Date(String(value || "")).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function collectRegisteredDirectorySessions<T extends SessionInput>(
  registeredDirectories: readonly RegisteredDirectoryInput[],
  directorySessionsById: Readonly<Record<string, { entries?: readonly T[] } | undefined>>
): RegisteredDirectorySession<T>[] {
  const sessionsById = new Map<string, RegisteredDirectorySession<T>>();

  for (const registeredDirectory of registeredDirectories) {
    const directory = String(registeredDirectory.path || "").trim();
    if (!directory) continue;
    const directoryDisplayName = String(registeredDirectory.displayName || "").trim() || directory;

    for (const session of directorySessionsById[registeredDirectory.id]?.entries || []) {
      const sessionId = String(session.sessionId || "").trim();
      if (!sessionId) continue;
      const candidate = {
        ...session,
        directory,
        cwd: String(session.cwd || directory).trim(),
        directoryDisplayName,
      };
      const existing = sessionsById.get(sessionId);
      if (existing && sessionUpdatedAtMs(existing.updatedAt) >= sessionUpdatedAtMs(candidate.updatedAt)) continue;
      sessionsById.set(sessionId, candidate);
    }
  }

  return [...sessionsById.values()].sort(
    (a, b) => sessionUpdatedAtMs(b.updatedAt) - sessionUpdatedAtMs(a.updatedAt)
  );
}
