import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

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
  const current = normalizeBranchName(currentBranchName) || "HEAD";
  const detached = current === "HEAD";
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState(detached ? "" : `local:${current}`);
  const branchOptions = useMemo(
    () => normalizeBranches(branches, current),
    [branches, current]
  );
  const selectedOption = branchOptions.find((item) => `${item.kind}:${item.name}` === selectedKey);
  const selectedKind = selectedOption?.kind || (detached ? "detached" : "local");
  const localBranches = branchOptions.filter((item) => item.kind === "local");
  const remoteBranches = branchOptions.filter((item) => item.kind === "remote");

  useEffect(() => {
    setSelectedKey(detached ? "" : `local:${current}`);
  }, [current, detached]);

  const renderOption = (item: GitBranchOption) => {
    const optionKey = `${item.kind}:${item.name}`;
    const optionSelected = optionKey === selectedKey;
    return (
      <TouchableOpacity
        key={optionKey}
        style={[branchStyles.optionRow, optionSelected ? branchStyles.optionRowSelected : null]}
        onPress={() => {
          setSelectedKey(optionKey);
          setOpen(false);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${item.kind === "local" ? "Local" : "Remote"} ${item.name}を選択`}
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
        <Text style={branchStyles.triggerKind}>{selectedKind}</Text>
        <Text style={branchStyles.triggerText} numberOfLines={1}>
          {selectedOption?.name || current}
        </Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={15} color="#334155" />
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

const branchStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 8,
    backgroundColor: "#ffffff",
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: "700",
    color: "#0f172a",
  },
  trigger: {
    minHeight: 34,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 8,
    backgroundColor: "#f8fafc",
    paddingHorizontal: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  triggerKind: {
    minWidth: 42,
    fontSize: 11,
    fontWeight: "700",
    color: "#0f766e",
    textTransform: "uppercase",
  },
  triggerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: "700",
    color: "#0f172a",
  },
  menu: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 8,
    backgroundColor: "#ffffff",
    overflow: "hidden",
  },
  menuScroll: {
    maxHeight: 220,
  },
  groupLabel: {
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 4,
    fontSize: 11,
    fontWeight: "800",
    color: "#64748b",
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
    backgroundColor: "#ecfeff",
  },
  optionCheck: {
    width: 14,
    fontSize: 12,
    fontWeight: "800",
    color: "#0f766e",
  },
  optionText: {
    flex: 1,
    fontSize: 12,
    color: "#334155",
  },
  optionTextSelected: {
    fontWeight: "700",
    color: "#0f766e",
  },
  emptyText: {
    paddingHorizontal: 10,
    paddingBottom: 8,
    fontSize: 12,
    color: "#64748b",
  },
});
