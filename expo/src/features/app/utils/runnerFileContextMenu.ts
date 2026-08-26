import { Alert } from "react-native";
import * as Clipboard from "../clipboard";
import { fetchRunnerTextFileContent } from "./runnerFileContent";
import type { WorkspaceFileTarget } from "./workspaceFiles";

export const RUNNER_FILE_HTTP_TIMEOUT_MS = 12_000;

type StartRunnerShellScriptParams = {
  runnerUrl: string;
  runnerToken: string;
  path: string;
  allowExternal?: boolean;
};

export type StartRunnerShellScriptResult = {
  ok: boolean;
  jobId: string;
  path: string;
  pid: number;
};

const RUNNER_VIDEO_FILE_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
  "avi",
]);

const RUNNER_EDITABLE_TEXT_FILE_EXTENSIONS = new Set([
  "txt",
  "md",
]);

const RUNNER_FILE_VIEWER_KIND_BY_EXTENSION: Record<string, RunnerFileViewerKind> = {
  html: "html",
  htm: "html",
  drawio: "drawio",
  checklist: "checklist",
};

const RUNNER_IMAGE_FILE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "heic",
  "heif",
  "bmp",
  "tif",
  "tiff",
]);

export type RunnerMediaKind = "video" | "image";

export type RunnerFileViewerKind = "html" | "drawio" | "checklist";

export type RunnerFileViewerTarget = WorkspaceFileTarget & {
  kind: RunnerFileViewerKind;
  rootDirectory: string;
};

export type RunnerMediaItem = {
  kind: RunnerMediaKind;
  path: string;
  name: string;
  url: string;
};

export type RunnerMediaContextMenuOptions = {
  onRequestRename?: (target: WorkspaceFileTarget) => void;
};

export type RenameRunnerMediaFile = (
  target: WorkspaceFileTarget,
  nextName: string,
) => Promise<void>;

export type RunnerMediaFile = RunnerMediaItem & {
  runnerToken: string;
  items?: RunnerMediaItem[];
  initialIndex?: number;
  renameFile?: RenameRunnerMediaFile;
  openContextMenuForItem?: (
    item: RunnerMediaItem,
    options?: RunnerMediaContextMenuOptions,
  ) => void;
};

export async function startRunnerShellScript({
  runnerUrl,
  runnerToken,
  path,
  allowExternal = false,
}: StartRunnerShellScriptParams): Promise<StartRunnerShellScriptResult> {
  const filePath = normalizeRunnerPath(path);
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  if (!filePath) {
    throw new Error("実行対象ファイルが未指定です");
  }
  if (!baseUrl || !token) {
    throw new Error("Runner URL または Runner Token が未設定です");
  }
  const response = await fetch(`${baseUrl}/scripts/start`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      path: filePath,
      ...(allowExternal ? { allowExternal: true } : {}),
    }),
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
  }
  const job = data?.job && typeof data.job === "object" ? data.job as Record<string, unknown> : {};
  return {
    ok: Boolean(data?.ok),
    jobId: String(job.jobId || "").trim(),
    path: String(job.path || filePath).trim() || filePath,
    pid: Number(job.pid || 0),
  };
}

export type RunnerFileActionParams = {
  filePathRaw: unknown;
  fileNameRaw?: unknown;
  runnerUrl: string;
  runnerToken: string;
  rootDir: string;
  allowExecute?: boolean;
  allowMutate?: boolean;
  getPathLabel: (pathRaw: unknown) => string;
  showInfoToast: (textRaw: unknown) => void;
  onOpenMedia: (media: RunnerMediaFile) => void;
  onOpenFile?: (target: RunnerFileViewerTarget) => void;
  onSpeakText?: (text: string, target: WorkspaceFileTarget) => void;
  onShellScriptStarted?: (result: StartRunnerShellScriptResult, fileName: string) => void;
  onRequestRename?: (target: WorkspaceFileTarget) => void;
  onRequestEdit?: (target: WorkspaceFileTarget) => void;
  onRequestDelete?: (target: WorkspaceFileTarget) => void;
  onRenameFile?: RenameRunnerMediaFile;
  mediaItems?: RunnerMediaItem[];
  skiaBoard?: {
    hasFile: (rootDirectory: string, path: string) => boolean;
    addFile?: (file: { rootDir: string; path: string; name: string }) => void;
    removeFile?: (rootDirectory: string, path: string) => void;
  };
};

type RunnerFileOpenPresentation =
  | { kind: RunnerMediaKind; buttonText: string }
  | { kind: "viewer"; buttonText: string; viewerKind: RunnerFileViewerKind };

function getRunnerFileOpenPresentation(
  filePath: string,
  canOpenViewer: boolean,
): RunnerFileOpenPresentation | null {
  const mediaKind = getRunnerMediaKind(filePath);
  if (mediaKind) {
    return {
      kind: mediaKind,
      buttonText: mediaKind === "video" ? "再生" : "表示",
    };
  }
  const viewerKind = getRunnerFileViewerKind(filePath);
  return canOpenViewer && viewerKind
    ? { kind: "viewer", buttonText: "開く", viewerKind }
    : null;
}

export function openRunnerFile(params: RunnerFileActionParams): boolean {
  const filePath = normalizeRunnerPath(params.filePathRaw);
  const fileName = String(params.fileNameRaw || "").trim()
    || params.getPathLabel(filePath)
    || filePath
    || "file";
  const presentation = getRunnerFileOpenPresentation(filePath, Boolean(params.onOpenFile));
  if (!presentation) {
    Alert.alert("開けません", `${fileName} に対応する表示方法がありません。`);
    return false;
  }
  if (presentation.kind === "viewer") {
    if (!params.onOpenFile) return false;
    const location = getRunnerFileViewerLocation(filePath, params.rootDir);
    params.onOpenFile({
      kind: presentation.viewerKind,
      path: location.path,
      name: fileName,
      rootDirectory: location.rootDirectory,
    });
    return true;
  }

  const currentItem = buildRunnerMediaItem({
    runnerUrl: params.runnerUrl,
    rootDir: params.rootDir,
    path: filePath,
    name: fileName,
  });
  const runnerToken = String(params.runnerToken || "").trim();
  if (!currentItem || !runnerToken) {
    Alert.alert("表示失敗", "Runner URL または Runner Token が未設定です。");
    return false;
  }
  const items = normalizeRunnerMediaItems(params.mediaItems, currentItem);
  const initialIndex = items.findIndex((item) => normalizeRunnerPath(item.path) === filePath);
  params.onOpenMedia({
    ...currentItem,
    runnerToken,
    items,
    initialIndex: initialIndex >= 0 ? initialIndex : 0,
    renameFile: params.onRenameFile,
    openContextMenuForItem: (itemRaw, options) => {
      const item = buildRunnerMediaItem({
        runnerUrl: params.runnerUrl,
        rootDir: params.rootDir,
        path: itemRaw.path,
        name: itemRaw.name,
      });
      if (!item) return;
      openRunnerFileContextMenu({
        ...params,
        filePathRaw: item.path,
        fileNameRaw: item.name,
        onRequestRename: options?.onRequestRename ?? params.onRequestRename,
        mediaItems: items,
      });
    },
  });
  return true;
}

export function openRunnerFileContextMenu(params: RunnerFileActionParams) {
  const {
  filePathRaw,
  fileNameRaw,
  runnerUrl,
  runnerToken,
  rootDir,
  allowExecute = true,
  allowMutate = false,
  getPathLabel,
  showInfoToast,
  onOpenFile,
  onSpeakText,
  onShellScriptStarted,
  onRequestRename,
  onRequestEdit,
  onRequestDelete,
  skiaBoard,
  } = params;
  const filePath = normalizeRunnerPath(filePathRaw);
  const fileName = String(fileNameRaw || "").trim() || getPathLabel(filePath) || filePath || "file";
  if (!filePath) return;
  const fileLocation = getRunnerFileViewerLocation(filePath, rootDir);
  const isShellScript = allowExecute && filePath.toLowerCase().endsWith(".sh");
  const openPresentation = getRunnerFileOpenPresentation(filePath, Boolean(onOpenFile));
  const copyPathAction = () => {
    void Clipboard.setStringAsync(filePath)
      .then(() => {
        showInfoToast(`コピーしました: ${filePath}`);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        Alert.alert("コピー失敗", message || "相対パスのコピーに失敗しました。");
      });
  };
  const copyContentAction = () => {
    void fetchRunnerTextFileContent({
      runnerUrl,
      runnerToken,
      rootDir,
      path: filePath,
      timeoutMs: RUNNER_FILE_HTTP_TIMEOUT_MS,
    })
      .then((result) => Clipboard.setStringAsync(result.content).then(() => result))
      .then((result) => {
        showInfoToast(`ファイル内容をコピーしました: ${result.path || filePath}`);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        Alert.alert("コピー失敗", message || "ファイル内容のコピーに失敗しました。");
      });
  };
  const speakContentAction = () => {
    void fetchRunnerTextFileContent({
      runnerUrl,
      runnerToken,
      rootDir,
      path: filePath,
      timeoutMs: RUNNER_FILE_HTTP_TIMEOUT_MS,
    })
      .then((result) => {
        if (!result.content.trim()) {
          showInfoToast(`読み上げるテキストがありません: ${result.path || filePath}`);
          return;
        }
        onSpeakText?.(result.content, {
          path: filePath,
          name: fileName,
        });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        Alert.alert("読み上げ失敗", message || "ファイル内容の取得に失敗しました。");
      });
  };
  const executeAction = () => {
    const warning = getRunnerScriptExecutionWarning(filePath, rootDir);
    Alert.alert(
      warning?.title || "実行確認",
      warning
        ? `${warning.message}\n\n${filePath} を実行してもよろしいですか？`
        : `${filePath} を実行してもよろしいですか？`,
      [
        {
          text: "キャンセル",
          style: "cancel",
        },
        {
          text: "実行する",
          style: "destructive",
          onPress: () => {
            void startRunnerShellScript({
              runnerUrl,
              runnerToken,
              path: filePath,
              allowExternal: warning?.allowExternal,
            })
              .then((result) => {
                if (!result.ok) {
                  Alert.alert("実行失敗", "スクリプトの起動に失敗しました。");
                  return;
                }
                showInfoToast(`実行開始: ${fileName} (${result.jobId || "job"})`);
                onShellScriptStarted?.(result, fileName);
              })
              .catch((err) => {
                const message = err instanceof Error ? err.message : String(err);
                Alert.alert("実行失敗", message || "スクリプトの実行に失敗しました。");
              });
          },
        },
      ]
    );
  };
  const deleteAction = () => {
    Alert.alert(
      "ファイルを削除しますか？",
      filePath,
      [
        {
          text: "キャンセル",
          style: "cancel",
        },
        {
          text: "削除",
          style: "destructive",
          onPress: () => onRequestDelete?.({
            path: filePath,
            name: fileName,
          }),
        },
      ]
    );
  };
  const buttons: Array<{
    text: string;
    style?: "default" | "cancel" | "destructive";
    onPress?: () => void;
  }> = [
    {
      text: "相対パスをコピー",
      onPress: copyPathAction,
    },
  ];
  if (openPresentation && openPresentation.kind !== "viewer") {
    buttons.push({
      text: openPresentation.buttonText,
      onPress: () => {
        openRunnerFile(params);
      },
    });
  } else {
    if (openPresentation) {
      buttons.push({
        text: openPresentation.buttonText,
        onPress: () => {
          openRunnerFile(params);
        },
      });
    }
    buttons.push({
      text: "ファイル内容をコピー",
      onPress: copyContentAction,
    });
    if (onSpeakText && isRunnerEditableTextFile(filePath)) {
      buttons.push({
        text: "読み上げ",
        onPress: speakContentAction,
      });
    }
  }
  if (isShellScript) {
    buttons.push({
      text: "実行する",
      style: "destructive",
      onPress: executeAction,
    });
  }
  if (allowMutate && onRequestEdit && isRunnerEditableTextFile(filePath)) {
    buttons.push({
      text: "編集",
      onPress: () => {
        onRequestEdit({
          path: filePath,
          name: fileName,
        });
      },
    });
  }
  if (allowMutate && onRequestRename) {
    buttons.push({
      text: "名前を変更",
      onPress: () => {
        onRequestRename({
          path: filePath,
          name: fileName,
        });
      },
    });
  }
  if (allowMutate && onRequestDelete) {
    buttons.push({
      text: "削除",
      style: "destructive",
      onPress: deleteAction,
    });
  }
  if (skiaBoard) {
    const onBoard = skiaBoard.hasFile(fileLocation.rootDirectory, fileLocation.path);
    if ((onBoard && skiaBoard.removeFile) || (!onBoard && skiaBoard.addFile)) {
      buttons.push({
        text: onBoard ? "Skiaボードから除外" : "Skiaボードへ追加",
        onPress: () => {
          if (onBoard) {
            skiaBoard.removeFile?.(fileLocation.rootDirectory, fileLocation.path);
          } else {
            skiaBoard.addFile?.({
              rootDir: fileLocation.rootDirectory,
              path: fileLocation.path,
              name: fileName,
            });
          }
        },
      });
    }
  }
  buttons.push({
    text: "キャンセル",
    style: "cancel",
  });
  Alert.alert(fileName, filePath, buttons);
}

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

function isAbsoluteRunnerPath(pathRaw: unknown) {
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

export function getRunnerFileViewerLocation(pathRaw: unknown, rootDirectoryRaw: unknown) {
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

function getRunnerScriptExecutionWarning(filePath: string, rootDir: string) {
  const isAbsolute = isAbsoluteRunnerPath(filePath);
  const isOutsideSelectedDirectory = !isRunnerPathInsideDirectory(filePath, rootDir);
  if (!isAbsolute && !isOutsideSelectedDirectory) return null;
  if (isAbsolute) {
    return {
      title: "絶対パスのスクリプト実行確認",
      message: isOutsideSelectedDirectory
        ? "選択中のディレクトリ外にあるスクリプトです。"
        : "絶対パスで指定されたスクリプトです。",
      allowExternal: true,
    };
  }
  return {
    title: "別ディレクトリのスクリプト実行確認",
    message: "選択中のディレクトリとは別の場所にあるスクリプトです。",
    allowExternal: false,
  };
}

export function isRunnerEditableTextFile(pathRaw: unknown) {
  const path = normalizeRunnerPath(pathRaw).toLowerCase();
  const match = /\.([a-z0-9]+)$/.exec(path);
  return Boolean(match && RUNNER_EDITABLE_TEXT_FILE_EXTENSIONS.has(match[1]));
}

export function getRunnerFileViewerKind(pathRaw: unknown): RunnerFileViewerKind | null {
  const path = normalizeRunnerPath(pathRaw).toLowerCase();
  const match = /\.([a-z0-9]+)$/.exec(path);
  return match ? RUNNER_FILE_VIEWER_KIND_BY_EXTENSION[match[1]] ?? null : null;
}

export function getRunnerMediaKind(pathRaw: unknown): RunnerMediaKind | null {
  const path = normalizeRunnerPath(pathRaw).toLowerCase();
  const match = /\.([a-z0-9]+)$/.exec(path);
  if (!match) return null;
  if (RUNNER_VIDEO_FILE_EXTENSIONS.has(match[1])) return "video";
  if (RUNNER_IMAGE_FILE_EXTENSIONS.has(match[1])) return "image";
  return null;
}

export function buildRunnerMediaItem(params: {
  runnerUrl: string;
  rootDir: string;
  path: string;
  name?: string;
}): RunnerMediaItem | null {
  const targetPath = normalizeRunnerPath(params.path);
  const kind = getRunnerMediaKind(targetPath);
  const url = buildRunnerMediaFileUrl({
    runnerUrl: params.runnerUrl,
    rootDir: params.rootDir,
    path: targetPath,
  });
  if (!kind || !targetPath || !url) return null;
  const name = String(params.name || "").trim()
    || targetPath.split("/").filter(Boolean).pop()
    || targetPath;
  return {
    kind,
    path: targetPath,
    name,
    url,
  };
}

function normalizeRunnerMediaItems(
  itemsRaw: RunnerMediaItem[] | undefined,
  currentItem: RunnerMediaItem,
): RunnerMediaItem[] {
  const next: RunnerMediaItem[] = [];
  const seen = new Set<string>();
  const pushItem = (itemRaw: RunnerMediaItem | null | undefined) => {
    if (!itemRaw) return;
    const path = normalizeRunnerPath(itemRaw.path);
    if (!path || seen.has(path)) return;
    seen.add(path);
    next.push({
      kind: itemRaw.kind,
      path,
      name: String(itemRaw.name || "").trim() || path,
      url: String(itemRaw.url || "").trim(),
    });
  };
  for (const item of itemsRaw || []) {
    pushItem(item);
  }
  pushItem(currentItem);
  return next.length > 0 ? next : [currentItem];
}

export function buildRunnerMediaFileUrl(params: {
  runnerUrl: string;
  rootDir: string;
  path: string;
}) {
  const baseUrl = String(params.runnerUrl || "").trim().replace(/\/$/, "");
  const targetPath = normalizeRunnerPath(params.path);
  if (!baseUrl || !targetPath) return "";
  try {
    const url = new URL(`${baseUrl}/files/media`);
    url.searchParams.set("path", targetPath);
    if (params.rootDir) {
      url.searchParams.set("rootDir", params.rootDir);
    }
    return url.toString();
  } catch {
    return "";
  }
}
