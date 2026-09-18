import type { DirectoryMarkerColor } from "../types/directorySessions";

export const DIRECTORY_MARKER_COLORS = {
  none: null,
  gray: "#94a3b8",
  red: "#dc2626",
  yellow: "#eab308",
  green: "#16a34a",
  black: "#111827",
} as const satisfies Record<DirectoryMarkerColor, string | null>;
