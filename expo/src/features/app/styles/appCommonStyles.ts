import { CHAT_CONTENT_MAX_WIDTH } from "./layoutConstants";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

export function createAppCommonStyles(theme: VisualTheme) {
  return {
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.canvas,
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
}

export const appCommonStylesByTheme = createStylesByTheme(createAppCommonStyles);
