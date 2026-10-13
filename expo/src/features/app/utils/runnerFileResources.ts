export function normalizeRunnerPath(value: unknown) {
  return String(value || "").trim().replace(/\\/g, "/");
}

function normalizeRunnerDirectoryPath(value: unknown) {
  const normalized = normalizeRunnerPath(value);
  if (/^\/+$/u.test(normalized)) return "/";
  const driveRoot = /^([a-zA-Z]:)\/+$/u.exec(normalized);
  if (driveRoot) return `${driveRoot[1]}/`;
  return normalized.replace(/\/+$/, "") || ".";
}

function normalizeRunnerComparablePath(value: unknown) {
  const path = normalizeRunnerDirectoryPath(value);
  const driveMatch = /^([a-zA-Z]:)(\/.*)?$/.exec(path);
  const drive = driveMatch ? driveMatch[1] : "";
  const pathWithoutDrive = driveMatch ? (driveMatch[2] || "/") : path;
  const isAbsolute = pathWithoutDrive.startsWith("/");
  const parts: string[] = [];
  for (const part of pathWithoutDrive.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!isAbsolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const normalized = `${isAbsolute ? "/" : ""}${parts.join("/")}`.replace(/\/+$/, "");
  if (drive) return `${drive}${normalized || "/"}`;
  return normalized || (isAbsolute ? "/" : ".");
}

export function isAbsoluteRunnerPath(pathRaw: unknown) {
  const targetPath = normalizeRunnerPath(pathRaw);
  return targetPath.startsWith("/") || /^[a-zA-Z]:\//.test(targetPath);
}

export function isRunnerPathInsideDirectory(pathRaw: unknown, directoryRaw: unknown) {
  const targetPath = normalizeRunnerComparablePath(pathRaw);
  const directory = normalizeRunnerComparablePath(directoryRaw);
  if (!directory || directory === ".") return true;
  if (directory === "/") return targetPath.startsWith("/");
  if (/^[a-zA-Z]:\/$/u.test(directory)) {
    return targetPath.toLowerCase().startsWith(directory.toLowerCase());
  }
  return targetPath === directory || targetPath.startsWith(`${directory}/`);
}

export function getRunnerFileLocation(pathRaw: unknown, rootDirectoryRaw: unknown) {
  const path = normalizeRunnerPath(pathRaw);
  const rootDirectory = normalizeRunnerDirectoryPath(rootDirectoryRaw);
  if (!isAbsoluteRunnerPath(path) || isRunnerPathInsideDirectory(path, rootDirectory)) {
    return { path, rootDirectory };
  }
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex < 0 || separatorIndex === path.length - 1) {
    return { path, rootDirectory };
  }
  const parentPath = path.slice(0, separatorIndex);
  const locationRoot = separatorIndex === 0
    ? "/"
    : /^[a-zA-Z]:$/u.test(parentPath)
      ? `${parentPath}/`
      : parentPath;
  return {
    path,
    rootDirectory: locationRoot,
  };
}

export function buildRunnerMediaFileUrl(params: {
  runnerUrl: string;
  rootDir: string;
  path: string;
}) {
  const baseUrl = String(params.runnerUrl || "").trim().replace(/\/$/, "");
  const targetPath = normalizeRunnerPath(params.path);
  if (!baseUrl || !targetPath) return "";
  const { rootDirectory } = getRunnerFileLocation(targetPath, params.rootDir);
  try {
    const url = new URL(`${baseUrl}/files/media`);
    url.searchParams.set("path", targetPath);
    if (params.rootDir) {
      url.searchParams.set("rootDir", rootDirectory);
    }
    return url.toString();
  } catch {
    return "";
  }
}

export type RunnerImageSource = { uri: string; headers?: Record<string, string> };

export function getRunnerMediaSource(uri: string, runnerToken: string): RunnerImageSource | null {
  const token = runnerToken.trim();
  if (!uri || !token) return null;
  return { uri, headers: { authorization: `Bearer ${token}` } };
}

export function resolveRunnerMarkdownImage(
  destination: string,
  context: { runnerUrl: string; runnerToken: string; rootDir: string },
): RunnerImageSource | null {
  const url = destination.trim();
  if (!url || url.startsWith("#")) return null;
  if (/^www\./i.test(url)) return { uri: `https://${url}` };
  if (url.startsWith("//")) return { uri: `https:${url}` };
  const path = normalizeRunnerPath(url);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(path)?.[1].toLowerCase();
  if (scheme && scheme !== "file" && !/^[a-z]:\//i.test(path)) return { uri: url };
  let localPath = path.replace(/^file:\/\//i, "");
  try { localPath = decodeURIComponent(localPath); } catch {}
  const uri = buildRunnerMediaFileUrl({ ...context, path: localPath });
  return getRunnerMediaSource(uri, context.runnerToken);
}
