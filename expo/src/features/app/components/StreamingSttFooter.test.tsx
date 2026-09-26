import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { Platform, StyleSheet } from "react-native";
import { StreamingSttFooter, type StreamingSttFooterHandle } from "./StreamingSttFooter";
import { VisualThemeProvider } from "../theme/VisualThemeContext";

const mockSharedValues: { value: unknown }[] = [];
const mockRRects: { x: number; y: number; width: number; height: number }[] = [];
const mockGradientProps: { colors: string[]; mode: string; start: { value: unknown }; end: { value: unknown } }[] = [];
const mockPathProps: { color?: string; opacity?: number; strokeWidth?: number | { value: unknown } }[] = [];
const mockBlurProps: { blur: number | { value: unknown } }[] = [];
let mockPathRenders = 0;
let mockFrameCallback: ((frame: { timeSincePreviousFrame: number | null }) => void) | null = null;

jest.mock("../styles", () => ({ useAppStyles: () => ({ chatInputWrapper: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12 } }) }));

jest.mock("@expo/vector-icons", () => {
  const ReactModule = jest.requireActual<typeof React>("react");
  const { Text } = jest.requireActual("react-native") as typeof import("react-native");
  return { Ionicons: ({ name }: { name: string }) => ReactModule.createElement(Text, null, name) };
});

jest.mock("@shopify/react-native-skia", () => {
  const ReactModule = jest.requireActual<typeof React>("react");
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  const Stub = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement(View, null, children);
  return {
    Canvas: ({ children, ...props }: { children?: React.ReactNode }) => ReactModule.createElement(View, props, children),
    Group: Stub,
    Path: ({ children, ...props }: { children?: React.ReactNode; color?: string; opacity?: number; strokeWidth?: number | { value: unknown } }) => {
      mockPathRenders += 1;
      mockPathProps.push(props);
      return ReactModule.createElement(View, null, children);
    },
    SweepGradient: (props: typeof mockGradientProps[number]) => { mockGradientProps.push(props); return null; },
    BlurMask: (props: typeof mockBlurProps[number]) => { mockBlurProps.push(props); return null; },
    vec: (x: number, y: number) => ({ x, y }),
    Skia: {
      Path: { Make: () => ({ addRRect: (rect: { rect: typeof mockRRects[number] }) => mockRRects.push(rect.rect) }) },
      XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
      RRectXY: (rect: typeof mockRRects[number]) => ({ rect }),
    },
  };
});

jest.mock("react-native-reanimated", () => ({
  useFrameCallback: (callback: typeof mockFrameCallback) => { mockFrameCallback = callback; },
  useSharedValue: (value: unknown) => {
    const ReactModule = jest.requireActual<typeof React>("react");
    const ref = ReactModule.useRef<{ value: unknown } | null>(null);
    if (!ref.current) {
      ref.current = { value };
      mockSharedValues.push(ref.current);
    }
    return ref.current;
  },
  withTiming: (value: unknown) => value,
}));

describe("StreamingSttFooter", () => {
  beforeEach(() => {
    mockSharedValues.length = 0;
    mockRRects.length = 0;
    mockGradientProps.length = 0;
    mockPathProps.length = 0;
    mockBlurProps.length = 0;
    mockPathRenders = 0;
    mockFrameCallback = null;
  });

  it("shows voice context values beside STT usage only when the optional prop is supplied", async () => {
    const onStop = jest.fn();
    const screen = await render(<StreamingSttFooter transcript="" phase="recording" onStop={onStop} />);
    expect(screen.queryByTestId("streaming-stt-voice-context-stats")).toBeNull();
    await screen.rerender(<StreamingSttFooter transcript="" phase="recording" onStop={onStop}
      voiceContextStats={{ estimatedContextUsagePercent: 42, unsummarizedMessageCount: 6, memoryCharacterCount: 123 }} />);
    expect(screen.getByTestId("streaming-stt-voice-context-stats").props.children)
      .toBe("文脈推定 42% · 未要約 6件 · メモリー 123字");
    await screen.rerender(<StreamingSttFooter transcript="" phase="recording" onStop={onStop}
      voiceContextStats={null} />);
    expect(screen.getByTestId("streaming-stt-voice-context-stats").props.children)
      .toBe("文脈推定 --% · 未要約 --件 · メモリー --字");
  });

  it("draws outside its panel, grows to three transcript lines, and stops recording", async () => {
    const onStop = jest.fn();
    const screen = await render(<StreamingSttFooter transcript={"一行目\n二行目\n三行目\n四行目"} phase="recording" onStop={onStop} onChangeText={jest.fn()} />);
    const panel = screen.getByTestId("streaming-stt-footer");
    const glow = screen.getByTestId("streaming-stt-glow");
    const transcript = screen.getByTestId("streaming-stt-transcript");
    expect(StyleSheet.flatten(panel.props.style)).toMatchObject({ overflow: "visible" });
    expect(StyleSheet.flatten(panel.props.style).marginHorizontal).toBeUndefined();
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-panel").props.style)).toMatchObject({ minHeight: 62, paddingHorizontal: 10, paddingVertical: 8, zIndex: 1 });
    expect(StyleSheet.flatten(glow.props.style)).toMatchObject({ left: -48, right: -48, top: -48, bottom: -48 });
    expect(transcript.props.value).toContain("四行目");

    await fireEvent(transcript, "contentSizeChange", { nativeEvent: { contentSize: { height: 44 } } });
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-transcript").props.style).height).toBe(44);
    await fireEvent(transcript, "contentSizeChange", { nativeEvent: { contentSize: { height: 110 } } });
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-transcript").props.style).height).toBe(66);

    await act(async () => {
      fireEvent(panel, "layout", { nativeEvent: { layout: { width: 260, height: 80 } } });
    });
    expect(mockRRects.at(-1)).toEqual({ x: 46, y: 46, width: 264, height: 84 });
    expect(screen.getByTestId("streaming-stt-stop").props.hitSlop).toBe(8);
    await fireEvent.press(screen.getByTestId("streaming-stt-stop"));
    expect(onStop).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it("submits the edited value from the Send key and keeps newer edits on acceptance", async () => {
    let accept: (() => boolean) | undefined;
    let finish: (() => void) | undefined;
    const onChangeText = jest.fn();
    const onFocus = jest.fn();
    const onSubmit = jest.fn((_text: string, onAccepted: () => boolean) => {
      accept = onAccepted;
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const screen = await render(<StreamingSttFooter transcript="heard" phase="recording" onStop={jest.fn()}
      onChangeText={onChangeText} onFocus={onFocus} onSubmit={onSubmit} />);
    const input = screen.getByTestId("streaming-stt-transcript");
    expect(input.props.submitBehavior).toBe("submit");
    expect(input.props.returnKeyType).toBe("send");
    await fireEvent(input, "focus");
    expect(onFocus).toHaveBeenCalledTimes(1);
    await fireEvent.changeText(input, "edited");
    await fireEvent(input, "submitEditing", { nativeEvent: { text: "edited" } });
    expect(onSubmit).toHaveBeenCalledWith("edited", expect.any(Function));
    await fireEvent.changeText(input, "newer edit");
    expect(accept?.()).toBe(false);
    expect(onChangeText).not.toHaveBeenCalledWith("");
    await act(async () => { finish?.(); });
    await fireEvent(input, "submitEditing", { nativeEvent: { text: "newer edit" } });
    expect(accept?.()).toBe(true);
    expect(onChangeText).toHaveBeenCalledWith("");
    await act(async () => { finish?.(); });
  });

  it("reconciles the keyboard's final text before accepted submission", async () => {
    const onChangeText = jest.fn();
    let accepted = false;
    const onSubmit = jest.fn(async (_text: string, onAccepted: () => boolean) => {
      accepted = onAccepted();
    });
    const screen = await render(<StreamingSttFooter transcript="draft" phase="recording" onStop={jest.fn()}
      onChangeText={onChangeText} onSubmit={onSubmit} />);
    const input = screen.getByTestId("streaming-stt-transcript");
    await fireEvent(input, "submitEditing", { nativeEvent: { text: "draft with IME text" } });
    expect(onSubmit).toHaveBeenCalledWith("draft with IME text", expect.any(Function));
    expect(onChangeText.mock.calls).toEqual([["draft with IME text"], [""]]);
    expect(accepted).toBe(true);
  });

  it("keeps preparation and error status as editable placeholders", async () => {
    const props = { transcript: "", phase: "connecting" as const, onStop: jest.fn(), onChangeText: jest.fn() };
    const screen = await render(<StreamingSttFooter {...props} statusText="録音を準備しています…" />);
    expect(screen.getByTestId("streaming-stt-transcript").props.placeholder).toBe("録音を準備しています…");
    await screen.rerender(<StreamingSttFooter {...props} statusText="接続に失敗しました。" />);
    expect(screen.getByTestId("streaming-stt-transcript").props.placeholder).toBe("接続に失敗しました。");
    await screen.rerender(<StreamingSttFooter {...props} transcript="送信する文章" statusText="送信に失敗しました。" />);
    expect(screen.getByTestId("streaming-stt-transcript").props.value).toBe("送信する文章");
    expect(screen.getByText("送信に失敗しました。")).toBeTruthy();
  });

  it("submits on plain Enter on Mac", async () => {
    const platform = Object.getOwnPropertyDescriptor(Platform, "OS");
    Object.defineProperty(Platform, "OS", { configurable: true, value: "macos" });
    try {
      let finish: (() => void) | undefined;
      const onSubmit = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      const screen = await render(<StreamingSttFooter transcript="draft" phase="recording" onStop={jest.fn()}
        onChangeText={jest.fn()} onSubmit={onSubmit} />);
      const input = screen.getByTestId("streaming-stt-transcript");
      expect(input.props.submitKeyEvents).toEqual([{ key: "Enter" }]);
      await fireEvent.changeText(input, "latest draft");
      await fireEvent(input, "submitEditing", { nativeEvent: {} });
      await fireEvent(input, "submitEditing", { nativeEvent: {} });
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith("latest draft", expect.any(Function));
      await act(async () => { finish?.(); });
      await screen.unmount();
    } finally {
      if (platform) Object.defineProperty(Platform, "OS", platform);
    }
  });

  it("updates the glow from audio samples without React rendering", async () => {
    const ref = React.createRef<StreamingSttFooterHandle>();
    const screen = await render(<StreamingSttFooter ref={ref} transcript="" phase="recording" onStop={jest.fn()} />);
    const renderCount = mockPathRenders;
    await act(async () => { mockFrameCallback?.({ timeSincePreviousFrame: 50 }); });
    const idleAngle = Number(mockSharedValues[6].value);
    expect(idleAngle).toBeCloseTo(3.6);
    await act(async () => {
      ref.current?.pushSample(0.5);
      mockFrameCallback?.({ timeSincePreviousFrame: 50 });
    });
    expect(mockPathRenders).toBe(renderCount);
    expect(mockGradientProps).toHaveLength(2);
    expect(mockGradientProps.every(({ mode, start, end }) => mode === "repeat" && start === mockSharedValues[6] && end === mockSharedValues[7])).toBe(true);
    expect(mockSharedValues[2].value).toBeGreaterThan(5);
    expect(Number(mockSharedValues[6].value) - idleAngle).toBeGreaterThan(idleAngle);
    expect(Number(mockSharedValues[6].value)).toBeCloseTo(15.6);
    expect(Number(mockSharedValues[7].value) - Number(mockSharedValues[6].value)).toBe(360);
    const glowReach = 2 + Number(mockSharedValues[2].value) / 2 + Number(mockSharedValues[3].value) * 3;
    expect(glowReach).toBeLessThan(48);
    expect(mockSharedValues[4].value).toBe(1);
    await screen.unmount();
  });

  it("uses distinct colors and pulsing speeds for responding and speaking", async () => {
    const ref = React.createRef<StreamingSttFooterHandle>();
    const screen = await render(<StreamingSttFooter ref={ref} transcript="r" voiceStatus="responding" phase="recording" onStop={jest.fn()} />);
    expect(screen.queryByTestId("streaming-stt-reply-loading")).toBeNull();
    expect(mockGradientProps.at(-1)?.colors).toEqual(["#46f6ff", "#537dff", "#ab67ff", "#5fffc8", "#46f6ff"]);
    expect(screen.getByTestId("streaming-stt-transcript").props.accessibilityLabel).toBe("Responding");
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-transcript").props.style)).toMatchObject({ fontWeight: "300", fontSize: 14 });
    await act(async () => { mockFrameCallback?.({ timeSincePreviousFrame: 50 }); });
    expect(Number(mockSharedValues[6].value)).toBeCloseTo(14);
    const respondingWidth = Number(mockSharedValues[2].value);
    await act(async () => { ref.current?.pushSample(0.5); });
    expect(Number(mockSharedValues[2].value)).toBe(respondingWidth);
    await act(async () => { mockFrameCallback?.({ timeSincePreviousFrame: 50 }); });
    expect(Number(mockSharedValues[2].value)).not.toBe(respondingWidth);

    await screen.rerender(<StreamingSttFooter ref={ref} transcript="s" voiceStatus="speaking" phase="recording" onStop={jest.fn()} />);
    expect(mockGradientProps.at(-1)?.colors).toEqual(["#ff79cf", "#ffb263", "#ffe779", "#ff79cf"]);
    expect(screen.getByTestId("streaming-stt-transcript").props.accessibilityLabel).toBe("Speaking");
    const speakingAngle = Number(mockSharedValues[6].value);
    await act(async () => { mockFrameCallback?.({ timeSincePreviousFrame: 50 }); });
    expect(Number(mockSharedValues[6].value) - speakingAngle).toBeCloseTo(6);

    await screen.rerender(<StreamingSttFooter ref={ref} transcript="speaking..." voiceStatus="speaking" phase="recording" onStop={jest.fn()} reduceMotion />);
    const staticAngle = Number(mockSharedValues[6].value);
    const staticWidth = Number(mockSharedValues[2].value);
    await act(async () => { mockFrameCallback?.({ timeSincePreviousFrame: 50 }); });
    expect(mockSharedValues[6].value).toBe(staticAngle);
    expect(mockSharedValues[2].value).toBe(staticWidth);
    expect(screen.getByTestId("streaming-stt-transcript").props.children).toBe("speaking...");

    await screen.rerender(<StreamingSttFooter transcript="" phase="recording" onStop={jest.fn()} />);
    expect(mockGradientProps.at(-1)?.colors).toEqual(["#ff505f", "#ffae3d", "#f9ee56", "#56e89c", "#4cc9ff", "#987aff", "#ff505f"]);
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-transcript").props.style).fontSize).toBe(16);
    expect(Number(mockSharedValues[2].value)).toBe(4);
    await screen.unmount();
  });

  it("keeps the vivid rainbow and adds a soft dark halo only on the white theme", async () => {
    const standard = await render(<StreamingSttFooter transcript="" phase="recording" onStop={jest.fn()} />);
    expect(mockGradientProps[0].colors).toEqual(["#ff505f", "#ffae3d", "#f9ee56", "#56e89c", "#4cc9ff", "#987aff", "#ff505f"]);
    expect(mockPathProps[0]).toMatchObject({ color: "#101827", opacity: 0.35, strokeWidth: 26 });
    expect(mockBlurProps[0]).toMatchObject({ blur: 9 });
    await standard.unmount();

    mockGradientProps.length = 0;
    mockPathProps.length = 0;
    mockBlurProps.length = 0;
    const cyberpunk = await render(
      <VisualThemeProvider themeId="cyberpunk" onSelectTheme={jest.fn()}>
        <StreamingSttFooter transcript="" phase="recording" onStop={jest.fn()} />
      </VisualThemeProvider>
    );
    expect(mockGradientProps[0].colors).toEqual(["#ff505f", "#ffae3d", "#f9ee56", "#56e89c", "#4cc9ff", "#987aff", "#ff505f"]);
    expect(mockPathProps).toHaveLength(2);
    expect(mockBlurProps).toHaveLength(1);
    await cyberpunk.unmount();
  });
});
