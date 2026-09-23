import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { ScrollView, StyleSheet } from "react-native";
import { StreamingSttFooter, type StreamingSttFooterHandle } from "./StreamingSttFooter";

const mockSharedValues: { value: unknown }[] = [];
const mockRRects: { x: number; y: number; width: number; height: number }[] = [];
const mockGradientProps: { mode: string; start: { value: unknown }; end: { value: unknown } }[] = [];
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
    Path: ({ children }: { children?: React.ReactNode }) => {
      mockPathRenders += 1;
      return ReactModule.createElement(View, null, children);
    },
    SweepGradient: (props: typeof mockGradientProps[number]) => { mockGradientProps.push(props); return null; },
    BlurMask: () => null,
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
    mockPathRenders = 0;
    mockFrameCallback = null;
  });

  it("draws outside its panel, grows to three transcript lines, and stops recording", async () => {
    const onStop = jest.fn();
    const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => {});
    const screen = await render(<StreamingSttFooter transcript={"一行目\n二行目\n三行目\n四行目"} phase="recording" onStop={onStop} />);
    const panel = screen.getByTestId("streaming-stt-footer");
    const glow = screen.getByTestId("streaming-stt-glow");
    const transcript = screen.getByTestId("streaming-stt-transcript");
    const transcriptScroll = screen.getByTestId("streaming-stt-transcript-scroll");
    expect(StyleSheet.flatten(panel.props.style)).toMatchObject({ overflow: "visible" });
    expect(StyleSheet.flatten(panel.props.style).marginHorizontal).toBeUndefined();
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-panel").props.style)).toMatchObject({ minHeight: 62, paddingHorizontal: 10, paddingVertical: 8 });
    expect(StyleSheet.flatten(glow.props.style)).toMatchObject({ left: -48, right: -48, top: -48, bottom: -48 });
    expect(transcript.props.numberOfLines).toBeUndefined();
    expect(transcript.props.children).toContain("四行目");

    await fireEvent(transcript, "layout", { nativeEvent: { layout: { height: 44 } } });
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-transcript-scroll").props.style).height).toBe(44);
    await fireEvent(transcript, "layout", { nativeEvent: { layout: { height: 110 } } });
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-transcript-scroll").props.style).height).toBe(66);
    await fireEvent(transcriptScroll, "contentSizeChange", 200, 110);
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });

    await act(async () => {
      fireEvent(panel, "layout", { nativeEvent: { layout: { width: 260, height: 80 } } });
    });
    expect(mockRRects.at(-1)).toEqual({ x: 46, y: 46, width: 264, height: 84 });
    await fireEvent.press(screen.getByTestId("streaming-stt-stop"));
    expect(onStop).toHaveBeenCalledTimes(1);
    await screen.unmount();
    scrollToEnd.mockRestore();
  });

  it("updates the glow from audio samples without React rendering", async () => {
    const ref = React.createRef<StreamingSttFooterHandle>();
    const screen = await render(<StreamingSttFooter ref={ref} transcript="" phase="recording" onStop={jest.fn()} />);
    const renderCount = mockPathRenders;
    await act(async () => { mockFrameCallback?.({ timeSincePreviousFrame: 50 }); });
    const idleAngle = Number(mockSharedValues[6].value);
    await act(async () => {
      ref.current?.pushSample(0.5);
      mockFrameCallback?.({ timeSincePreviousFrame: 50 });
    });
    expect(mockPathRenders).toBe(renderCount);
    expect(mockGradientProps).toHaveLength(2);
    expect(mockGradientProps.every(({ mode, start, end }) => mode === "repeat" && start === mockSharedValues[6] && end === mockSharedValues[7])).toBe(true);
    expect(mockSharedValues[2].value).toBeGreaterThan(5);
    expect(Number(mockSharedValues[6].value) - idleAngle).toBeGreaterThan(idleAngle);
    expect(Number(mockSharedValues[7].value) - Number(mockSharedValues[6].value)).toBe(360);
    const glowReach = 2 + Number(mockSharedValues[2].value) / 2 + Number(mockSharedValues[3].value) * 3;
    expect(glowReach).toBeLessThan(48);
    expect(mockSharedValues[4].value).toBe(1);
    await screen.unmount();
  });
});
