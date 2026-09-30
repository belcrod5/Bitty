import { render } from "@testing-library/react-native";
import { VISUAL_THEMES, type VisualThemeId } from "../theme/visualThemes";
import { MarkdownText } from "./MarkdownText";

let mockThemeId: VisualThemeId = "standard";
let mockMarkdownProps: Record<string, any> = {};

jest.mock("react-native-enriched-markdown", () => ({
  EnrichedMarkdownText: (props: Record<string, any>) => {
    mockMarkdownProps = props;
    return null;
  },
}));
jest.mock("./MermaidCodeBlock", () => ({ MermaidCodeBlock: () => null }));
jest.mock("../styles", () => ({
  useAppStyles: () => ({ markdownRoot: {}, markdownRootAssistant: {}, markdownRootUser: {} }),
}));
jest.mock("../theme/VisualThemeContext", () => ({
  useVisualTheme: () => ({ theme: require("../theme/visualThemes").VISUAL_THEMES[mockThemeId] }),
}));

describe("MarkdownText theme colors", () => {
  it.each(["standard", "cyberpunk"] as const)("sets themed colors for %s markdown blocks", async (themeId) => {
    mockThemeId = themeId;
    const theme = VISUAL_THEMES[themeId];
    await render(<MarkdownText content="hello" tone="assistant"
      textStyle={{ color: theme.colors.textPrimary }} />);
    const style = mockMarkdownProps.markdownStyle;
    expect(style.table.headerTextColor).toBe(theme.colors.textPrimary);
    expect(style.table.rowEvenBackgroundColor).toBe(theme.colors.surfaceSubtle);
    expect(style.table.rowOddBackgroundColor).toBe(theme.colors.surfaceRaised);
    expect(style.blockquote.backgroundColor).toBe(theme.colors.surfaceSubtle);
    expect(style.taskList.checkedTextColor).toBe(theme.colors.textPrimary);
    expect(style.list.bulletColor).toBe(theme.colors.textPrimary);
    expect(style.spoiler.color).toBe(theme.colors.textMuted);
    expect(style.math.color).toBe(theme.colors.textPrimary);
    expect(style.math.backgroundColor).toBe(theme.colors.surfaceRaised);
  });

  it.each(["standard", "cyberpunk"] as const)("keeps %s user blocks readable", async (themeId) => {
    mockThemeId = themeId;
    const theme = VISUAL_THEMES[themeId];
    await render(<MarkdownText content="hello" tone="user"
      textStyle={{ color: theme.colors.textPrimary }} />);
    const style = mockMarkdownProps.markdownStyle;
    expect(style.code.color).toBe(theme.colors.textPrimary);
    expect(style.link.color).toBe(theme.colors.accentStrong);
    expect(style.code.backgroundColor).toBe(theme.colors.userCodeSurface);
    expect(style.codeBlock.color).toBe(theme.colors.textPrimary);
    expect(style.codeBlock.backgroundColor).toBe(theme.colors.userCodeBlockSurface);
    expect(style.table.color).toBe(theme.colors.textPrimary);
    expect(style.table.headerTextColor).toBe(theme.colors.textPrimary);
    expect(style.table.rowEvenBackgroundColor).toBe(theme.colors.userCodeSurface);
    expect(style.blockquote.color).toBe(theme.colors.textPrimary);
    expect(style.math.color).toBe(theme.colors.textPrimary);
    expect(style.blockquote.backgroundColor).toBe(theme.colors.userCodeSurface);
    expect(style.strong.color).toBeUndefined();
  });
});
