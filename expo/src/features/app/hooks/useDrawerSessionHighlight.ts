import { useCallback, useEffect, useState } from "react";

// ドロワーのセッション一覧のハイライトは「最後に開いたセッション」を指す。
// メインチャットの選択(selectedLlmSessionId)とドロワーポップアップで開くセッションは
// 別系統のため、ポップアップで開いたセッションをここで上書きとして保持し、
// メインチャットの選択が変わったら上書きを解除して選択中セッションへ戻す。
export function useDrawerSessionHighlight(selectedLlmSessionId: string) {
  const [popupSessionId, setPopupSessionId] = useState("");
  useEffect(() => {
    setPopupSessionId("");
  }, [selectedLlmSessionId]);
  const setDrawerPopupHighlightSessionId = useCallback((sessionIdRaw: string) => {
    setPopupSessionId(String(sessionIdRaw || "").trim());
  }, []);
  return {
    drawerHighlightedSessionId: popupSessionId || String(selectedLlmSessionId || "").trim(),
    setDrawerPopupHighlightSessionId,
  };
}
