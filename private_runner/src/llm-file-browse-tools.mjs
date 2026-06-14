import path from "node:path";
import { promises as fs } from "node:fs";

export function createLlmFileBrowseTools(deps) {
  const {
    classifyFsError,
    classifyPathResolutionError,
    clamp,
    escapeRegExp,
    globMatcherVersion,
    isProbablyBinary,
    makeToolError,
    maxEditFileBytes,
    maxFindResults,
    maxReadBytes,
    maxScanFiles,
    maxSearchResults,
    normalizeToolExecutionError,
    readDefaultBytes,
    resolvePathWithinToolRoot,
    toUnixPath,
  } = deps;

  function normalizeGlobPattern(rawGlob) {
    let input = toUnixPath(String(rawGlob || "").trim());
    if (!input) throw makeToolError("invalid_glob", "glob is required");
    input = input.replace(/^\.\//, "").replace(/\/+/g, "/");
    if (input.startsWith("/")) input = input.slice(1);
    if (!input) throw makeToolError("invalid_glob", "glob is required");
    return input;
  }

  function buildGlobMatcher(glob) {
    const input = normalizeGlobPattern(glob);
    let out = "^";
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (ch === "*") {
        const next = input[i + 1];
        const next2 = input[i + 2];
        if (next === "*") {
          if (next2 === "/") {
            out += "(?:.*/)?";
            i += 2;
            continue;
          }
          out += ".*";
          i += 1;
          continue;
        }
        out += "[^/]*";
        continue;
      }
      if (ch === "?") {
        out += "[^/]";
        continue;
      }
      out += escapeRegExp(ch);
    }
    out += "$";
    return {
      normalizedGlob: input,
      matcherVersion: globMatcherVersion,
      matcher: new RegExp(out),
      regexpSource: out,
    };
  }

  async function walkFilesUnderDir(baseDir, opts = {}) {
    const maxFiles = Math.max(1, Number(opts.maxFiles || maxScanFiles));
    const stack = [baseDir];
    let scannedFiles = 0;
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (typeof opts.skipDir === "function" && opts.skipDir(entry.name, fullPath)) continue;
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        scannedFiles += 1;
        if (scannedFiles > maxFiles) {
          return { scannedFiles, truncated: true };
        }
        if (typeof opts.onFile === "function") {
          const shouldStop = await opts.onFile(fullPath);
          if (shouldStop) {
            return { scannedFiles, truncated: false };
          }
        }
      }
    }
    return { scannedFiles, truncated: false };
  }

  async function runListDirTool(args, ctx) {
    const resolved = await resolvePathWithinToolRoot(ctx.rootReal, args.path, { defaultPath: "." });
    const stat = await fs.stat(resolved.realPath);
    if (!stat.isDirectory()) {
      throw new Error("path is not a directory");
    }
    const entries = await fs.readdir(resolved.realPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const items = [];
    for (const entry of entries) {
      const entryRel = resolved.relativePath === "."
        ? entry.name
        : `${resolved.relativePath}/${entry.name}`;
      const entryAbs = path.join(resolved.realPath, entry.name);
      let type = "unknown";
      if (entry.isDirectory()) type = "dir";
      else if (entry.isFile()) type = "file";
      else if (entry.isSymbolicLink()) type = "symlink";
      let size = null;
      if (entry.isFile()) {
        try {
          const entryStat = await fs.stat(entryAbs);
          size = entryStat.size;
        } catch {
          size = null;
        }
      }
      items.push({
        name: entry.name,
        path: toUnixPath(entryRel),
        type,
        size,
      });
    }
    return {
      path: resolved.relativePath,
      entries: items,
    };
  }

  async function runReadFileTool(args, ctx) {
    const requestedPath = args?.path;
    let resolved;
    try {
      resolved = await resolvePathWithinToolRoot(ctx.rootReal, requestedPath);
    } catch (err) {
      const code = classifyPathResolutionError(err);
      throw makeToolError(code, err instanceof Error ? err.message : String(err), {
        path: String(requestedPath || ""),
      });
    }
    let stat;
    try {
      stat = await fs.stat(resolved.realPath);
    } catch (err) {
      const code = classifyFsError(err, "read_stat_failed");
      throw makeToolError(code, err instanceof Error ? err.message : String(err), {
        path: resolved.relativePath,
      });
    }
    if (!stat.isFile()) {
      throw makeToolError("not_a_file", "path is not a file", {
        path: resolved.relativePath,
      });
    }
    const offset = clamp(args.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
    const limitRaw = args.limit === undefined || args.limit === null
      ? readDefaultBytes
      : Number(args.limit);
    if (!Number.isFinite(limitRaw) || limitRaw <= 0) {
      throw makeToolError("invalid_limit", "limit must be a positive number", {
        limit: args.limit,
        max: maxReadBytes,
      });
    }
    if (limitRaw > maxReadBytes) {
      throw makeToolError("invalid_limit", `limit must be <= ${maxReadBytes}`, {
        limit: limitRaw,
        max: maxReadBytes,
      });
    }
    const limit = Math.floor(limitRaw);
    const totalBytes = stat.size;
    const start = Math.min(offset, totalBytes);
    const toRead = Math.max(0, Math.min(limit, totalBytes - start));
    const buffer = Buffer.alloc(toRead);
    if (toRead > 0) {
      let handle = null;
      try {
        handle = await fs.open(resolved.realPath, "r");
        await handle.read(buffer, 0, toRead, start);
      } catch (err) {
        const code = classifyFsError(err, "read_failed");
        throw makeToolError(code, err instanceof Error ? err.message : String(err), {
          path: resolved.relativePath,
          offset: start,
          limit,
        });
      } finally {
        if (handle) {
          await handle.close().catch(() => {});
        }
      }
    }
    if (isProbablyBinary(buffer)) {
      return {
        path: resolved.relativePath,
        binary: true,
        resultCode: "binary_file",
        offset: start,
        limit,
        bytesRead: toRead,
        totalBytes,
        eof: start + toRead >= totalBytes,
      };
    }
    return {
      path: resolved.relativePath,
      binary: false,
      resultCode: "ok",
      offset: start,
      limit,
      bytesRead: toRead,
      totalBytes,
      eof: start + toRead >= totalBytes,
      nextOffset: start + toRead,
      content: buffer.toString("utf8"),
    };
  }

  async function runFindFilesTool(args, ctx) {
    const rawGlob = String(args.glob || "").trim();
    if (!rawGlob) {
      throw makeToolError("invalid_glob", "glob is required", { glob: rawGlob });
    }
    let globMatcher;
    try {
      globMatcher = buildGlobMatcher(rawGlob);
    } catch (err) {
      const normalized = normalizeToolExecutionError(err, "invalid_glob", "glob is required", { glob: rawGlob });
      throw makeToolError(normalized.code, normalized.message, normalized.details);
    }
    let baseResolved;
    try {
      baseResolved = await resolvePathWithinToolRoot(ctx.rootReal, args.path, { defaultPath: "." });
    } catch (err) {
      const code = classifyPathResolutionError(err);
      throw makeToolError(code, err instanceof Error ? err.message : String(err), {
        path: String(args.path || "."),
        glob: rawGlob,
      });
    }
    let baseStat;
    try {
      baseStat = await fs.stat(baseResolved.realPath);
    } catch (err) {
      const code = classifyFsError(err, "find_files_stat_failed");
      throw makeToolError(code, err instanceof Error ? err.message : String(err), {
        path: baseResolved.relativePath,
        glob: rawGlob,
      });
    }
    if (!baseStat.isDirectory()) {
      throw makeToolError("not_a_directory", "path is not a directory", {
        path: baseResolved.relativePath,
        glob: rawGlob,
      });
    }
    const files = [];
    const scannedSamplePaths = [];
    const matchedSamplePaths = [];
    const walk = await walkFilesUnderDir(baseResolved.realPath, {
      maxFiles: maxScanFiles,
      onFile: async (fullPath) => {
        const relFromBase = toUnixPath(path.relative(baseResolved.realPath, fullPath));
        if (scannedSamplePaths.length < 8) scannedSamplePaths.push(relFromBase);
        if (!globMatcher.matcher.test(relFromBase)) return false;
        const relFromRoot = toUnixPath(path.relative(ctx.rootReal, fullPath));
        files.push(relFromRoot);
        if (matchedSamplePaths.length < 8) matchedSamplePaths.push(relFromRoot);
        return files.length >= maxFindResults;
      },
    });
    return {
      path: baseResolved.relativePath,
      glob: rawGlob,
      normalizedGlob: globMatcher.normalizedGlob,
      matcherVersion: globMatcher.matcherVersion,
      matcherSource: globMatcher.regexpSource,
      files,
      matchedCount: files.length,
      scannedFiles: walk.scannedFiles,
      truncated: walk.truncated || files.length >= maxFindResults,
      diagnostics: {
        scannedSamplePaths,
        matchedSamplePaths,
      },
    };
  }

  async function runSearchTextTool(args, ctx) {
    const pattern = String(args.pattern || "");
    if (!pattern) {
      throw new Error("pattern is required");
    }
    const baseResolved = await resolvePathWithinToolRoot(ctx.rootReal, args.path, { defaultPath: "." });
    const baseStat = await fs.stat(baseResolved.realPath);
    if (!baseStat.isDirectory()) {
      throw new Error("path is not a directory");
    }
    const glob = String(args.glob || "").trim();
    let matcher = null;
    let normalizedGlob = "";
    let matcherVersion = "";
    if (glob) {
      let globMatcher;
      try {
        globMatcher = buildGlobMatcher(glob);
      } catch (err) {
        const normalized = normalizeToolExecutionError(err, "invalid_glob", "glob is required", { glob });
        throw makeToolError(normalized.code, normalized.message, normalized.details);
      }
      matcher = globMatcher.matcher;
      normalizedGlob = globMatcher.normalizedGlob;
      matcherVersion = globMatcher.matcherVersion;
    }
    const matches = [];

    const walk = await walkFilesUnderDir(baseResolved.realPath, {
      maxFiles: maxScanFiles,
      onFile: async (fullPath) => {
        if (matches.length >= maxSearchResults) return true;
        const relFromBase = toUnixPath(path.relative(baseResolved.realPath, fullPath));
        if (matcher && !matcher.test(relFromBase)) return false;
        let stat;
        try {
          stat = await fs.stat(fullPath);
        } catch {
          return false;
        }
        if (!stat.isFile()) return false;
        if (stat.size > maxEditFileBytes) return false;
        let raw;
        try {
          raw = await fs.readFile(fullPath);
        } catch {
          return false;
        }
        if (isProbablyBinary(raw)) return false;
        const text = raw.toString("utf8");
        const lines = text.split(/\r?\n/);
        const relFromRoot = toUnixPath(path.relative(ctx.rootReal, fullPath));
        for (let i = 0; i < lines.length; i += 1) {
          if (!lines[i].includes(pattern)) continue;
          matches.push({
            path: relFromRoot,
            lineNumber: i + 1,
            line: lines[i].slice(0, 400),
          });
          if (matches.length >= maxSearchResults) return true;
        }
        return false;
      },
    });
    return {
      path: baseResolved.relativePath,
      pattern,
      glob: glob || undefined,
      normalizedGlob: normalizedGlob || undefined,
      matcherVersion: matcherVersion || undefined,
      matches,
      scannedFiles: walk.scannedFiles,
      truncated: walk.truncated || matches.length >= maxSearchResults,
    };
  }

  return {
    runFindFilesTool,
    runListDirTool,
    runReadFileTool,
    runSearchTextTool,
  };
}
