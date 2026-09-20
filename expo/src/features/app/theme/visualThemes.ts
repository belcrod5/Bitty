import { StyleSheet } from "react-native";

export type VisualThemeId = "standard" | "cyberpunk";

export type VisualThemeTone = {
  foreground: string;
  background: string;
  border: string;
};

export type VisualThemeTransitionEvent = "splash" | "popupOpen" | "popupClose";

export type VisualThemeMotion = {
  durationMs: number;
  flashCount: number;
  flashOpacity: number;
  flashDurationMs: number;
};

export type VisualThemeSound = {
  asset: number;
  volume: number;
};

export type VisualTheme = {
  id: VisualThemeId;
  label: string;
  description: string;
  colorScheme: "light" | "dark";
  motion: Record<VisualThemeTransitionEvent, VisualThemeMotion>;
  sounds: Record<VisualThemeTransitionEvent, VisualThemeSound>;
  colors: {
    canvas: string;
    surface: string;
    surfaceRaised: string;
    surfaceMuted: string;
    surfaceSelected: string;
    surfaceGrouped: string;
    surfaceActionSoft: string;
    surfaceSubtle: string;
    surfaceActionSelected: string;
    groupedControlSurface: string;
    floatingSurface: string;
    skeleton: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    textStrong: string;
    controlTextPrimary: string;
    groupedTextPrimary: string;
    groupedTextMuted: string;
    textSubtle: string;
    formLabel: string;
    textOnAccent: string;
    border: string;
    borderStrong: string;
    borderSubtle: string;
    borderSoft: string;
    borderInfo: string;
    groupedBorder: string;
    groupedDivider: string;
    borderMuted: string;
    borderTranslucent: string;
    primaryActionOutlineSoft: string;
    accent: string;
    accentStrong: string;
    primaryAction: string;
    primaryActionStrong: string;
    primaryActionMuted: string;
    primaryActionSelected: string;
    primaryActionBorder: string;
    controlAccent: string;
    controlDanger: string;
    infoAction: string;
    infoMuted: string;
    infoBorder: string;
    warningText: string;
    successText: string;
    positiveText: string;
    negativeText: string;
    iconSecondary: string;
    iconMuted: string;
    disclosure: string;
    floatingFocus: string;
    focus: string;
    backdrop: string;
    backdropStrong: string;
    controlBackdrop: string;
    controlBackdropStrong: string;
    directoryBackdrop: string;
    panelBackdrop: string;
    restoreOverlay: string;
    searchHighlight: string;
    surfaceTranslucent: string;
    userCodeSurface: string;
    userCodeBlockSurface: string;
    userCodeText: string;
    userCodeBorder: string;
    userMetaBorder: string;
    dangerTextStrong: string;
    warningBorderStrong: string;
    textWarmMuted: string;
    textBodyStrong: string;
    shadow: string;
    mediaScrim: string;
    audioGenerationProgress: string;
    sheetBackdrop: string;
    contextProgress: string;
    activityActive: string;
    floatingControlSurface: string;
    floatingControlText: string;
  };
  typography: {
    micro: { fontSize: number; lineHeight: number };
    caption: { fontSize: number; lineHeight: number };
    captionDense: { fontSize: number; lineHeight: number };
    captionRelaxed: { fontSize: number; lineHeight: number };
    small: { fontSize: number; lineHeight: number };
    compact: { fontSize: number; lineHeight: number };
    compactRelaxed: { fontSize: number; lineHeight: number };
    body: { fontSize: number; lineHeight: number };
    bodyRelaxed: { fontSize: number; lineHeight: number };
    input: { fontSize: number; lineHeight: number };
    inputDense: { fontSize: number; lineHeight: number };
    control: { fontSize: number; lineHeight: number };
    subtitle: { fontSize: number; lineHeight: number };
    subtitleDense: { fontSize: number; lineHeight: number };
    label: { fontSize: number; lineHeight: number };
    title: { fontSize: number; lineHeight: number };
    sectionTitle: { fontSize: number; lineHeight: number };
    headline: { fontSize: number; lineHeight: number };
    display: { fontSize: number; lineHeight: number };
    displayLarge: { fontSize: number; lineHeight: number };
    hero: { fontSize: number; lineHeight: number };
  };
  borders: {
    divider: number;
    thin: number;
    strong: number;
    focus: number;
  };
  controls: {
    compactSize: number;
  };
  tones: {
    neutral: VisualThemeTone;
    info: VisualThemeTone;
    progress: VisualThemeTone;
    success: VisualThemeTone;
    warning: VisualThemeTone;
    danger: VisualThemeTone;
  };
  dark: {
    canvas: string;
    surface: string;
    surfaceRaised: string;
    surfaceSelected: string;
    text: string;
    textMuted: string;
    border: string;
    accent: string;
    danger: string;
    dangerOverlay: string;
  };
  board: {
    canvas: string;
    grid: string;
    cardSurface: string;
    cardBorder: string;
    textPrimary: string;
    textMuted: string;
  };
  approval: {
    surface: string;
    text: string;
    textMuted: string;
    textSoft: string;
    commandSurface: string;
    divider: string;
    buttonSurface: string;
    action: string;
    danger: string;
    backdrop: string;
    shadow: string;
    borderWidth: number;
  };
};

export type VisualThemeToneId = keyof VisualTheme["tones"];

export const DEFAULT_VISUAL_THEME_ID: VisualThemeId = "standard";

const standardTheme: VisualTheme = {
  id: "standard",
  label: "標準",
  description: "現在の表示に近い配色と文字サイズ",
  colorScheme: "light",
  motion: {
    splash: { durationMs: 620, flashCount: 0, flashOpacity: 1, flashDurationMs: 0 },
    popupOpen: { durationMs: 260, flashCount: 0, flashOpacity: 1, flashDurationMs: 0 },
    popupClose: { durationMs: 220, flashCount: 0, flashOpacity: 1, flashDurationMs: 0 },
  },
  sounds: {
    splash: {
      asset: require("../../../../assets/themes/standard/sfx/splash.wav"),
      volume: 0.3,
    },
    popupOpen: {
      asset: require("../../../../assets/themes/standard/sfx/popup-open.wav"),
      volume: 0.28,
    },
    popupClose: {
      asset: require("../../../../assets/themes/standard/sfx/popup-close.wav"),
      volume: 0.26,
    },
  },
  colors: {
    canvas: "#ffffff",
    surface: "#ffffff",
    surfaceRaised: "#f8fafc",
    surfaceMuted: "#f1f5f9",
    surfaceSelected: "#eff6ff",
    surfaceGrouped: "#f2f2f7",
    surfaceActionSoft: "#f0fdfa",
    surfaceSubtle: "#e2e8f0",
    surfaceActionSelected: "#ecfeff",
    groupedControlSurface: "#f7f7f9",
    floatingSurface: "rgba(255, 255, 255, 0.97)",
    skeleton: "#e5e7eb",
    textPrimary: "#0f172a",
    textSecondary: "#334155",
    textMuted: "#64748b",
    textStrong: "#1e293b",
    controlTextPrimary: "#111827",
    groupedTextPrimary: "#111111",
    groupedTextMuted: "#8e8e93",
    textSubtle: "#6b7280",
    formLabel: "#374151",
    textOnAccent: "#ffffff",
    border: "#cbd5e1",
    borderStrong: "#94a3b8",
    borderSubtle: "#e2e8f0",
    borderSoft: "#e5e7eb",
    borderInfo: "#dbeafe",
    groupedBorder: "#d1d1d6",
    groupedDivider: "#e5e5ea",
    borderMuted: "#dbe3ee",
    borderTranslucent: "rgba(15, 23, 42, 0.12)",
    primaryActionOutlineSoft: "rgba(15, 118, 110, 0.22)",
    accent: "#2563eb",
    accentStrong: "#1d4ed8",
    primaryAction: "#0f766e",
    primaryActionStrong: "#115e59",
    primaryActionMuted: "#ccfbf1",
    primaryActionSelected: "#ecfeff",
    primaryActionBorder: "#99f6e4",
    controlAccent: "#0a84ff",
    controlDanger: "#ff3b30",
    infoAction: "#1e40af",
    infoMuted: "#dbeafe",
    infoBorder: "#bfdbfe",
    warningText: "#b45309",
    successText: "#15803d",
    positiveText: "#16a34a",
    negativeText: "#dc2626",
    iconSecondary: "#4b5563",
    iconMuted: "#9ca3af",
    disclosure: "#c7c7cc",
    floatingFocus: "#60a5fa",
    focus: "#2563eb",
    backdrop: "rgba(15, 23, 42, 0.28)",
    backdropStrong: "rgba(15, 23, 42, 0.45)",
    controlBackdrop: "rgba(0, 0, 0, 0.32)",
    controlBackdropStrong: "rgba(17, 24, 39, 0.45)",
    directoryBackdrop: "rgba(15, 23, 42, 0.42)",
    panelBackdrop: "rgba(2, 6, 23, 0.28)",
    restoreOverlay: "rgba(248, 250, 252, 0.56)",
    searchHighlight: "#fef9c3",
    surfaceTranslucent: "rgba(255, 255, 255, 0.88)",
    userCodeSurface: "rgba(15, 23, 42, 0.28)",
    userCodeBlockSurface: "rgba(15, 23, 42, 0.24)",
    userCodeText: "#e2e8f0",
    userCodeBorder: "rgba(226, 232, 240, 0.4)",
    userMetaBorder: "rgba(226, 232, 240, 0.26)",
    dangerTextStrong: "#991b1b",
    warningBorderStrong: "#ea580c",
    textWarmMuted: "#8b8b84",
    textBodyStrong: "#1f2937",
    shadow: "#000000",
    mediaScrim: "rgba(15, 23, 42, 0.92)",
    audioGenerationProgress: "#0ea5e9",
    sheetBackdrop: "rgba(15, 23, 42, 0.36)",
    contextProgress: "#0284c7",
    activityActive: "#f97316",
    floatingControlSurface: "#e8eef6",
    floatingControlText: "#27364b",
  },
  typography: {
    micro: { fontSize: 10, lineHeight: 13 },
    caption: { fontSize: 11, lineHeight: 14 },
    captionDense: { fontSize: 11, lineHeight: 15 },
    captionRelaxed: { fontSize: 11, lineHeight: 16 },
    small: { fontSize: 12, lineHeight: 17 },
    compact: { fontSize: 13, lineHeight: 18 },
    compactRelaxed: { fontSize: 13, lineHeight: 19 },
    body: { fontSize: 14, lineHeight: 20 },
    bodyRelaxed: { fontSize: 14, lineHeight: 22 },
    input: { fontSize: 15, lineHeight: 21 },
    inputDense: { fontSize: 15, lineHeight: 20 },
    control: { fontSize: 16, lineHeight: 22 },
    subtitle: { fontSize: 17, lineHeight: 23 },
    subtitleDense: { fontSize: 17, lineHeight: 22 },
    label: { fontSize: 14, lineHeight: 20 },
    title: { fontSize: 18, lineHeight: 24 },
    sectionTitle: { fontSize: 20, lineHeight: 26 },
    headline: { fontSize: 22, lineHeight: 28 },
    display: { fontSize: 24, lineHeight: 30 },
    displayLarge: { fontSize: 28, lineHeight: 34 },
    hero: { fontSize: 32, lineHeight: 38 },
  },
  borders: {
    divider: StyleSheet.hairlineWidth,
    thin: 1,
    strong: 2,
    focus: 2,
  },
  controls: {
    compactSize: 36,
  },
  tones: {
    neutral: { foreground: "#475569", background: "#f8fafc", border: "#d1d5db" },
    info: { foreground: "#1d4ed8", background: "#eff6ff", border: "#93c5fd" },
    progress: { foreground: "#4338ca", background: "#eef2ff", border: "#a5b4fc" },
    success: { foreground: "#166534", background: "#ecfdf5", border: "#86efac" },
    warning: { foreground: "#c2410c", background: "#fff7ed", border: "#fdba74" },
    danger: { foreground: "#b91c1c", background: "#fef2f2", border: "#fca5a5" },
  },
  dark: {
    canvas: "#020617",
    surface: "#0f172a",
    surfaceRaised: "#111827",
    surfaceSelected: "#1e293b",
    text: "#f8fafc",
    textMuted: "#94a3b8",
    border: "#334155",
    accent: "#38bdf8",
    danger: "#fecaca",
    dangerOverlay: "rgba(127, 29, 29, 0.92)",
  },
  board: {
    canvas: "#f1f5f9",
    grid: "#e2e8f0",
    cardSurface: "#ffffff",
    cardBorder: "#dbe3ee",
    textPrimary: "#0f172a",
    textMuted: "#64748b",
  },
  approval: {
    surface: "rgba(242, 242, 247, 0.96)",
    text: "#000000",
    textMuted: "rgba(60, 60, 67, 0.62)",
    textSoft: "rgba(0, 0, 0, 0.78)",
    commandSurface: "rgba(118, 118, 128, 0.12)",
    divider: "rgba(60, 60, 67, 0.24)",
    buttonSurface: "rgba(255, 255, 255, 0.18)",
    action: "#007aff",
    danger: "#ff3b30",
    backdrop: "rgba(0, 0, 0, 0.28)",
    shadow: "#000000",
    borderWidth: 0,
  },
};

const cyberpunkTheme: VisualTheme = {
  id: "cyberpunk",
  label: "cyberpunk",
  description: "暗色とネオンカラーの未来的な表示",
  colorScheme: "dark",
  motion: {
    splash: { durationMs: 720, flashCount: 2, flashOpacity: 0.7, flashDurationMs: 62 },
    popupOpen: { durationMs: 260, flashCount: 2, flashOpacity: 0.72, flashDurationMs: 48 },
    popupClose: { durationMs: 220, flashCount: 1, flashOpacity: 0.76, flashDurationMs: 54 },
  },
  sounds: {
    splash: {
      asset: require("../../../../assets/themes/cyberpunk/sfx/splash.wav"),
      volume: 0.28,
    },
    popupOpen: {
      asset: require("../../../../assets/themes/cyberpunk/sfx/popup-open.wav"),
      volume: 0.26,
    },
    popupClose: {
      asset: require("../../../../assets/themes/cyberpunk/sfx/popup-close.wav"),
      volume: 0.24,
    },
  },
  colors: {
    canvas: "#05080d",
    surface: "#0a1018",
    surfaceRaised: "#14232e",
    surfaceMuted: "#141f2b",
    surfaceSelected: "#192a35",
    surfaceGrouped: "#080d13",
    surfaceActionSoft: "#102b2f",
    surfaceSubtle: "#1b2a36",
    surfaceActionSelected: "#123942",
    groupedControlSurface: "#111a23",
    floatingSurface: "rgba(10, 16, 24, 0.97)",
    skeleton: "#263745",
    textPrimary: "#f2f7f7",
    textSecondary: "#c5d4d6",
    textMuted: "#8fa5a8",
    textStrong: "#ffffff",
    controlTextPrimary: "#f2f7f7",
    groupedTextPrimary: "#f2f7f7",
    groupedTextMuted: "#8fa5a8",
    textSubtle: "#8fa5a8",
    formLabel: "#c5d4d6",
    textOnAccent: "#031014",
    border: "#2f7780",
    borderStrong: "#00e5ff",
    borderSubtle: "#254953",
    borderSoft: "#1d3842",
    borderInfo: "#00b8cc",
    groupedBorder: "#2f7780",
    groupedDivider: "#254953",
    borderMuted: "#2c4e58",
    borderTranslucent: "rgba(0, 229, 255, 0.25)",
    primaryActionOutlineSoft: "rgba(0, 229, 255, 0.45)",
    accent: "#00e5ff",
    accentStrong: "#4df4ff",
    primaryAction: "#00e5ff",
    primaryActionStrong: "#4df4ff",
    primaryActionMuted: "#123942",
    primaryActionSelected: "#174a55",
    primaryActionBorder: "#00b8cc",
    controlAccent: "#00e5ff",
    controlDanger: "#ff3b5c",
    infoAction: "#00e5ff",
    infoMuted: "#11313a",
    infoBorder: "#00b8cc",
    warningText: "#fcee0a",
    successText: "#5af78e",
    positiveText: "#5af78e",
    negativeText: "#ff6680",
    iconSecondary: "#c5d4d6",
    iconMuted: "#6f8589",
    disclosure: "#00b8cc",
    floatingFocus: "#4df4ff",
    focus: "#00e5ff",
    backdrop: "rgba(0, 2, 6, 0.66)",
    backdropStrong: "rgba(0, 2, 6, 0.82)",
    controlBackdrop: "rgba(0, 2, 6, 0.72)",
    controlBackdropStrong: "rgba(0, 2, 6, 0.86)",
    directoryBackdrop: "rgba(0, 2, 6, 0.78)",
    panelBackdrop: "rgba(0, 2, 6, 0.7)",
    restoreOverlay: "rgba(5, 8, 13, 0.76)",
    searchHighlight: "#514d00",
    surfaceTranslucent: "rgba(10, 16, 24, 0.9)",
    userCodeSurface: "#101f2a",
    userCodeBlockSurface: "#071018",
    userCodeText: "#dffcff",
    userCodeBorder: "#2f7780",
    userMetaBorder: "rgba(0, 229, 255, 0.38)",
    dangerTextStrong: "#ff8aa0",
    warningBorderStrong: "#fcee0a",
    textWarmMuted: "#b7a9a9",
    textBodyStrong: "#f2f7f7",
    shadow: "#000000",
    mediaScrim: "rgba(0, 2, 6, 0.96)",
    audioGenerationProgress: "#00e5ff",
    sheetBackdrop: "rgba(0, 2, 6, 0.76)",
    contextProgress: "#00e5ff",
    activityActive: "#ff3b5c",
    floatingControlSurface: "#00e5ff",
    floatingControlText: "#031014",
  },
  typography: {
    micro: { fontSize: 10, lineHeight: 13 },
    caption: { fontSize: 11, lineHeight: 14 },
    captionDense: { fontSize: 11, lineHeight: 15 },
    captionRelaxed: { fontSize: 11, lineHeight: 16 },
    small: { fontSize: 12, lineHeight: 17 },
    compact: { fontSize: 13, lineHeight: 18 },
    compactRelaxed: { fontSize: 13, lineHeight: 19 },
    body: { fontSize: 14, lineHeight: 20 },
    bodyRelaxed: { fontSize: 14, lineHeight: 22 },
    input: { fontSize: 15, lineHeight: 21 },
    inputDense: { fontSize: 15, lineHeight: 20 },
    control: { fontSize: 16, lineHeight: 22 },
    subtitle: { fontSize: 17, lineHeight: 23 },
    subtitleDense: { fontSize: 17, lineHeight: 22 },
    label: { fontSize: 14, lineHeight: 20 },
    title: { fontSize: 18, lineHeight: 24 },
    sectionTitle: { fontSize: 20, lineHeight: 26 },
    headline: { fontSize: 22, lineHeight: 28 },
    display: { fontSize: 24, lineHeight: 30 },
    displayLarge: { fontSize: 28, lineHeight: 34 },
    hero: { fontSize: 32, lineHeight: 38 },
  },
  borders: {
    divider: 1,
    thin: 1,
    strong: 2,
    focus: 2,
  },
  controls: {
    compactSize: 36,
  },
  tones: {
    neutral: { foreground: "#c5d4d6", background: "#111a23", border: "#5b7278" },
    info: { foreground: "#4df4ff", background: "#0c2c35", border: "#00b8cc" },
    progress: { foreground: "#d2c3ff", background: "#20183c", border: "#a875ff" },
    success: { foreground: "#79ffa8", background: "#102b1a", border: "#35d06f" },
    warning: { foreground: "#fcee0a", background: "#332f00", border: "#c9bd00" },
    danger: { foreground: "#ff8aa0", background: "#350d18", border: "#ff3b5c" },
  },
  dark: {
    canvas: "#020409",
    surface: "#070d14",
    surfaceRaised: "#0d1721",
    surfaceSelected: "#15313b",
    text: "#f2f7f7",
    textMuted: "#8fa5a8",
    border: "#2f7780",
    accent: "#00e5ff",
    danger: "#ff8aa0",
    dangerOverlay: "rgba(91, 8, 28, 0.96)",
  },
  board: {
    canvas: "#05080d",
    grid: "#1d3842",
    cardSurface: "#182a36",
    cardBorder: "#00b8cc",
    textPrimary: "#f2f7f7",
    textMuted: "#9dc8cc",
  },
  approval: {
    surface: "#0a1018",
    text: "#f2f7f7",
    textMuted: "#8fa5a8",
    textSoft: "#c5d4d6",
    commandSurface: "#101923",
    divider: "#2f7780",
    buttonSurface: "#111a23",
    action: "#00e5ff",
    danger: "#ff6680",
    backdrop: "rgba(0, 2, 6, 0.76)",
    shadow: "#000000",
    borderWidth: 1,
  },
};

export const VISUAL_THEMES: Record<VisualThemeId, VisualTheme> = {
  standard: standardTheme,
  cyberpunk: cyberpunkTheme,
};

export const VISUAL_THEME_OPTIONS = Object.values(VISUAL_THEMES).map((theme) => ({
  id: theme.id,
  label: theme.label,
  description: theme.description,
}));

export function createStylesByTheme<T>(factory: (theme: VisualTheme) => T): Record<VisualThemeId, T> {
  return Object.fromEntries(
    Object.values(VISUAL_THEMES).map((theme) => [theme.id, factory(theme)])
  ) as Record<VisualThemeId, T>;
}

export function parseVisualThemeId(raw: unknown): VisualThemeId {
  return typeof raw === "string" && Object.prototype.hasOwnProperty.call(VISUAL_THEMES, raw)
    ? raw as VisualThemeId
    : DEFAULT_VISUAL_THEME_ID;
}
