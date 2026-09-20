import { StyleSheet } from "react-native";

import {
  DEFAULT_VISUAL_THEME_ID,
  VISUAL_THEMES,
  VISUAL_THEME_OPTIONS,
  createStylesByTheme,
  parseVisualThemeId,
} from "./visualThemes";

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(first: string, second: string) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
    .sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

test("parses supported theme ids and falls back to standard", () => {
  expect(parseVisualThemeId("standard")).toBe("standard");
  expect(parseVisualThemeId("cyberpunk")).toBe("cyberpunk");
  expect(parseVisualThemeId("highLegibility")).toBe(DEFAULT_VISUAL_THEME_ID);
  expect(parseVisualThemeId("dark")).toBe(DEFAULT_VISUAL_THEME_ID);
  expect(parseVisualThemeId("constructor")).toBe(DEFAULT_VISUAL_THEME_ID);
  expect(parseVisualThemeId("toString")).toBe(DEFAULT_VISUAL_THEME_ID);
  expect(parseVisualThemeId(null)).toBe(DEFAULT_VISUAL_THEME_ID);
});

test("exposes both selectable themes from the same definitions", () => {
  expect(VISUAL_THEME_OPTIONS).toEqual([
    {
      id: "standard",
      label: VISUAL_THEMES.standard.label,
      description: VISUAL_THEMES.standard.description,
    },
    {
      id: "cyberpunk",
      label: VISUAL_THEMES.cyberpunk.label,
      description: VISUAL_THEMES.cyberpunk.description,
    },
  ]);
});

test("declares the native color scheme for each visual theme", () => {
  expect(VISUAL_THEMES.standard.colorScheme).toBe("light");
  expect(VISUAL_THEMES.cyberpunk.colorScheme).toBe("dark");
});

test("defines splash motion and the two popup sounds without changing the standard popup timing", () => {
  expect(VISUAL_THEMES.standard.motion).toEqual({
    popupTransition: "soft",
    splash: { durationMs: 620, flashCount: 0, flashOpacity: 1, flashDurationMs: 0 },
    popupOpen: { durationMs: 260 },
    popupClose: { durationMs: 220 },
  });
  expect(Object.keys(VISUAL_THEMES.standard.sounds)).toEqual(["popupOpen", "popupClose"]);
  expect(Object.keys(VISUAL_THEMES.cyberpunk.sounds)).toEqual(["popupOpen", "popupClose"]);
  expect(VISUAL_THEMES.cyberpunk.motion.splash.flashCount).toBeGreaterThan(0);
  expect(VISUAL_THEMES.cyberpunk.motion.popupTransition).toBe("flash-blink");
  expect(VISUAL_THEMES.cyberpunk.motion.splash.flashOpacity).toBeGreaterThanOrEqual(0.7);
});

test("creates every theme's styles from the theme registry", () => {
  const styles = createStylesByTheme((theme) => `${theme.id}:${theme.borders.thin}`);

  expect(styles).toEqual({
    standard: "standard:1",
    cyberpunk: "cyberpunk:1",
  });
});

test("uses crisp dividers for the cyberpunk theme", () => {
  expect(VISUAL_THEMES.standard.borders.divider).toBe(StyleSheet.hairlineWidth);
  expect(VISUAL_THEMES.cyberpunk.borders.divider).toBe(1);
});

test("keeps cyberpunk text and controls above their contrast targets", () => {
  const theme = VISUAL_THEMES.cyberpunk;
  for (const foreground of [
    theme.colors.textPrimary,
    theme.colors.textSecondary,
    theme.colors.textMuted,
    theme.colors.accent,
    theme.colors.primaryAction,
    theme.colors.controlAccent,
  ]) {
    expect(contrastRatio(foreground, theme.colors.surface)).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrastRatio(theme.colors.textOnAccent, theme.colors.primaryAction)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(theme.colors.floatingControlText, theme.colors.floatingControlSurface))
    .toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(theme.colors.border, theme.colors.surface)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(theme.colors.activityActive, theme.colors.surface)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(theme.board.textPrimary, theme.board.cardSurface)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(theme.board.textMuted, theme.board.cardSurface)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(theme.board.cardBorder, theme.board.cardSurface)).toBeGreaterThanOrEqual(3);

  for (const tone of Object.values(theme.tones)) {
    expect(contrastRatio(tone.foreground, tone.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tone.border, tone.background)).toBeGreaterThanOrEqual(3);
  }
});

test("keeps the standard board palette unchanged", () => {
  expect(VISUAL_THEMES.standard.board).toEqual({
    canvas: "#f1f5f9",
    grid: "#e2e8f0",
    cardSurface: "#ffffff",
    cardBorder: "#dbe3ee",
    textPrimary: "#0f172a",
    textMuted: "#64748b",
  });
});
