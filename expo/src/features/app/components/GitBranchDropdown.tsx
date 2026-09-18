import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { VISUAL_THEMES, type VisualTheme, type VisualThemeId } from "../theme/visualThemes";

export type GitBranchOption = {
  name: string;
  kind: "local" | "remote";
};

type GitBranchDropdownProps = {
  currentBranchName: string;
  branches: GitBranchOption[];
};

function normalizeBranchName(nameRaw: unknown) {
  return String(nameRaw || "").trim();
}

function normalizeBranches(branchesRaw: GitBranchOption[], currentBranchName: string) {
  const seen = new Set<string>();
  const branches: GitBranchOption[] = [];
  for (const item of branchesRaw) {
    const name = normalizeBranchName(item?.name);
    const kind = item?.kind === "remote" ? "remote" : "local";
    if (!name || (kind === "remote" && /\/HEAD$/.test(name))) continue;
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    branches.push({ name, kind });
  }
  const current = normalizeBranchName(currentBranchName) || "HEAD";
  if (current !== "HEAD" && !seen.has(`local:${current}`)) {
    branches.unshift({ name: current, kind: "local" });
  }
  branches.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "local" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return branches;
}

export function GitBranchDropdown({
  currentBranchName,
  branches,
}: GitBranchDropdownProps) {
  const { theme, themeId } = useVisualTheme();
  const branchStyles = branchStylesByTheme[themeId];
  const current = normalizeBranchName(currentBranchName) || "HEAD";
  const detached = current === "HEAD";
  const [open, setOpen] = useState(false);
  const branchOptions = useMemo(
    () => normalizeBranches(branches, current),
    [branches, current]
  );
  const localBranches = branchOptions.filter((item) => item.kind === "local");
  const remoteBranches = branchOptions.filter((item) => item.kind === "remote");

  const renderOption = (item: GitBranchOption) => {
    const optionKey = `${item.kind}:${item.name}`;
    const optionSelected = !detached && optionKey === `local:${current}`;
    return (
      <TouchableOpacity
        key={optionKey}
        style={[branchStyles.optionRow, optionSelected ? branchStyles.optionRowSelected : null]}
        onPress={() => setOpen(false)}
        accessibilityRole="button"
        accessibilityLabel={`${item.kind === "local" ? "Local" : "Remote"} ${item.name}`}
        accessibilityState={{ selected: optionSelected }}
      >
        <Text style={branchStyles.optionCheck}>{optionSelected ? "✓" : ""}</Text>
        <Text
          style={[branchStyles.optionText, optionSelected ? branchStyles.optionTextSelected : null]}
          numberOfLines={1}
        >
          {item.name}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={branchStyles.card}>
      <Text style={branchStyles.label}>Branch</Text>
      <TouchableOpacity
        style={branchStyles.trigger}
        onPress={() => setOpen((prev) => !prev)}
        accessibilityRole="button"
        accessibilityLabel="ブランチ一覧を開く"
      >
        <Text style={branchStyles.triggerKind}>{detached ? "detached" : "local"}</Text>
        <Text style={branchStyles.triggerText} numberOfLines={1}>
          {current}
        </Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={15} color={theme.colors.textSecondary} />
      </TouchableOpacity>
      {open ? (
        <View style={branchStyles.menu}>
          <ScrollView nestedScrollEnabled style={branchStyles.menuScroll}>
            <Text style={branchStyles.groupLabel}>Local</Text>
            {localBranches.map(renderOption)}
            <Text style={branchStyles.groupLabel}>Remote</Text>
            {remoteBranches.length > 0 ? (
              remoteBranches.map(renderOption)
            ) : (
              <Text style={branchStyles.emptyText}>リモートブランチはありません</Text>
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function createGitBranchStyles(theme: VisualTheme) {
  return StyleSheet.create({
  card: {
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.borderSubtle,
    borderRadius: 8,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
  },
  label: {
    fontSize: theme.typography.small.fontSize,
    fontWeight: "700",
    color: theme.colors.textPrimary,
  },
  trigger: {
    minHeight: 34,
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.border,
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceRaised,
    paddingHorizontal: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  triggerKind: {
    minWidth: 42,
    fontSize: theme.typography.caption.fontSize,
    fontWeight: "700",
    color: theme.colors.primaryAction,
    textTransform: "uppercase",
  },
  triggerText: {
    flex: 1,
    fontSize: theme.typography.small.fontSize,
    fontWeight: "700",
    color: theme.colors.textPrimary,
  },
  menu: {
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.border,
    borderRadius: 8,
    backgroundColor: theme.colors.surface,
    overflow: "hidden",
  },
  menuScroll: {
    maxHeight: 220,
  },
  groupLabel: {
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 4,
    fontSize: theme.typography.caption.fontSize,
    fontWeight: "800",
    color: theme.colors.textMuted,
    textTransform: "uppercase",
  },
  optionRow: {
    minHeight: 30,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  optionRowSelected: {
    backgroundColor: theme.colors.surfaceActionSelected,
  },
  optionCheck: {
    width: 14,
    fontSize: theme.typography.small.fontSize,
    fontWeight: "800",
    color: theme.colors.primaryAction,
  },
  optionText: {
    flex: 1,
    fontSize: theme.typography.small.fontSize,
    color: theme.colors.textSecondary,
  },
  optionTextSelected: {
    fontWeight: "700",
    color: theme.colors.primaryAction,
  },
  emptyText: {
    paddingHorizontal: 10,
    paddingBottom: 8,
    fontSize: theme.typography.small.fontSize,
    color: theme.colors.textMuted,
  },
  });
}

const branchStylesByTheme: Record<VisualThemeId, ReturnType<typeof createGitBranchStyles>> = {
  standard: createGitBranchStyles(VISUAL_THEMES.standard),
  highLegibility: createGitBranchStyles(VISUAL_THEMES.highLegibility),
};
