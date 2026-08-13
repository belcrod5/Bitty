import type { LlmSessionSource } from "./useLlmSessionExplorer";

export type PendingPushSessionNavigationControllerArgs = {
  settingsLoaded: boolean;
  normalizedLlmDirectoryForRequest: () => string;
  closeDrawer: () => void;
  openSessionHistoryPopup: (params: {
    sessionId: string;
    source: LlmSessionSource;
    directory?: string;
    origin?: "drawer" | "skia_board";
  }) => Promise<boolean>;
};
