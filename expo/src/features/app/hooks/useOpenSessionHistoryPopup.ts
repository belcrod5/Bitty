import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { PopupChatSourceRect, SessionPopupOrigin } from "../components/popupChatTypes";
import type { SessionHistoryContext } from "../utils/sessionHistoryContext";
import { parseOptionalSessionId, type LlmSessionSource } from "../utils/llmSession";
import { parseLlmDirectory } from "../utils/settingsParsers";

export type OpenSessionHistoryPopupParams = {
  backendId?: string;
  sessionId: string;
  source: LlmSessionSource;
  directory?: string;
  sourceRect?: PopupChatSourceRect;
  origin?: SessionPopupOrigin;
};

export function useOpenSessionHistoryPopup(options: {
  panelId: string;
  resolveContext: (sessionId: string, backendId?: string) => SessionHistoryContext | null;
  hydrate: (params: {
    panelId: string;
    backendId: string;
    sessionId: string;
    directory: string;
    source: LlmSessionSource;
    directoryDisplayName?: string;
    diagnosticCycleId: string;
    title?: string;
    updatedAt?: string;
    modelRef?: string;
    reasoningEffort?: string;
    contextUsedPct?: number | null;
  }) => Promise<"applied" | "failed" | "superseded">;
  markRead: (sessionId: string, source: LlmSessionSource, directory: string, backendId: string) => void;
  clearPanel: (panelId: string) => void;
  setPanelId: Dispatch<SetStateAction<string>>;
  setCycleId: Dispatch<SetStateAction<string>>;
  setSourceRect: Dispatch<SetStateAction<PopupChatSourceRect | null>>;
  setOrigin: Dispatch<SetStateAction<SessionPopupOrigin>>;
  setHighlight: (sessionId: string) => void;
  showToast: (role: "assistant", message: string) => void;
  log: (event: string, payload: Record<string, unknown>, options: { throttleMs: number }) => void;
}) {
  const {
    panelId,
    resolveContext,
    hydrate,
    markRead,
    clearPanel,
    setPanelId,
    setCycleId,
    setSourceRect,
    setOrigin,
    setHighlight,
    showToast,
    log,
  } = options;
  return useCallback(async (params: OpenSessionHistoryPopupParams) => {
    const sessionId = parseOptionalSessionId(params.sessionId);
    if (!sessionId) {
      showToast("assistant", "セッションIDが不明なため開けませんでした。");
      return false;
    }
    const context = resolveContext(sessionId, params.backendId);
    const backendId = String(params.backendId || context?.backendId || "codex").trim() || "codex";
    const directoryRaw = String(params.directory || "").trim();
    const directory = context?.directory || (directoryRaw ? parseLlmDirectory(directoryRaw) : "");
    if (!directory) {
      showToast("assistant", "セッションのディレクトリが不明なため開けませんでした。");
      log("drawer_session_popup_open_skipped_missing_directory", {
        sessionId,
        source: params.source,
      }, { throttleMs: 0 });
      return false;
    }
    const cycleId = `drawer-session-popup-${Date.now().toString(36)}`;
    setSourceRect(params.sourceRect || null);
    setCycleId(cycleId);
    setOrigin(params.origin || "drawer");
    setPanelId(panelId);
    setHighlight(sessionId);
    try {
      const result = await hydrate({
        panelId,
        backendId,
        sessionId,
        directory,
        source: params.source,
        directoryDisplayName: context?.directoryDisplayName,
        diagnosticCycleId: cycleId,
        title: context?.sessionTitle,
        updatedAt: context?.updatedAt,
        modelRef: context?.modelRef,
        reasoningEffort: context?.reasoningEffort,
        contextUsedPct: context?.contextUsedPct,
      });
      if (result === "superseded") return false;
      if (result === "failed") {
        showToast("assistant", "セッションをポップアップに読み込めませんでした。");
        clearPanel(panelId);
        setPanelId("");
        setHighlight("");
        return false;
      }
      markRead(sessionId, params.source, directory, backendId);
      return true;
    } catch (error) {
      showToast("assistant", `セッション読込に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      clearPanel(panelId);
      setPanelId("");
      setHighlight("");
      return false;
    }
  }, [
    clearPanel,
    hydrate,
    log,
    markRead,
    panelId,
    resolveContext,
    setCycleId,
    setHighlight,
    setOrigin,
    setPanelId,
    setSourceRect,
    showToast,
  ]);
}
