import { DIRECTORY_MARKER_COLORS } from "../theme/directoryMarkerColors";
import { parseDirectoryMarkerColor } from "./directorySessions";

test("uses one palette for directory and session markers", () => {
  expect(DIRECTORY_MARKER_COLORS).toEqual({
    none: null,
    gray: "#94a3b8",
    red: "#dc2626",
    yellow: "#eab308",
    green: "#16a34a",
    black: "#111827",
  });
});

test("normalizes supported marker colors and rejects unknown values", () => {
  expect(parseDirectoryMarkerColor(" RED ")).toBe("red");
  expect(parseDirectoryMarkerColor("blue")).toBe("none");
  expect(parseDirectoryMarkerColor(null)).toBe("none");
});
