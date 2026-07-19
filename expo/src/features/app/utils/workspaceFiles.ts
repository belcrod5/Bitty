import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { File as ExpoFile, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

const WORKSPACE_UPLOAD_TIMEOUT_MS = 60_000;
const WORKSPACE_MUTATION_TIMEOUT_MS = 12_000;
const WORKSPACE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export type WorkspaceUploadSource = "photos" | "files" | "clipboard";

type WorkspaceUploadAsset = {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
  cleanup?: () => void;
};

export type WorkspaceFileUploadResult = {
  ok: boolean;
  name: string;
  path: string;
  directory: string;
  size: number;
  mimeType: string;
};

export type WorkspaceFileMutationResult = {
  ok: boolean;
  path: string;
  directory?: string;
  previousPath?: string;
  previousDirectory?: string;
  name?: string;
};

export type WorkspaceFileTarget = {
  path: string;
  name: string;
};

function timestampForFileName() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ];
  return parts.join("");
}

function fileExtensionForMimeType(mimeType: string) {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/heic") return "heic";
  if (normalized === "image/heif") return "heif";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  return "png";
}

function validateAssetSize(size?: number) {
  if (Number.isFinite(size) && Number(size) > WORKSPACE_UPLOAD_MAX_BYTES) {
    throw new Error(`アップロードできるファイルは最大${WORKSPACE_UPLOAD_MAX_BYTES / 1024 / 1024}MBです。`);
  }
}

async function pickPhoto(): Promise<WorkspaceUploadAsset | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: false,
    quality: 1,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset?.uri) return null;
  validateAssetSize(asset.fileSize);
  const mimeType = String(asset.mimeType || "image/png").trim() || "image/png";
  return {
    uri: asset.uri,
    name: String(asset.fileName || "").trim()
      || `photo-${timestampForFileName()}.${fileExtensionForMimeType(mimeType)}`,
    mimeType,
    size: asset.fileSize,
  };
}

async function pickFile(): Promise<WorkspaceUploadAsset | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset?.uri) return null;
  validateAssetSize(asset.size);
  return {
    uri: asset.uri,
    name: String(asset.name || "").trim() || `file-${timestampForFileName()}`,
    mimeType: String(asset.mimeType || "application/octet-stream").trim()
      || "application/octet-stream",
    size: asset.size,
  };
}

async function createClipboardAsset(): Promise<WorkspaceUploadAsset | null> {
  if (await Clipboard.hasImageAsync()) {
    const image = await Clipboard.getImageAsync({ format: "png" });
    if (!image?.data) return null;
    const base64 = image.data.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
    const file = new ExpoFile(
      Paths.cache,
      `clipboard-${timestampForFileName()}-${Date.now()}.png`
    );
    file.create({ overwrite: true, intermediates: true });
    file.write(base64, { encoding: "base64" });
    validateAssetSize(file.info().size);
    return {
      uri: file.uri,
      name: `clipboard-${timestampForFileName()}.png`,
      mimeType: "image/png",
      size: file.info().size,
      cleanup: () => {
        if (file.exists) file.delete();
      },
    };
  }

  const text = await Clipboard.getStringAsync();
  if (!text) return null;
  const file = new ExpoFile(
    Paths.cache,
    `clipboard-${timestampForFileName()}-${Date.now()}.txt`
  );
  file.create({ overwrite: true, intermediates: true });
  file.write(text);
  validateAssetSize(file.info().size);
  return {
    uri: file.uri,
    name: `clipboard-${timestampForFileName()}.txt`,
    mimeType: "text/plain",
    size: file.info().size,
    cleanup: () => {
      if (file.exists) file.delete();
    },
  };
}

async function selectWorkspaceUploadAsset(
  source: WorkspaceUploadSource
): Promise<WorkspaceUploadAsset | null> {
  if (source === "photos") return pickPhoto();
  if (source === "files") return pickFile();
  return createClipboardAsset();
}

export async function uploadWorkspaceFile({
  runnerUrl,
  runnerToken,
  rootDirectory,
  targetDirectory,
  source,
}: {
  runnerUrl: string;
  runnerToken: string;
  rootDirectory: string;
  targetDirectory: string;
  source: WorkspaceUploadSource;
}): Promise<WorkspaceFileUploadResult | null> {
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  if (!baseUrl || !token) {
    throw new Error("Runner URL または Runner Token が未設定です。");
  }
  const asset = await selectWorkspaceUploadAsset(source);
  if (!asset) return null;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), WORKSPACE_UPLOAD_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("rootDir", String(rootDirectory || "").trim());
    form.append("targetDirectory", String(targetDirectory || "").trim());
    form.append("fileName", asset.name);
    form.append("file", {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType,
    } as any);
    const response = await fetch(`${baseUrl}/workspace/files`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: form,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
    }
    return {
      ok: Boolean(data?.ok),
      name: String(data?.name || asset.name),
      path: String(data?.path || ""),
      directory: String(data?.directory || targetDirectory),
      size: Number(data?.size || asset.size || 0),
      mimeType: String(data?.mimeType || asset.mimeType),
    };
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
      throw new Error(`アップロードがタイムアウトしました（${WORKSPACE_UPLOAD_TIMEOUT_MS / 1000}秒）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    asset.cleanup?.();
  }
}

export async function mutateWorkspaceFile({
  runnerUrl,
  runnerToken,
  rootDirectory,
  path,
  operation,
  name,
}: {
  runnerUrl: string;
  runnerToken: string;
  rootDirectory: string;
  path: string;
  operation: "rename" | "delete";
  name?: string;
}): Promise<WorkspaceFileMutationResult> {
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  const targetPath = String(path || "").trim();
  if (!baseUrl || !token) {
    throw new Error("Runner URL または Runner Token が未設定です。");
  }
  if (!targetPath) {
    throw new Error("対象ファイルが未指定です。");
  }
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), WORKSPACE_MUTATION_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/workspace/files`, {
      method: operation === "rename" ? "PATCH" : "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        rootDir: String(rootDirectory || "").trim(),
        path: targetPath,
        ...(operation === "rename" ? { name: String(name || "").trim() } : {}),
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
    }
    return {
      ok: Boolean(data?.ok),
      path: String(data?.path || targetPath),
      directory: data?.directory ? String(data.directory) : undefined,
      previousPath: data?.previousPath ? String(data.previousPath) : undefined,
      previousDirectory: data?.previousDirectory ? String(data.previousDirectory) : undefined,
      name: data?.name ? String(data.name) : undefined,
    };
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
      throw new Error(`ファイル操作がタイムアウトしました（${WORKSPACE_MUTATION_TIMEOUT_MS / 1000}秒）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function createWorkspaceTextFile({
  runnerUrl,
  runnerToken,
  rootDirectory,
  targetDirectory,
  name,
  content = "",
}: {
  runnerUrl: string;
  runnerToken: string;
  rootDirectory: string;
  targetDirectory: string;
  name: string;
  content?: string;
}): Promise<WorkspaceFileMutationResult> {
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  const fileName = String(name || "").trim();
  const directory = String(targetDirectory || "").trim();
  if (!baseUrl || !token) {
    throw new Error("Runner URL または Runner Token が未設定です。");
  }
  if (!directory || !fileName) {
    throw new Error("作成先またはファイル名が未指定です。");
  }
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), WORKSPACE_MUTATION_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/workspace/files`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        create: true,
        rootDir: String(rootDirectory || "").trim(),
        targetDirectory: directory,
        name: fileName,
        content: String(content ?? ""),
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
    }
    return {
      ok: Boolean(data?.ok),
      path: String(data?.path || `${directory}/${fileName}`),
      directory: data?.directory ? String(data.directory) : directory,
      name: data?.name ? String(data.name) : fileName,
    };
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
      throw new Error(`ファイル作成がタイムアウトしました（${WORKSPACE_MUTATION_TIMEOUT_MS / 1000}秒）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function writeWorkspaceTextFile({
  runnerUrl,
  runnerToken,
  rootDirectory,
  path,
  content,
}: {
  runnerUrl: string;
  runnerToken: string;
  rootDirectory: string;
  path: string;
  content: string;
}): Promise<WorkspaceFileMutationResult> {
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  const targetPath = String(path || "").trim();
  if (!baseUrl || !token) {
    throw new Error("Runner URL または Runner Token が未設定です。");
  }
  if (!targetPath) {
    throw new Error("対象ファイルが未指定です。");
  }
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), WORKSPACE_UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/workspace/files`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        rootDir: String(rootDirectory || "").trim(),
        path: targetPath,
        content: String(content ?? ""),
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
    }
    return {
      ok: Boolean(data?.ok),
      path: String(data?.path || targetPath),
      directory: data?.directory ? String(data.directory) : undefined,
    };
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
      throw new Error(`保存がタイムアウトしました（${WORKSPACE_UPLOAD_TIMEOUT_MS / 1000}秒）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
