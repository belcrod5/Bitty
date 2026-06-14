import { Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import { fetchRunnerTextFileContent } from "./runnerFileContent";
import type { WorkspaceFileTarget } from "./workspaceFiles";

export const RUNNER_FILE_HTTP_TIMEOUT_MS = 12_000;

type StartRunnerShellScriptParams = {
  runnerUrl: string;
  runnerToken: string;
  path: string;
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

type OpenRunnerFileContextMenuParams = {
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
  onShellScriptStarted?: (result: StartRunnerShellScriptResult, fileName: string) => void;
  onRequestRename?: (target: WorkspaceFileTarget) => void;
  onRequestDelete?: (target: WorkspaceFileTarget) => void;
  onRenameFile?: RenameRunnerMediaFile;
  mediaItems?: RunnerMediaItem[];
};

export function openRunnerFileContextMenu({
  filePathRaw,
  fileNameRaw,
  runnerUrl,
  runnerToken,
  rootDir,
  allowExecute = true,
  allowMutate = false,
  getPathLabel,
  showInfoToast,
  onOpenMedia,
  onShellScriptStarted,
  onRequestRename,
  onRequestDelete,
  onRenameFile,
  mediaItems,
}: OpenRunnerFileContextMenuParams) {
  const filePath = normalizeRunnerPath(filePathRaw);
  const fileName = String(fileNameRaw || "").trim() || getPathLabel(filePath) || filePath || "file";
  if (!filePath) return;
  const isShellScript = allowExecute && filePath.toLowerCase().endsWith(".sh");
  const mediaKind = getRunnerMediaKind(filePath);
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
  const openMediaAction = () => {
    const currentItem = buildRunnerMediaItem({
      runnerUrl,
      rootDir,
      path: filePath,
      name: fileName,
    });
    if (!currentItem || !String(runnerToken || "").trim()) {
      Alert.alert("表示失敗", "Runner URL または Runner Token が未設定です。");
      return;
    }
    const items = normalizeRunnerMediaItems(mediaItems, currentItem);
    const initialIndex = items.findIndex((item) => normalizeRunnerPath(item.path) === filePath);
    const openContextMenuForItem = (
      itemRaw: RunnerMediaItem,
      options?: RunnerMediaContextMenuOptions,
    ) => {
      const item = buildRunnerMediaItem({
        runnerUrl,
        rootDir,
        path: itemRaw.path,
        name: itemRaw.name,
      });
      if (!item) return;
      openRunnerFileContextMenu({
        filePathRaw: item.path,
        fileNameRaw: item.name,
        runnerUrl,
        runnerToken,
        rootDir,
        allowExecute,
        allowMutate,
        getPathLabel,
        showInfoToast,
        onOpenMedia,
        onShellScriptStarted,
        onRequestRename: options?.onRequestRename ?? onRequestRename,
        onRequestDelete,
        onRenameFile,
        mediaItems: items,
      });
    };
    onOpenMedia({
      ...currentItem,
      runnerToken: String(runnerToken || "").trim(),
      items,
      initialIndex: initialIndex >= 0 ? initialIndex : 0,
      renameFile: onRenameFile,
      openContextMenuForItem,
    });
  };
  const executeAction = () => {
    Alert.alert(
      "実行確認",
      `${filePath} を実行してもよろしいですか？`,
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
  if (mediaKind) {
    buttons.push({
      text: mediaKind === "video" ? "再生" : "表示",
      onPress: openMediaAction,
    });
  } else {
    buttons.push({
      text: "ファイル内容をコピー",
      onPress: copyContentAction,
    });
  }
  if (isShellScript) {
    buttons.push({
      text: "実行する",
      style: "destructive",
      onPress: executeAction,
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
  buttons.push({
    text: "キャンセル",
    style: "cancel",
  });
  Alert.alert(fileName, filePath, buttons);
}

export function normalizeRunnerPath(value: unknown) {
  return String(value || "").trim().replace(/\\/g, "/");
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
