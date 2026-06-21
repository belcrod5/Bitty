import { normalizeRunnerPath } from "./runnerFileContextMenu";

type GitDiffFileTreeDraftNode = {
  name: string;
  fullPath: string;
  kind: "dir" | "file";
  children: Record<string, GitDiffFileTreeDraftNode>;
};

export type GitDiffFileTreeNode = {
  name: string;
  fullPath: string;
  kind: "dir" | "file";
  children: GitDiffFileTreeNode[];
};

export function buildGitDiffFileTree(paths: string[]): GitDiffFileTreeNode[] {
  const root: GitDiffFileTreeDraftNode = {
    name: "",
    fullPath: "",
    kind: "dir",
    children: {},
  };
  for (const rawPath of paths) {
    const normalizedPath = normalizeRunnerPath(rawPath);
    if (!normalizedPath) continue;
    const parts = normalizedPath.split("/").filter(Boolean);
    if (parts.length <= 0) continue;
    let cursor = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = i === parts.length - 1;
      if (!cursor.children[part]) {
        cursor.children[part] = {
          name: part,
          fullPath: currentPath,
          kind: isLeaf ? "file" : "dir",
          children: {},
        };
      } else if (isLeaf) {
        cursor.children[part].kind = "file";
      }
      cursor = cursor.children[part];
    }
  }
  const sortNodes = (node: GitDiffFileTreeDraftNode): GitDiffFileTreeNode[] => {
    const entries = Object.values(node.children);
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries.map((item) => ({
      name: item.name,
      fullPath: item.fullPath,
      kind: item.kind,
      children: item.kind === "dir" ? sortNodes(item) : [],
    }));
  };
  return sortNodes(root);
}
