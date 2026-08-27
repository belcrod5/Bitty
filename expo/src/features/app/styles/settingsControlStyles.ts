import { audioControlStyles } from "./audioControlStyles";
import { menuScreenStyles } from "./menuScreenStyles";
import { settingsScreenStyles } from "./settingsScreenStyles";

export const settingsControlStyles = {
  ...menuScreenStyles,
  ...audioControlStyles,
  ...settingsScreenStyles,
  errorText: {
    color: "#b91c1c",
    fontSize: 13,
    fontWeight: "600",
  },
  label: {
    marginTop: 6,
    color: "#374151",
    fontSize: 13,
    fontWeight: "700",
  },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#d1d5db",
    backgroundColor: "#ffffff",
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#111827",
    fontSize: 15,
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
    color: "#6b7280",
    fontSize: 12,
    lineHeight: 17,
  },
  switchRow: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 10,
    backgroundColor: "#f8fafc",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
} as const;
