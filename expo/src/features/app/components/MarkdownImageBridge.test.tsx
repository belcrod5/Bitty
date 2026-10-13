import { act, render } from "@testing-library/react-native";

let mockNativeProps: Record<string, any> = {};
jest.mock("react-native-enriched-markdown/src/EnrichedMarkdownNativeComponent", () => ({
  __esModule: true, default: (props: Record<string, any>) => { mockNativeProps = props; return null; },
}));
jest.mock("react-native-enriched-markdown/src/EnrichedMarkdownTextNativeComponent", () => ({
  __esModule: true, default: (props: Record<string, any>) => { mockNativeProps = props; return null; },
}));
jest.mock("react-native-enriched-markdown/lib/module/EnrichedMarkdownNativeComponent", () => ({
  __esModule: true, default: (props: Record<string, any>) => { mockNativeProps = props; return null; },
}));
jest.mock("react-native-enriched-markdown/lib/module/EnrichedMarkdownTextNativeComponent", () => ({
  __esModule: true, default: (props: Record<string, any>) => { mockNativeProps = props; return null; },
}));

const implementations = [
  ["source", require("react-native-enriched-markdown/src/native/EnrichedMarkdownText").EnrichedMarkdownText],
  ["distributed", require("react-native-enriched-markdown/lib/module/native/EnrichedMarkdownText").EnrichedMarkdownText],
] as const;

describe.each(implementations)("%s native image source bridge", (_name, Markdown) => {
  const markdown = "![screen][image]\n\n[image]: /private/tmp/screen.jpg";

  it("resolves only native AST destinations and retains the original Markdown", async () => {
    const resolver = jest.fn((url: string) => ({ uri: `http://runner.test/image?path=${encodeURIComponent(url)}`,
      headers: { authorization: "Bearer token" } }));
    await render(<Markdown markdown={markdown} flavor="github" resolveImageSource={resolver} />);
    expect(mockNativeProps.markdown).toBe(markdown);
    expect(mockNativeProps.resolveImages).toBe(true);
    expect(mockNativeProps.imageSources).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
    await act(() => mockNativeProps.onImageSources({ nativeEvent: { markdown, urls: ["/private/tmp/screen.jpg"] } }));
    expect(resolver).toHaveBeenCalledWith("/private/tmp/screen.jpg");
    expect(mockNativeProps.imageSources).toEqual([{
      url: "/private/tmp/screen.jpg", uri: "http://runner.test/image?path=%2Fprivate%2Ftmp%2Fscreen.jpg",
      headers: [{ name: "authorization", value: "Bearer token" }],
    }]);
    expect(mockNativeProps.markdown).toBe(markdown);
  });

  it("ignores old native results after a content revision", async () => {
    const resolver = jest.fn((uri: string) => ({ uri }));
    const view = await render(<Markdown markdown={markdown} flavor="github" resolveImageSource={resolver} />);
    const oldHandler = mockNativeProps.onImageSources;
    await view.rerender(<Markdown markdown="new text" flavor="github" resolveImageSource={resolver} />);
    await act(() => oldHandler({ nativeEvent: { markdown, urls: ["/private/tmp/old.jpg"] } }));
    await act(() => mockNativeProps.onImageSources({ nativeEvent: { markdown, urls: ["/private/tmp/old.jpg"] } }));
    expect(mockNativeProps.imageSources).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("recomputes sources for current Runner credentials without changing the Markdown", async () => {
    const first = () => ({ uri: "http://runner.test/image", headers: { authorization: "Bearer first" } });
    const second = () => ({ uri: "http://other.test/image", headers: { authorization: "Bearer second" } });
    const view = await render(<Markdown markdown={markdown} flavor="github" resolveImageSource={first} />);
    await act(() => mockNativeProps.onImageSources({ nativeEvent: { markdown, urls: ["/private/tmp/screen.jpg"] } }));
    await view.rerender(<Markdown markdown={markdown} flavor="github" resolveImageSource={second} />);
    expect(mockNativeProps.imageSources[0]).toEqual({ url: "/private/tmp/screen.jpg", uri: "http://other.test/image",
      headers: [{ name: "authorization", value: "Bearer second" }] });
    await view.rerender(<Markdown markdown={markdown} flavor="github" resolveImageSource={() => null} />);
    expect(mockNativeProps.imageSources).toEqual([]);
    expect(mockNativeProps.resolveImages).toBe(true);
  });

  it("keeps header-free HTTPS sources and avoids re-resolving repeated native events", async () => {
    const uri = "https://images.test/a.jpg";
    const resolver = jest.fn(() => ({ uri }));
    await render(<Markdown markdown={markdown} flavor="github" resolveImageSource={resolver} />);
    const event = { nativeEvent: { markdown, urls: [uri] } };
    await act(() => mockNativeProps.onImageSources(event));
    await act(() => mockNativeProps.onImageSources(event));
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(mockNativeProps.imageSources).toEqual([{ url: uri, uri, headers: [] }]);
  });

  it("keeps CommonMark outside the new source-resolution contract", async () => {
    await render(<Markdown markdown={markdown} flavor="commonmark" resolveImageSource={() => null} />);
    expect(mockNativeProps.resolveImages).toBeUndefined();
    expect(mockNativeProps.imageSources).toBeUndefined();
  });
});
