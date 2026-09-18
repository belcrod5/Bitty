import { StyleSheet } from "react-native";
import { appLayoutStylesByTheme } from "./styles/appLayoutStyles";
import { settingsControlStylesByTheme } from "./styles/settingsControlStyles";
import { mediaModalStylesByTheme } from "./styles/mediaModalStyles";
import { useVisualTheme } from "./theme/VisualThemeContext";
import { createStylesByTheme, type VisualThemeId } from "./theme/visualThemes";

function createAppStyles(themeId: VisualThemeId) {
  return StyleSheet.create({
    ...appLayoutStylesByTheme[themeId],
    ...settingsControlStylesByTheme[themeId],
    ...mediaModalStylesByTheme[themeId],
  });
}

export const appStylesByTheme = createStylesByTheme((theme) => createAppStyles(theme.id));

export function useAppStyles() {
  return appStylesByTheme[useVisualTheme().themeId];
}
