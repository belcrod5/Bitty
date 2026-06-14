const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

type FenceMarker = {
  char: "`" | "~";
  length: number;
  info: string;
};

export type MarkdownDisplaySegment =
  | { type: "markdown"; markdown: string }
  | { type: "mermaid"; chart: string };

export function normalizeMarkdown(text: string): string {
  return String(text || "")
    .replace(/\u2028/g, "\n")
    .replace(/\u2029/g, "\n")
    .replace(/\r\n?/g, "\n");
}

export function prepareMarkdownForDisplay(text: string): string {
  return fenceLooseTsxBlocks(normalizeMarkdown(text));
}

export function splitMarkdownForMermaid(text: string): MarkdownDisplaySegment[] {
  const markdown = prepareMarkdownForDisplay(text);
  const lines = markdown.split("\n");
  const segments: MarkdownDisplaySegment[] = [];
  const pendingMarkdown: string[] = [];

  const flushMarkdown = () => {
    const value = pendingMarkdown.join("\n");
    pendingMarkdown.length = 0;
    if (value.trim()) {
      segments.push({ type: "markdown", markdown: value });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const openingFence = parseFenceMarker(line);
    if (!openingFence) {
      pendingMarkdown.push(line);
      continue;
    }

    const block = [line];
    let closingIndex = -1;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const candidate = lines[nextIndex];
      block.push(candidate);
      const closingFence = parseFenceMarker(candidate);
      if (
        closingFence &&
        closingFence.char === openingFence.char &&
        closingFence.length >= openingFence.length
      ) {
        closingIndex = nextIndex;
        break;
      }
    }

    if (!isMermaidFenceInfo(openingFence.info) || closingIndex < 0) {
      pendingMarkdown.push(...block);
      index += block.length - 1;
      continue;
    }

    flushMarkdown();
    segments.push({
      type: "mermaid",
      chart: block.slice(1, -1).join("\n").trim(),
    });
    index = closingIndex;
  }

  flushMarkdown();
  return segments.length > 0 ? segments : [{ type: "markdown", markdown }];
}

function fenceLooseTsxBlocks(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let activeFence: FenceMarker | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = parseFenceMarker(line);
    if (activeFence) {
      output.push(line);
      if (fence && fence.char === activeFence.char && fence.length >= activeFence.length) {
        activeFence = null;
      }
      continue;
    }

    if (fence) {
      activeFence = fence;
      output.push(line);
      continue;
    }

    if (!isLooseTsxBlockStart(line)) {
      output.push(line);
      continue;
    }

    const block = [line];
    while (index + 1 < lines.length && shouldContinueLooseTsxBlock(lines[index + 1], block)) {
      index += 1;
      block.push(lines[index]);
    }

    output.push("```tsx", ...block, "```");
  }

  return output.join("\n");
}

function parseFenceMarker(line: string): FenceMarker | null {
  const match = FENCE_LINE_PATTERN.exec(line);
  if (!match) return null;
  const marker = match[1];
  return {
    char: marker[0] as "`" | "~",
    length: marker.length,
    info: String(match[2] || "").trim(),
  };
}

function isMermaidFenceInfo(info: string): boolean {
  return info.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid";
}

function isLooseTsxBlockStart(line: string): boolean {
  if (/^(?: {4}|\t)/.test(line)) return false;
  const trimmed = line.trim();
  if (!trimmed || parseFenceMarker(line)) return false;
  if (/^<(?:(?:https?|ftp):\/\/|mailto:|[^@\s>]+@)/i.test(trimmed)) return false;
  return (
    /^<!--/.test(trimmed) ||
    /^<![A-Za-z]/.test(trimmed) ||
    /^<\/?(?:[A-Za-z][\w.:-]*)(?:\s|>|\/>|$)/.test(trimmed) ||
    /^<\/?>/.test(trimmed)
  );
}

function shouldContinueLooseTsxBlock(line: string, currentBlock: string[]): boolean {
  if (parseFenceMarker(line)) return false;
  const trimmed = line.trim();
  if (!trimmed) return hasUnclosedTsxStructure(currentBlock);
  if (isLooseTsxBlockStart(line)) return true;
  if (!hasUnclosedTsxStructure(currentBlock)) return false;
  return hasUnclosedTagStructure(currentBlock) || isTsxContinuationLine(trimmed);
}

function isTsxContinuationLine(trimmed: string): boolean {
  return (
    /^(?:\/>|>|[)\]}]+[;,]?|\}\)|\}\})$/.test(trimmed) ||
    /^(?:if|for|while|switch|return|const|let|var|function|await|try|catch|finally|else)\b/.test(trimmed) ||
    /^[A-Za-z_$][\w$.-]*\s*=/.test(trimmed) ||
    /^[A-Za-z_$][\w$.]*\(/.test(trimmed) ||
    /(?:=>|=\{|[{}])/.test(trimmed)
  );
}

function hasUnclosedTsxStructure(lines: string[]): boolean {
  const text = lines.join("\n");
  return (
    countChar(text, "{") > countChar(text, "}") ||
    countChar(text, "(") > countChar(text, ")") ||
    countChar(text, "[") > countChar(text, "]") ||
    countOpenTagLikeStructures(text) > 0 ||
    /<\/?[A-Za-z][\w.:-]*(?:\s[^>]*)?$/.test(text.trim())
  );
}

function hasUnclosedTagStructure(lines: string[]): boolean {
  return countOpenTagLikeStructures(lines.join("\n")) > 0;
}

function countChar(text: string, char: string): number {
  let count = 0;
  for (const current of text) {
    if (current === char) count += 1;
  }
  return count;
}

function countOpenTagLikeStructures(text: string): number {
  return countOpenTags(text) + countOpenFragments(text);
}

function countOpenTags(text: string): number {
  const stack: string[] = [];
  const tagPattern = /<\/?([A-Za-z][\w.:-]*)([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(text))) {
    const fullTag = match[0];
    const tagName = match[1];
    const rest = match[2] || "";
    const normalizedTagName = tagName.toLowerCase();
    if (fullTag.startsWith("<!") || fullTag.startsWith("<?")) continue;
    if (fullTag.startsWith("</")) {
      const lastIndex = stack.lastIndexOf(normalizedTagName);
      if (lastIndex >= 0) stack.splice(lastIndex, 1);
      continue;
    }
    if (rest.trimEnd().endsWith("/") || VOID_HTML_TAGS.has(normalizedTagName)) continue;
    stack.push(normalizedTagName);
  }

  return stack.length;
}

function countOpenFragments(text: string): number {
  const opens = text.match(/<>/g)?.length || 0;
  const closes = text.match(/<\/>/g)?.length || 0;
  return Math.max(0, opens - closes);
}
