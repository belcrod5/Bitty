import { CHAT_CONTENT_MAX_WIDTH } from "./layoutConstants";

export const appCommonStyles = {
  safeArea: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  keyboardAvoiding: {
    flex: 1,
  },
  container: {
    padding: 16,
    gap: 8,
  },
  chatContentWidth: {
    width: "100%",
    maxWidth: CHAT_CONTENT_MAX_WIDTH,
    alignSelf: "center",
  },
} as const;
