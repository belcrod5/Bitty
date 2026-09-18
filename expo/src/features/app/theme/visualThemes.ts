export type VisualThemeId = "standard" | "highLegibility";

export type VisualThemeTone = {
  foreground: string;
  background: string;
  border: string;
};

export type VisualTheme = {
  id: VisualThemeId;
  label: string;
  description: string;
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
    thin: number;
    strong: number;
    focus: number;
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
  };
};

export type VisualThemeToneId = keyof VisualTheme["tones"];

export const DEFAULT_VISUAL_THEME_ID: VisualThemeId = "standard";

const standardTheme: VisualTheme = {
  id: "standard",
  label: "標準",
  description: "現在の表示に近い配色と文字サイズ",
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
    thin: 1,
    strong: 2,
    focus: 2,
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
  },
};

const highLegibilityTheme: VisualTheme = {
  id: "highLegibility",
  label: "高視認性",
  description: "文字と境界を大きく明瞭にした表示",
  colors: {
    canvas: "#ffffff",
    surface: "#ffffff",
    surfaceRaised: "#f8fafc",
    surfaceMuted: "#e2e8f0",
    surfaceSelected: "#dbeafe",
    surfaceGrouped: "#e2e8f0",
    surfaceActionSoft: "#ccfbf1",
    surfaceSubtle: "#cbd5e1",
    surfaceActionSelected: "#ccfbf1",
    groupedControlSurface: "#e2e8f0",
    floatingSurface: "#ffffff",
    skeleton: "#cbd5e1",
    textPrimary: "#020617",
    textSecondary: "#0f172a",
    textMuted: "#334155",
    textStrong: "#0f172a",
    controlTextPrimary: "#020617",
    groupedTextPrimary: "#020617",
    groupedTextMuted: "#334155",
    textSubtle: "#334155",
    formLabel: "#0f172a",
    textOnAccent: "#ffffff",
    border: "#64748b",
    borderStrong: "#334155",
    borderSubtle: "#64748b",
    borderSoft: "#64748b",
    borderInfo: "#2563eb",
    groupedBorder: "#475569",
    groupedDivider: "#64748b",
    borderMuted: "#64748b",
    borderTranslucent: "#64748b",
    primaryActionOutlineSoft: "#0f766e",
    accent: "#1d4ed8",
    accentStrong: "#1e3a8a",
    primaryAction: "#115e59",
    primaryActionStrong: "#134e4a",
    primaryActionMuted: "#99f6e4",
    primaryActionSelected: "#ccfbf1",
    primaryActionBorder: "#0f766e",
    controlAccent: "#005fc7",
    controlDanger: "#b91c1c",
    infoAction: "#1e3a8a",
    infoMuted: "#bfdbfe",
    infoBorder: "#2563eb",
    warningText: "#7c2d12",
    successText: "#14532d",
    positiveText: "#15803d",
    negativeText: "#b91c1c",
    iconSecondary: "#0f172a",
    iconMuted: "#334155",
    disclosure: "#475569",
    floatingFocus: "#7dd3fc",
    focus: "#1d4ed8",
    backdrop: "rgba(2, 6, 23, 0.42)",
    backdropStrong: "rgba(2, 6, 23, 0.6)",
    controlBackdrop: "rgba(2, 6, 23, 0.6)",
    controlBackdropStrong: "rgba(2, 6, 23, 0.6)",
    directoryBackdrop: "rgba(2, 6, 23, 0.6)",
    panelBackdrop: "rgba(2, 6, 23, 0.6)",
    restoreOverlay: "rgba(248, 250, 252, 0.76)",
    searchHighlight: "#fef3c7",
    surfaceTranslucent: "#ffffff",
    userCodeSurface: "#dbeafe",
    userCodeBlockSurface: "#e2e8f0",
    userCodeText: "#020617",
    userCodeBorder: "#64748b",
    userMetaBorder: "#64748b",
    dangerTextStrong: "#7f1d1d",
    warningBorderStrong: "#c2410c",
    textWarmMuted: "#334155",
    textBodyStrong: "#020617",
    shadow: "#000000",
    mediaScrim: "rgba(2, 6, 23, 0.96)",
    audioGenerationProgress: "#0369a1",
    sheetBackdrop: "rgba(2, 6, 23, 0.52)",
    contextProgress: "#075985",
    activityActive: "#c2410c",
    floatingControlSurface: "#e2e8f0",
    floatingControlText: "#0f172a",
  },
  typography: {
    micro: { fontSize: 12, lineHeight: 17 },
    caption: { fontSize: 13, lineHeight: 18 },
    captionDense: { fontSize: 13, lineHeight: 18 },
    captionRelaxed: { fontSize: 13, lineHeight: 19 },
    small: { fontSize: 14, lineHeight: 20 },
    compact: { fontSize: 15, lineHeight: 22 },
    compactRelaxed: { fontSize: 15, lineHeight: 22 },
    body: { fontSize: 16, lineHeight: 23 },
    input: { fontSize: 17, lineHeight: 24 },
    inputDense: { fontSize: 17, lineHeight: 24 },
    control: { fontSize: 18, lineHeight: 25 },
    subtitle: { fontSize: 19, lineHeight: 26 },
    subtitleDense: { fontSize: 19, lineHeight: 26 },
    label: { fontSize: 16, lineHeight: 23 },
    title: { fontSize: 20, lineHeight: 27 },
    sectionTitle: { fontSize: 22, lineHeight: 29 },
    headline: { fontSize: 24, lineHeight: 31 },
    display: { fontSize: 26, lineHeight: 33 },
    displayLarge: { fontSize: 30, lineHeight: 38 },
    hero: { fontSize: 34, lineHeight: 42 },
  },
  borders: {
    thin: 2,
    strong: 3,
    focus: 3,
  },
  tones: {
    neutral: { foreground: "#334155", background: "#f8fafc", border: "#64748b" },
    info: { foreground: "#1e3a8a", background: "#dbeafe", border: "#2563eb" },
    progress: { foreground: "#312e81", background: "#e0e7ff", border: "#4338ca" },
    success: { foreground: "#14532d", background: "#dcfce7", border: "#15803d" },
    warning: { foreground: "#7c2d12", background: "#ffedd5", border: "#c2410c" },
    danger: { foreground: "#7f1d1d", background: "#fee2e2", border: "#b91c1c" },
  },
  dark: {
    canvas: "#000000",
    surface: "#020617",
    surfaceRaised: "#0f172a",
    surfaceSelected: "#334155",
    text: "#ffffff",
    textMuted: "#cbd5e1",
    border: "#94a3b8",
    accent: "#7dd3fc",
    danger: "#fee2e2",
    dangerOverlay: "rgba(127, 29, 29, 0.98)",
  },
  approval: {
    surface: "#ffffff",
    text: "#020617",
    textMuted: "#334155",
    textSoft: "#0f172a",
    commandSurface: "#e2e8f0",
    divider: "#64748b",
    buttonSurface: "#ffffff",
    action: "#005fc7",
    danger: "#b91c1c",
    backdrop: "rgba(2, 6, 23, 0.42)",
    shadow: "#000000",
  },
};

export const VISUAL_THEMES: Record<VisualThemeId, VisualTheme> = {
  standard: standardTheme,
  highLegibility: highLegibilityTheme,
};

export const VISUAL_THEME_OPTIONS = Object.values(VISUAL_THEMES).map((theme) => ({
  id: theme.id,
  label: theme.label,
  description: theme.description,
}));

export function parseVisualThemeId(raw: unknown): VisualThemeId {
  return raw === "highLegibility" || raw === "standard" ? raw : DEFAULT_VISUAL_THEME_ID;
}
