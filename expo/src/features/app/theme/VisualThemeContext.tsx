import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import {
  DEFAULT_VISUAL_THEME_ID,
  VISUAL_THEMES,
  type VisualTheme,
  type VisualThemeId,
} from "./visualThemes";

type VisualThemeContextValue = {
  themeId: VisualThemeId;
  theme: VisualTheme;
  selectTheme: (themeId: VisualThemeId) => void;
};

const VisualThemeContext = createContext<VisualThemeContextValue>({
  themeId: DEFAULT_VISUAL_THEME_ID,
  theme: VISUAL_THEMES[DEFAULT_VISUAL_THEME_ID],
  selectTheme: () => undefined,
});

export function VisualThemeProvider({
  children,
  onSelectTheme,
  themeId,
}: {
  children: ReactNode;
  onSelectTheme: (themeId: VisualThemeId) => void;
  themeId: VisualThemeId;
}) {
  const value = useMemo(() => ({
    themeId,
    theme: VISUAL_THEMES[themeId],
    selectTheme: onSelectTheme,
  }), [onSelectTheme, themeId]);

  return <VisualThemeContext.Provider value={value}>{children}</VisualThemeContext.Provider>;
}

export function useVisualTheme() {
  return useContext(VisualThemeContext);
}
