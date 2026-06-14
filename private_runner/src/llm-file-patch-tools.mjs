import path from "node:path";
import { promises as fs } from "node:fs";

export function createLlmFilePatchTools(deps) {
  const {
    classifyFsError,
    classifyPathResolutionError,
    isProbablyBinary,
    makeToolError,
    maxReadLines,
    resolvePathWithinToolRoot,
    toUnixPath,
  } = deps;

  function normalizeTextLineEndings(raw) {
    return String(raw || "").replace(/\r\n/g, "\n");
  }

  function parseTextDocument(raw) {
    const normalized = normalizeTextLineEndings(raw);
    if (normalized === "") {
      return {
        lines: [],
        hasTrailingNewline: false,
      };
    }
    const hasTrailingNewline = normalized.endsWith("\n");
    const lines = normalized.split("\n");
    if (hasTrailingNewline) {
      lines.pop();
    }
    return {
      lines,
      hasTrailingNewline,
    };
  }

  function serializeTextDocument(lines, hasTrailingNewline) {
    const joined = lines.join("\n");
    if (hasTrailingNewline) {
      return `${joined}\n`;
    }
    return joined;
  }

  function parsePositiveLineNumber(raw, field) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw makeToolError("invalid_range", `${field} must be an integer >= 1`, {
        field,
        value: raw,
      });
    }
    return n;
  }

  async function runReadFileRangeTool(args, ctx) {
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
    const startLine = parsePositiveLineNumber(args?.start_line, "start_line");
    const endLine = parsePositiveLineNumber(args?.end_line, "end_line");
    if (startLine > endLine) {
      throw makeToolError("invalid_range", "start_line must be <= end_line", {
        startLine,
        endLine,
      });
    }
    const requestedCount = endLine - startLine + 1;
    if (requestedCount > maxReadLines) {
      throw makeToolError("range_too_large", `line range must be <= ${maxReadLines}`, {
        requestedCount,
        max: maxReadLines,
      });
    }
    const raw = await fs.readFile(resolved.realPath);
    if (isProbablyBinary(raw)) {
      throw makeToolError("binary_file", "read_file_range supports text files only", {
        path: resolved.relativePath,
      });
    }
    const doc = parseTextDocument(raw.toString("utf8"));
    const totalLines = doc.lines.length;
    if (startLine > totalLines) {
      throw makeToolError("range_out_of_bounds", "requested line range is out of bounds", {
        path: resolved.relativePath,
        startLine,
        endLine,
        totalLines,
      });
    }
    const effectiveEndLine = Math.min(endLine, totalLines);
    const wasClipped = effectiveEndLine !== endLine;
    const selected = doc.lines.slice(startLine - 1, effectiveEndLine);
    return {
      path: resolved.relativePath,
      startLine,
      endLine: effectiveEndLine,
      lineCount: selected.length,
      totalLines,
      clipped: wasClipped,
      requestedEndLine: endLine,
      effectiveEndLine,
      content: selected.join("\n"),
    };
  }

  function parsePatchPathToken(rawToken) {
    const token = String(rawToken || "").trim();
    if (!token) return "";
    const first = token.split(/\s+/)[0];
    if (first === "/dev/null") return "/dev/null";
    if (first.startsWith("a/") || first.startsWith("b/")) return first.slice(2);
    return first;
  }

  function parsePatchHunks(rawLines, source) {
    const hunks = [];
    let current = [];
    for (const line of rawLines) {
      if (line.startsWith("@@")) {
        if (current.length > 0) {
          hunks.push(current);
          current = [];
        }
        continue;
      }
      if (line === "\\ No newline at end of file" || line === "*** End of File") {
        continue;
      }
      if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) {
        current.push(line);
        continue;
      }
      if (!line.trim()) {
        continue;
      }
      throw makeToolError("invalid_patch_format", `unsupported patch line in ${source}`, {
        line,
        source,
      });
    }
    if (current.length > 0) {
      hunks.push(current);
    }
    return hunks;
  }

  function parseBeginEndPatchOperations(rawPatch) {
    const lines = normalizeTextLineEndings(rawPatch).split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i += 1;
    if (lines[i] !== "*** Begin Patch") {
      throw makeToolError("invalid_patch_format", "patch must start with *** Begin Patch");
    }
    i += 1;
    const ops = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }
      if (line === "*** End Patch") {
        return ops;
      }
      if (line.startsWith("*** Add File: ")) {
        const pathText = line.slice("*** Add File: ".length).trim();
        if (!pathText) {
          throw makeToolError("invalid_patch_format", "Add File requires a path");
        }
        i += 1;
        const addLines = [];
        while (i < lines.length && !lines[i].startsWith("*** ")) {
          const raw = lines[i];
          if (!raw.startsWith("+")) {
            throw makeToolError("invalid_patch_format", "Add File expects '+' lines only", {
              line: raw,
            });
          }
          addLines.push(raw.slice(1));
          i += 1;
        }
        ops.push({
          type: "add",
          path: pathText,
          lines: addLines,
        });
        continue;
      }
      if (line.startsWith("*** Delete File: ")) {
        const pathText = line.slice("*** Delete File: ".length).trim();
        if (!pathText) {
          throw makeToolError("invalid_patch_format", "Delete File requires a path");
        }
        i += 1;
        ops.push({
          type: "delete",
          path: pathText,
        });
        continue;
      }
      if (line.startsWith("*** Update File: ")) {
        const pathText = line.slice("*** Update File: ".length).trim();
        if (!pathText) {
          throw makeToolError("invalid_patch_format", "Update File requires a path");
        }
        i += 1;
        let moveTo = "";
        if (i < lines.length && lines[i].startsWith("*** Move to: ")) {
          moveTo = lines[i].slice("*** Move to: ".length).trim();
          i += 1;
        }
        const section = [];
        while (
          i < lines.length &&
          lines[i] !== "*** End Patch" &&
          !lines[i].startsWith("*** Add File: ") &&
          !lines[i].startsWith("*** Delete File: ") &&
          !lines[i].startsWith("*** Update File: ")
        ) {
          section.push(lines[i]);
          i += 1;
        }
        const hunks = parsePatchHunks(section, `update:${pathText}`);
        if (!moveTo && hunks.length === 0) {
          throw makeToolError("invalid_patch_format", `Update File has no hunk: ${pathText}`);
        }
        ops.push({
          type: "update",
          path: pathText,
          moveTo: moveTo || undefined,
          hunks,
        });
        continue;
      }
      throw makeToolError("invalid_patch_format", "unsupported patch section", { line });
    }
    throw makeToolError("invalid_patch_format", "patch is missing *** End Patch");
  }

  function parseUnifiedDiffOperations(rawPatch) {
    const lines = normalizeTextLineEndings(rawPatch).split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    const ops = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("similarity index") || line.startsWith("rename from ") || line.startsWith("rename to ")) {
        i += 1;
        continue;
      }
      if (!line.startsWith("--- ")) {
        i += 1;
        continue;
      }
      const oldPath = parsePatchPathToken(line.slice(4));
      i += 1;
      if (i >= lines.length || !lines[i].startsWith("+++ ")) {
        throw makeToolError("invalid_patch_format", "unified diff is missing +++ header");
      }
      const newPath = parsePatchPathToken(lines[i].slice(4));
      i += 1;
      const hunkLines = [];
      while (i < lines.length) {
        const next = lines[i];
        if (next.startsWith("diff --git ") || next.startsWith("--- ")) {
          break;
        }
        if (
          next.startsWith("index ") ||
          next.startsWith("new file mode") ||
          next.startsWith("deleted file mode") ||
          next.startsWith("similarity index") ||
          next.startsWith("rename from ") ||
          next.startsWith("rename to ")
        ) {
          i += 1;
          continue;
        }
        hunkLines.push(next);
        i += 1;
      }
      const hunks = parsePatchHunks(hunkLines, `unified:${oldPath}->${newPath}`);
      if (oldPath === "/dev/null" && newPath !== "/dev/null") {
        ops.push({ type: "add", path: newPath, hunks });
        continue;
      }
      if (newPath === "/dev/null" && oldPath !== "/dev/null") {
        ops.push({ type: "delete", path: oldPath, hunks });
        continue;
      }
      ops.push({
        type: "update",
        path: oldPath,
        moveTo: oldPath !== newPath ? newPath : undefined,
        hunks,
      });
    }
    if (ops.length <= 0) {
      throw makeToolError("invalid_patch_format", "no file operation found in unified diff");
    }
    return ops;
  }

  function findLineSequence(lines, sequence, startIndex = 0) {
    if (!Array.isArray(sequence) || sequence.length === 0) return startIndex;
    const max = lines.length - sequence.length;
    for (let i = Math.max(0, startIndex); i <= max; i += 1) {
      let matched = true;
      for (let j = 0; j < sequence.length; j += 1) {
        if (lines[i + j] !== sequence[j]) {
          matched = false;
          break;
        }
      }
      if (matched) return i;
    }
    return -1;
  }

  function applyHunksToLines(baseLines, hunks, filePathForError) {
    let lines = Array.isArray(baseLines) ? [...baseLines] : [];
    let cursor = 0;
    let hunksApplied = 0;
    for (const hunk of hunks) {
      const oldLines = [];
      const newLines = [];
      for (const row of hunk) {
        const prefix = row.slice(0, 1);
        const text = row.slice(1);
        if (prefix === " " || prefix === "-") oldLines.push(text);
        if (prefix === " " || prefix === "+") newLines.push(text);
      }
      let index = findLineSequence(lines, oldLines, cursor);
      if (index < 0) {
        index = findLineSequence(lines, oldLines, 0);
      }
      if (index < 0) {
        throw makeToolError("patch_hunk_mismatch", `hunk did not match file content: ${filePathForError}`, {
          path: filePathForError,
          oldLines: oldLines.slice(0, 8),
        });
      }
      lines.splice(index, oldLines.length, ...newLines);
      cursor = index + newLines.length;
      hunksApplied += 1;
    }
    return {
      lines,
      hunksApplied,
    };
  }

  async function readTextFileForPatch(absPath, relativePath) {
    const raw = await fs.readFile(absPath);
    if (isProbablyBinary(raw)) {
      throw makeToolError("binary_file", "apply_patch supports text files only", {
        path: relativePath,
      });
    }
    return parseTextDocument(raw.toString("utf8"));
  }

  async function runApplyPatchTool(args, ctx) {
    const patchText = String(args?.patch || "");
    if (!patchText.trim()) {
      throw makeToolError("invalid_patch_format", "patch is required");
    }
    const operations = patchText.includes("*** Begin Patch")
      ? parseBeginEndPatchOperations(patchText)
      : parseUnifiedDiffOperations(patchText);
    const changed = new Set();
    let hunksApplied = 0;

    for (const op of operations) {
      if (op.type === "add") {
        const target = await resolvePathWithinToolRoot(ctx.rootReal, op.path, {
          allowMissing: true,
          ensureParentDir: true,
        });
        if (target.exists) {
          throw makeToolError("file_exists", `file already exists: ${target.relativePath}`, {
            path: target.relativePath,
          });
        }
        let lines = Array.isArray(op.lines) ? op.lines : [];
        let createdFromUnified = false;
        if (Array.isArray(op.hunks) && op.hunks.length > 0) {
          const applied = applyHunksToLines([], op.hunks, target.relativePath);
          lines = applied.lines;
          hunksApplied += applied.hunksApplied;
          createdFromUnified = true;
        }
        const content = serializeTextDocument(lines, true);
        await fs.writeFile(target.absPath, content, { encoding: "utf8", flag: "wx" });
        changed.add(toUnixPath(path.relative(ctx.rootReal, target.absPath)) || ".");
        if (!createdFromUnified) {
          hunksApplied += 1;
        }
        continue;
      }

      if (op.type === "delete") {
        const target = await resolvePathWithinToolRoot(ctx.rootReal, op.path);
        const stat = await fs.stat(target.realPath);
        if (!stat.isFile()) {
          throw makeToolError("not_a_file", "path is not a file", { path: target.relativePath });
        }
        if (Array.isArray(op.hunks) && op.hunks.length > 0) {
          const doc = await readTextFileForPatch(target.realPath, target.relativePath);
          const applied = applyHunksToLines(doc.lines, op.hunks, target.relativePath);
          hunksApplied += applied.hunksApplied;
        } else {
          hunksApplied += 1;
        }
        await fs.unlink(target.realPath);
        changed.add(target.relativePath);
        continue;
      }

      if (op.type === "update") {
        const source = await resolvePathWithinToolRoot(ctx.rootReal, op.path);
        const stat = await fs.stat(source.realPath);
        if (!stat.isFile()) {
          throw makeToolError("not_a_file", "path is not a file", { path: source.relativePath });
        }
        const current = await readTextFileForPatch(source.realPath, source.relativePath);
        const applied = applyHunksToLines(current.lines, Array.isArray(op.hunks) ? op.hunks : [], source.relativePath);
        const nextHasTrailing = current.hasTrailingNewline || applied.lines.length > 0;
        const nextContent = serializeTextDocument(applied.lines, nextHasTrailing);
        hunksApplied += Math.max(1, applied.hunksApplied);

        const moveToPath = String(op.moveTo || "").trim();
        if (moveToPath) {
          const destination = await resolvePathWithinToolRoot(ctx.rootReal, moveToPath, {
            allowMissing: true,
            ensureParentDir: true,
          });
          if (destination.exists && source.realPath !== destination.realPath) {
            throw makeToolError("file_exists", `destination already exists: ${destination.relativePath}`, {
              path: destination.relativePath,
            });
          }
          await fs.writeFile(destination.absPath, nextContent, "utf8");
          if (source.realPath !== destination.realPath) {
            await fs.unlink(source.realPath);
            changed.add(source.relativePath);
          }
          changed.add(toUnixPath(path.relative(ctx.rootReal, destination.absPath)) || ".");
        } else {
          await fs.writeFile(source.realPath, nextContent, "utf8");
          changed.add(source.relativePath);
        }
        continue;
      }

      throw makeToolError("invalid_patch_format", `unsupported patch operation: ${String(op.type || "")}`);
    }

    return {
      ok: true,
      filesChanged: Array.from(changed).sort((a, b) => a.localeCompare(b)),
      hunksApplied,
      code: "ok",
      message: "patch applied",
    };
  }

  return {
    runApplyPatchTool,
    runReadFileRangeTool,
  };
}
