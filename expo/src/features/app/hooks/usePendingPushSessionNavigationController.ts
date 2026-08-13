import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import {
  clearPendingPushSessionTarget,
  getPendingPushSessionTarget,
  subscribePendingPushSessionTarget,
} from "../utils/pushApprovalNotifications";
import type { PendingPushSessionNavigationControllerArgs } from "./usePendingPushSessionNavigationController.contract";

export function usePendingPushSessionNavigationController({
  settingsLoaded,
  normalizedLlmDirectoryForRequest,
  closeDrawer,
  openSessionHistoryPopup,
}: PendingPushSessionNavigationControllerArgs) {
  const navigationInFlightRef = useRef(false);
  const navigatePendingRef = useRef<() => void>(() => {});

  const navigatePending = useCallback(() => {
    if (!settingsLoaded || AppState.currentState !== "active" || navigationInFlightRef.current) return;
    const target = getPendingPushSessionTarget();
    if (!target) return;
    navigationInFlightRef.current = true;
    closeDrawer();
    void openSessionHistoryPopup({
      sessionId: target.sessionId,
      source: "notification",
      directory: target.directory || normalizedLlmDirectoryForRequest(),
      origin: "drawer",
    }).then((opened) => {
      if (opened) clearPendingPushSessionTarget(target);
    }).catch(() => {
      // Keep the intent so a later foreground transition can retry it.
    }).finally(() => {
      navigationInFlightRef.current = false;
      const current = getPendingPushSessionTarget();
      if (current && current.sequence !== target.sequence) navigatePendingRef.current();
    });
  }, [closeDrawer, normalizedLlmDirectoryForRequest, openSessionHistoryPopup, settingsLoaded]);
  navigatePendingRef.current = navigatePending;

  useEffect(() => {
    navigatePending();
  }, [navigatePending]);

  useEffect(() => subscribePendingPushSessionTarget(() => {
    navigatePendingRef.current();
  }), []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") navigatePendingRef.current();
    });
    return () => subscription.remove();
  }, []);
}
