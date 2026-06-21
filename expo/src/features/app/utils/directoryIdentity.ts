export type RegisteredDirectoryIdentity = {
  id: string;
  path: string;
  displayName: string;
  markerColor: "none" | "gray" | "red" | "yellow" | "green" | "black";
};

function deriveDirectoryDisplayName(pathRaw: string) {
  const path = String(pathRaw || "").trim();
  const segments = path.split("/").filter(Boolean);
  return String(segments[segments.length - 1] || path).trim();
}

function mergeDirectoryMetadata(
  retained: RegisteredDirectoryIdentity,
  retainedOriginalPath: string,
  duplicate: RegisteredDirectoryIdentity,
) {
  const retainedNameIsDefault = retained.displayName === deriveDirectoryDisplayName(retainedOriginalPath);
  const duplicateNameIsCustom = duplicate.displayName !== deriveDirectoryDisplayName(duplicate.path);
  const displayName = retainedNameIsDefault && duplicateNameIsCustom
    ? duplicate.displayName
    : retained.displayName;
  const markerColor = (
    (retained.markerColor === "none" || retained.markerColor === "gray") &&
    duplicate.markerColor !== "none" &&
    duplicate.markerColor !== "gray"
  ) ? duplicate.markerColor : retained.markerColor;
  if (displayName === retained.displayName && markerColor === retained.markerColor) return retained;
  return { ...retained, displayName, markerColor };
}

export function reconcileRegisteredDirectories(
  entries: RegisteredDirectoryIdentity[],
  canonicalPathByPath: ReadonlyMap<string, string>,
) {
  const directories: RegisteredDirectoryIdentity[] = [];
  const removedIds: string[] = [];
  const retainedIdByRemovedId = new Map<string, string>();
  const retainedIndexByPath = new Map<string, number>();
  const originalPathByRetainedIndex: string[] = [];

  for (const entry of entries) {
    const canonicalPath = canonicalPathByPath.get(entry.path) || entry.path;
    const retainedIndex = retainedIndexByPath.get(canonicalPath);
    if (retainedIndex !== undefined) {
      const retained = directories[retainedIndex];
      directories[retainedIndex] = mergeDirectoryMetadata(
        retained,
        originalPathByRetainedIndex[retainedIndex],
        entry,
      );
      removedIds.push(entry.id);
      retainedIdByRemovedId.set(entry.id, retained.id);
      continue;
    }
    retainedIndexByPath.set(canonicalPath, directories.length);
    originalPathByRetainedIndex.push(entry.path);
    directories.push(canonicalPath === entry.path ? entry : { ...entry, path: canonicalPath });
  }

  return { directories, removedIds, retainedIdByRemovedId };
}
