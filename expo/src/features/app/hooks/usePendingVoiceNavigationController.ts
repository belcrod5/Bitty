import { useEffect, useSyncExternalStore } from "react";
import type { AppScreen } from "../types/appTypes";
import {
  getPendingVoiceOrchestratorId,
  subscribePendingVoiceOrchestratorId,
} from "../utils/pendingVoiceNavigation";

export function usePendingVoiceNavigationController({
  popupMounted,
  requestPopupClose,
  closeDrawer,
  setActiveScreen,
}: {
  popupMounted: boolean;
  requestPopupClose: () => void;
  closeDrawer: () => void;
  setActiveScreen: (screen: AppScreen) => void;
}) {
  const pendingId = useSyncExternalStore(
    subscribePendingVoiceOrchestratorId,
    getPendingVoiceOrchestratorId,
  );
  useEffect(() => {
    if (!pendingId) return;
    closeDrawer();
    if (popupMounted) {
      requestPopupClose();
      return;
    }
    setActiveScreen("skia_board");
  }, [closeDrawer, pendingId, popupMounted, requestPopupClose, setActiveScreen]);

  // The popup stays mounted until its close animation and panel cleanup finish.
  return popupMounted ? "" : pendingId;
}
