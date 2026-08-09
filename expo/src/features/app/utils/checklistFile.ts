export type ChecklistItem = {
  checked: boolean;
  text: string;
};

const CHECKLIST_LINE_PATTERN = /^-\s+\[([ xX])\]\s+(.+)$/;

export function parseChecklistFile(content: string): ChecklistItem[] {
  return String(content || "")
    .split(/\r?\n/)
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      const match = CHECKLIST_LINE_PATTERN.exec(line);
      if (!match) {
        throw new Error(`${index + 1}行目がチェックリスト形式ではありません。`);
      }
      return [{
        checked: match[1].toLowerCase() === "x",
        text: match[2].trim(),
      }];
    });
}

export function serializeChecklistFile(items: ChecklistItem[]) {
  if (items.length === 0) return "";
  return `${items.map((item) => `- [${item.checked ? "x" : " "}] ${item.text.trim()}`).join("\n")}\n`;
}

export function moveChecklistItem<T extends ChecklistItem>(items: T[], fromIndex: number, toIndex: number) {
  const boundedToIndex = Math.max(0, Math.min(items.length - 1, toIndex));
  if (fromIndex < 0 || fromIndex >= items.length || fromIndex === boundedToIndex) {
    return items;
  }
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(boundedToIndex, 0, movedItem);
  return nextItems;
}
