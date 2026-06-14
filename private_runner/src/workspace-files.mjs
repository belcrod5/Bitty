import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

function toUnixPath(value) {
  return String(value || "").replaceAll(path.sep, "/");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function isPathInsideRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeFileName(rawName) {
  const name = String(rawName || "").trim();
  if (!name || name === "." || name === ".." || name.includes("\u0000")) {
    throw new WorkspaceFilesError(400, "invalid_file_name", "file name is invalid");
  }
  if (name !== path.basename(name) || name.includes("/") || name.includes("\\")) {
    throw new WorkspaceFilesError(400, "invalid_file_name", "file name must not include a path");
  }
  return name;
}

async function resolveRootPath(workspaceRoot, rawRootDir) {
  const rootInput = String(rawRootDir || "").trim();
  if (!rootInput) {
    throw new WorkspaceFilesError(400, "root_directory_required", "rootDir is required");
  }
  const rootAbs = path.isAbsolute(rootInput)
    ? path.resolve(rootInput)
    : path.resolve(workspaceRoot, rootInput);
  try {
    return await fs.realpath(rootAbs);
  } catch (error) {
    const status = String(error?.code || "") === "ENOENT" ? 404 : 400;
    throw new WorkspaceFilesError(status, "root_directory_invalid", error.message);
  }
}

async function resolveExistingPath(workspaceRoot, rootReal, rawPath, {
  requiredCode = "path_required",
  invalidCode = "path_invalid",
} = {}) {
  const targetInput = String(rawPath || "").trim();
  if (!targetInput) {
    throw new WorkspaceFilesError(400, requiredCode, "path is required");
  }
  const candidates = path.isAbsolute(targetInput)
    ? [path.resolve(targetInput)]
    : [
      path.resolve(workspaceRoot, targetInput),
      path.resolve(rootReal, targetInput),
    ];
  let targetReal = "";
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const candidateStat = await fs.lstat(candidate);
      if (candidateStat.isSymbolicLink()) {
        const error = new Error("symbolic links are not supported");
        error.code = "EINVAL";
        throw error;
      }
      const resolved = await fs.realpath(candidate);
      if (isPathInsideRoot(rootReal, resolved)) {
        targetReal = resolved;
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (!targetReal) {
    const status = String(lastError?.code || "") === "ENOENT" ? 404 : 400;
    throw new WorkspaceFilesError(
      status,
      invalidCode,
      lastError?.message || "path escapes root directory"
    );
  }
  return targetReal;
}

async function resolveTargetDirectory(workspaceRoot, rootReal, rawTargetDirectory) {
  const targetInput = String(rawTargetDirectory || "").trim();
  if (!targetInput) {
    throw new WorkspaceFilesError(400, "target_directory_required", "targetDirectory is required");
  }
  const targetReal = await resolveExistingPath(workspaceRoot, rootReal, targetInput, {
    requiredCode: "target_directory_required",
    invalidCode: "target_directory_invalid",
  });
  const stat = await fs.stat(targetReal);
  if (!stat.isDirectory()) {
    throw new WorkspaceFilesError(400, "target_not_directory", "targetDirectory is not a directory");
  }
  return targetReal;
}

async function resolveFilePath(workspaceRoot, rootReal, rawPath) {
  const targetReal = await resolveExistingPath(workspaceRoot, rootReal, rawPath);
  const stat = await fs.stat(targetReal);
  if (!stat.isFile()) {
    throw new WorkspaceFilesError(400, "not_a_file", "path is not a file");
  }
  return targetReal;
}

function toClientPath(workspaceRoot, targetPath) {
  const relative = path.relative(workspaceRoot, targetPath);
  if (isPathInsideRoot(workspaceRoot, targetPath)) {
    return toUnixPath(relative) || ".";
  }
  return toUnixPath(path.resolve(targetPath));
}

export class WorkspaceFilesError extends Error {
  constructor(status, code, message, extra = {}) {
    super(String(message || code || "workspace_files_failed"));
    this.status = Number(status) || 500;
    this.code = String(code || "workspace_files_failed");
    this.extra = extra && typeof extra === "object" ? extra : {};
  }
}

export function createWorkspaceFilesService({
  workspaceRoot,
  maxUploadBytes,
}) {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const workspaceRootRealPromise = fs.realpath(resolvedWorkspaceRoot);
  const maxBytes = Math.max(1, Number(maxUploadBytes) || 25 * 1024 * 1024);

  async function saveFile({
    rootDir,
    targetDirectory,
    fileName,
    mimeType,
    data,
  }) {
    const normalizedName = normalizeFileName(fileName);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (buffer.length <= 0) {
      throw new WorkspaceFilesError(400, "file_empty", "file is empty");
    }
    if (buffer.length > maxBytes) {
      throw new WorkspaceFilesError(413, "file_too_large", `file is larger than ${maxBytes} bytes`, {
        maxBytes,
      });
    }

    const workspaceRootReal = await workspaceRootRealPromise;
    const rootReal = await resolveRootPath(workspaceRootReal, rootDir);
    const targetDirectoryReal = await resolveTargetDirectory(
      workspaceRootReal,
      rootReal,
      targetDirectory
    );
    const targetPath = path.join(targetDirectoryReal, normalizedName);
    if (!isPathInsideRoot(rootReal, targetPath)) {
      throw new WorkspaceFilesError(400, "path_escapes_root", "target path escapes root directory");
    }

    const temporaryPath = path.join(
      targetDirectoryReal,
      `.${normalizedName}.upload-${randomUUID()}.tmp`
    );
    try {
      await fs.writeFile(temporaryPath, buffer, { flag: "wx" });
      await fs.link(temporaryPath, targetPath);
    } catch (error) {
      if (String(error?.code || "") === "EEXIST") {
        throw new WorkspaceFilesError(409, "file_exists", `file already exists: ${normalizedName}`);
      }
      throw error;
    } finally {
      await fs.unlink(temporaryPath).catch(() => {});
    }

    return {
      ok: true,
      name: normalizedName,
      path: toClientPath(workspaceRootReal, targetPath),
      directory: toClientPath(workspaceRootReal, targetDirectoryReal),
      size: buffer.length,
      mimeType: String(mimeType || "application/octet-stream").trim() || "application/octet-stream",
    };
  }

  async function renameFile({ rootDir, path: rawPath, name: rawName }) {
    const normalizedName = normalizeFileName(rawName);
    const workspaceRootReal = await workspaceRootRealPromise;
    const rootReal = await resolveRootPath(workspaceRootReal, rootDir);
    const sourceReal = await resolveFilePath(workspaceRootReal, rootReal, rawPath);
    const targetPath = path.join(path.dirname(sourceReal), normalizedName);
    if (!isPathInsideRoot(rootReal, targetPath)) {
      throw new WorkspaceFilesError(400, "path_escapes_root", "target path escapes root directory");
    }
    if (targetPath === sourceReal) {
      return {
        ok: true,
        name: normalizedName,
        path: toClientPath(workspaceRootReal, sourceReal),
        previousPath: toClientPath(workspaceRootReal, sourceReal),
      };
    }
    try {
      await fs.link(sourceReal, targetPath);
    } catch (error) {
      if (String(error?.code || "") === "EEXIST") {
        throw new WorkspaceFilesError(409, "file_exists", `file already exists: ${normalizedName}`);
      }
      throw error;
    }
    try {
      await fs.unlink(sourceReal);
    } catch (error) {
      await fs.unlink(targetPath).catch(() => {});
      throw error;
    }
    return {
      ok: true,
      name: normalizedName,
      path: toClientPath(workspaceRootReal, targetPath),
      previousPath: toClientPath(workspaceRootReal, sourceReal),
    };
  }

  async function deleteFile({ rootDir, path: rawPath }) {
    const workspaceRootReal = await workspaceRootRealPromise;
    const rootReal = await resolveRootPath(workspaceRootReal, rootDir);
    const targetReal = await resolveFilePath(workspaceRootReal, rootReal, rawPath);
    const clientPath = toClientPath(workspaceRootReal, targetReal);
    await fs.unlink(targetReal);
    return {
      ok: true,
      path: clientPath,
    };
  }

  async function parseAndSaveRequest(req, pathname = "/workspace/files") {
    const contentLength = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes + 1024 * 1024) {
      throw new WorkspaceFilesError(413, "request_too_large", "upload request is too large", {
        maxBytes,
      });
    }
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("multipart/form-data")) {
      throw new WorkspaceFilesError(
        415,
        "multipart_required",
        "Use multipart/form-data with file field"
      );
    }
    const requestForForm = new Request(`http://runner.local${pathname}`, {
      method: req.method,
      headers: req.headers,
      body: req,
      duplex: "half",
    });
    const form = await requestForForm.formData();
    const filePart = form.get("file");
    if (!filePart || typeof filePart.arrayBuffer !== "function") {
      throw new WorkspaceFilesError(400, "file_required", "file field is required");
    }
    const data = Buffer.from(await filePart.arrayBuffer());
    return saveFile({
      rootDir: form.get("rootDir"),
      targetDirectory: form.get("targetDirectory"),
      fileName: form.get("fileName") || filePart.name,
      mimeType: filePart.type,
      data,
    });
  }

  async function parseMutationRequest(req) {
    const maxMutationBodyBytes = 16 * 1024;
    const contentLength = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxMutationBodyBytes) {
      throw new WorkspaceFilesError(413, "request_too_large", "mutation request is too large");
    }
    let body = {};
    try {
      const chunks = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > maxMutationBodyBytes) {
          throw new WorkspaceFilesError(413, "request_too_large", "mutation request is too large");
        }
        chunks.push(buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch (error) {
      if (error instanceof WorkspaceFilesError) throw error;
      throw new WorkspaceFilesError(400, "invalid_json", "request body must be valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new WorkspaceFilesError(400, "invalid_json", "request body must be a JSON object");
    }
    if (req.method === "PATCH") {
      return renameFile({
        rootDir: body.rootDir,
        path: body.path,
        name: body.name,
      });
    }
    if (req.method === "DELETE") {
      return deleteFile({
        rootDir: body.rootDir,
        path: body.path,
      });
    }
    throw new WorkspaceFilesError(405, "method_not_allowed", "method is not allowed");
  }

  async function handleRequest(req, res, {
    expectedToken,
    receivedToken,
    pathname = "/workspace/files",
  }) {
    if (!expectedToken) {
      return sendJson(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (receivedToken !== expectedToken) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    try {
      const isUpload = req.method === "POST";
      const payload = isUpload
        ? await parseAndSaveRequest(req, pathname)
        : await parseMutationRequest(req);
      return sendJson(res, isUpload ? 201 : 200, payload);
    } catch (error) {
      if (error instanceof WorkspaceFilesError) {
        return sendJson(res, error.status, {
          error: error.code,
          message: error.message,
          ...error.extra,
        });
      }
      return sendJson(res, 500, {
        error: "workspace_files_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    handleRequest,
    parseAndSaveRequest,
    parseMutationRequest,
    saveFile,
    renameFile,
    deleteFile,
  };
}
