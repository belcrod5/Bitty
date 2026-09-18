import { StyleSheet } from "react-native";
import { appLayoutStylesByTheme } from "./styles/appLayoutStyles";
import { settingsControlStylesByTheme } from "./styles/settingsControlStyles";
import { mediaModalStylesByTheme } from "./styles/mediaModalStyles";
import { useVisualTheme } from "./theme/VisualThemeContext";
import type { VisualThemeId } from "./theme/visualThemes";

function createAppStyles(themeId: VisualThemeId) {
  return StyleSheet.create({
    ...appLayoutStylesByTheme[themeId],
    ...settingsControlStylesByTheme[themeId],
    ...mediaModalStylesByTheme[themeId],
  });
}

const standardStyles = createAppStyles("standard");

export const appStylesByTheme: Record<VisualThemeId, typeof standardStyles> = {
  standard: standardStyles,
  highLegibility: createAppStyles("highLegibility"),
};

export function useAppStyles() {
  return appStylesByTheme[useVisualTheme().themeId];
}
