import { audioControlStylesByTheme } from "./audioControlStyles";
import { menuScreenStylesByTheme } from "./menuScreenStyles";
import { settingsScreenStylesByTheme } from "./settingsScreenStyles";
import { VISUAL_THEMES, type VisualTheme, type VisualThemeId } from "../theme/visualThemes";

export function createSettingsControlStyles(theme: VisualTheme) {
  return {
  ...menuScreenStylesByTheme[theme.id],
  ...audioControlStylesByTheme[theme.id],
  ...settingsScreenStylesByTheme[theme.id],
  errorText: {
    color: theme.tones.danger.foreground,
    fontSize: theme.typography.compact.fontSize,
    fontWeight: "600",
  },
  label: {
    marginTop: 6,
    color: theme.colors.formLabel,
    fontSize: theme.typography.compact.fontSize,
    fontWeight: "700",
  },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.groupedBorder,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.colors.controlTextPrimary,
    fontSize: theme.typography.input.fontSize,
  },
  row: {
    marginTop: 4,
    flexDirection: "row",
    gap: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  hint: {
    marginTop: 2,
    color: theme.colors.textSubtle,
    ...theme.typography.small,
  },
  switchRow: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.borderSubtle,
    borderRadius: 10,
    backgroundColor: theme.colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  } as const;
}

export const settingsControlStylesByTheme: Record<VisualThemeId, ReturnType<typeof createSettingsControlStyles>> = {
  standard: createSettingsControlStyles(VISUAL_THEMES.standard),
  highLegibility: createSettingsControlStyles(VISUAL_THEMES.highLegibility),
};
