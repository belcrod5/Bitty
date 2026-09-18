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
  expect(parseVisualThemeId("highLegibility")).toBe("highLegibility");
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
      id: "highLegibility",
      label: VISUAL_THEMES.highLegibility.label,
      description: VISUAL_THEMES.highLegibility.description,
    },
  ]);
});

test("creates every theme's styles from the theme registry", () => {
  const styles = createStylesByTheme((theme) => `${theme.id}:${theme.borders.thin}`);

  expect(styles).toEqual({
    standard: "standard:1",
    highLegibility: "highLegibility:2",
  });
});

test("preserves hairline dividers in standard and strengthens them for high legibility", () => {
  expect(VISUAL_THEMES.standard.borders.divider).toBe(StyleSheet.hairlineWidth);
  expect(VISUAL_THEMES.highLegibility.borders.divider).toBe(2);
});

test("keeps high-legibility text and controls above their contrast targets", () => {
  const theme = VISUAL_THEMES.highLegibility;
  for (const foreground of [
    theme.colors.textPrimary,
    theme.colors.textSecondary,
    theme.colors.textMuted,
    theme.colors.accent,
    theme.colors.primaryAction,
    theme.colors.controlAccent,
    theme.colors.floatingControlText,
  ]) {
    expect(contrastRatio(foreground, theme.colors.surface)).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrastRatio(theme.colors.border, theme.colors.surface)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(theme.colors.activityActive, theme.colors.surface)).toBeGreaterThanOrEqual(3);

  for (const tone of Object.values(theme.tones)) {
    expect(contrastRatio(tone.foreground, tone.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tone.border, tone.background)).toBeGreaterThanOrEqual(3);
  }
});
