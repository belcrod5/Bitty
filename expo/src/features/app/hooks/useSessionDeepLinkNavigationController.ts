import { useCallback, useEffect, useRef } from "react";
import { Linking } from "react-native";
import type { ConversationMessage } from "../types/appTypes";
import { codexItemMessageId } from "../utils/codexItemMessageId";
import {
  parseSessionDeepLink,
  type SessionDeepLinkJumpTarget,
} from "../utils/sessionDeepLink";
import type { SessionHistoryLoadOlderResult } from "./useSessionHistoryPagingController";

const MAX_DEEP_LINK_HISTORY_PAGES = 20;

type OpenSession = (params: {
  backendId: string;
  sessionId: string;
  directory: string;
  source: "all";
  origin: "drawer";
}) => Promise<boolean>;

export function useSessionDeepLinkNavigationController(options: {
  settingsLoaded: boolean;
  openSession: OpenSession;
  closeDrawer: () => void;
  loadOlder: (params: {
    backendId: string;
    sessionId: string;
    directory: string;
    retry?: boolean;
  }) => Promise<SessionHistoryLoadOlderResult | undefined>;
  getMessages: (sessionId: string) => ConversationMessage[];
  setJumpTarget: (target: SessionDeepLinkJumpTarget) => void;
  onNotFound: () => void;
}) {
  const {
    settingsLoaded,
    openSession,
    closeDrawer,
    loadOlder,
    getMessages,
    setJumpTarget,
    onNotFound,
  } = options;
  const pendingUrlRef = useRef("");
  const navigationInFlightRef = useRef(false);
  const initialUrlReadRef = useRef(false);
  const requestIdRef = useRef(0);
  const navigatePendingRef = useRef<() => void>(() => {});

  const navigatePending = useCallback(() => {
    if (!settingsLoaded || navigationInFlightRef.current) return;
    const target = parseSessionDeepLink(pendingUrlRef.current);
    if (!target) {
      pendingUrlRef.current = "";
      return;
    }
    pendingUrlRef.current = "";
    navigationInFlightRef.current = true;
    closeDrawer();
    void (async () => {
      const opened = await openSession({
        backendId: target.backendId,
        sessionId: target.sessionId,
        directory: target.cwd,
        source: "all",
        origin: "drawer",
      });
      if (!opened) return;
      const displayMessageId = codexItemMessageId(target.sessionId, target.messageId);
      let found = getMessages(target.sessionId).some((message) => message.id === displayMessageId);
      for (let page = 0; !found && page < MAX_DEEP_LINK_HISTORY_PAGES; page += 1) {
        const result = await loadOlder({
          backendId: target.backendId,
          sessionId: target.sessionId,
          directory: target.cwd,
          retry: true,
        });
        if (!result?.loaded) break;
        found = getMessages(target.sessionId).some((message) => message.id === displayMessageId);
        if (!result.hasMore) break;
      }
      if (!found) {
        onNotFound();
        return;
      }
      setJumpTarget({
        requestId: ++requestIdRef.current,
        sessionId: target.sessionId,
        messageId: displayMessageId,
      });
    })().finally(() => {
      navigationInFlightRef.current = false;
      if (pendingUrlRef.current) navigatePendingRef.current();
    });
  }, [closeDrawer, getMessages, loadOlder, onNotFound, openSession, setJumpTarget, settingsLoaded]);
  navigatePendingRef.current = navigatePending;

  useEffect(() => {
    if (initialUrlReadRef.current) return;
    initialUrlReadRef.current = true;
    void Linking.getInitialURL().then((url) => {
      if (!url || !parseSessionDeepLink(url)) return;
      pendingUrlRef.current = url;
      navigatePendingRef.current();
    });
  }, []);

  useEffect(() => Linking.addEventListener("url", ({ url }) => {
    if (!parseSessionDeepLink(url)) return;
    pendingUrlRef.current = url;
    navigatePendingRef.current();
  }).remove, []);

  useEffect(() => {
    navigatePending();
  }, [navigatePending]);
}
