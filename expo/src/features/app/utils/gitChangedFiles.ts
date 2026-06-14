export function sanitizeGitChangedFilePath(pathRaw: unknown) {
  const normalized = String(pathRaw || "").trim().replace(/\\/g, "/");
  if (!normalized || normalized === "." || normalized === "./") return "";
  return normalized
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .filter((part) => part !== ".")
    .join("/");
}

export function normalizeGitChangedFilePaths(pathsRaw: unknown) {
  const paths = Array.isArray(pathsRaw) ? pathsRaw : [];
  return Array.from(new Set(
    paths
      .map((item) => sanitizeGitChangedFilePath(item))
      .filter(Boolean)
  ));
}

export function countGitChangedFiles(pathsRaw: unknown) {
  return normalizeGitChangedFilePaths(pathsRaw).length;
}
