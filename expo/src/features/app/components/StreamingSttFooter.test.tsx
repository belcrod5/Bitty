import React from "react";
import { act, fireEvent, render, within } from "@testing-library/react-native";
import { Animated, Platform, StyleSheet, View } from "react-native";
import { StreamingSttFooter, type StreamingSttFooterHandle } from "./StreamingSttFooter";
import { diffSttTranscript } from "../../stt/sttTranscriptDiff";
import { VisualThemeProvider } from "../theme/VisualThemeContext";

const mockSharedValues: { value: unknown }[] = [];
const mockRRects: { x: number; y: number; width: number; height: number }[] = [];
const mockGradientProps: { colors: string[]; mode: string; start: { value: unknown }; end: { value: unknown } }[] = [];
const mockPathProps: { color?: string; opacity?: number; strokeWidth?: number | { value: unknown } }[] = [];
const mockBlurProps: { blur: number | { value: unknown } }[] = [];
let mockPathRenders = 0;
let mockFrameCallback: ((frame: { timeSincePreviousFrame: number | null }) => void) | null = null;

jest.mock("../styles", () => ({ useAppStyles: () => ({ chatInputWrapper: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12 } }) }));
jest.mock("../hooks/useReduceMotionEnabled", () => ({ useReduceMotionEnabled: () => false }));

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

  it("places the correction above the transcript with immediate send and edit actions", async () => {
    const onSendCorrection = jest.fn();
    const onEditCorrection = jest.fn();
    const screen = await render(<StreamingSttFooter transcript="元の文章" phase="preview" onStop={jest.fn()}
      reduceMotion
      correctionPreview={{ text: "補正した文章", deadlineMs: Date.now() + 3000, editing: false,
        parts: diffSttTranscript("元の文章", "補正した文章") }}
      leadingAccessory={<View testID="orchestrator-icon" />}
      trailingAccessory={<View testID="status-menu" />}
      onSendCorrection={onSendCorrection} onEditCorrection={onEditCorrection} />);
    expect(screen.getByTestId("streaming-stt-correction-preview")).toBeTruthy();
    expect(screen.getByTestId("streaming-stt-preview-glow")).toBeTruthy();
    await act(async () => { mockFrameCallback?.({ timeSincePreviousFrame: 50 }); });
    expect(mockSharedValues[6].value).toBe(0);
    const sendButton = screen.getByLabelText("補正した文字起こしを今すぐ送信");
    expect(sendButton.props.accessibilityValue).toMatchObject({ min: 0, max: 3000,
      now: expect.any(Number), text: expect.stringMatching(/^あと[0-3]秒で自動送信$/) });
    expect(within(sendButton).getByTestId("streaming-stt-correction-ring")).toBeTruthy();
    const footer = screen.getByTestId("streaming-stt-footer");
    expect(within(footer).queryByTestId("streaming-stt-correction-preview")).toBeNull();
    expect(within(footer).getByTestId("streaming-stt-leading-accessory")).toBeTruthy();
    expect(within(footer).getByTestId("streaming-stt-trailing-accessory")).toBeTruthy();
    await fireEvent(footer, "layout", { nativeEvent: { layout: { width: 268, height: 112 } } });
    expect(mockRRects.at(-1)).toEqual({ x: 54, y: 78, width: 264, height: 84 });
    await fireEvent(screen.getByTestId("streaming-stt-correction-preview"), "layout",
      { nativeEvent: { layout: { width: 268, height: 120 } } });
    expect(mockRRects.at(-1)).toEqual({ x: 46, y: 46, width: 272, height: 124 });
    expect(screen.queryByText("元の")).toBeNull();
    expect(screen.getByTestId("streaming-stt-correction-deleted").props.children).toBe("削除: 元の");
    expect(StyleSheet.flatten(screen.getByText("補正した").props.style).textDecorationLine)
      .toBe("underline");
    expect(StyleSheet.flatten(screen.getByText("補正した").props.style).backgroundColor).toBeUndefined();
    expect(screen.getByText("文章")).toBeTruthy();
    const previewText = screen.getByTestId("streaming-stt-correction-text");
    expect(previewText.props.accessibilityLabel).toContain("補正後: 補正した文章");
    expect(previewText.props.accessibilityLabel).toContain("削除 元の");
    expect(previewText.props.accessibilityLabel).toContain("追加 補正した");
    expect(previewText.props.accessibilityHint).toBe("ダブルタップで今すぐ送信");
    expect(StyleSheet.flatten(sendButton.props.style)).toMatchObject({ width: 52, height: 52 });
    expect(StyleSheet.flatten(screen.getByLabelText("補正した文字起こしをこのカードで編集").props.style))
      .toMatchObject({ width: 44, height: 44 });
    expect(screen.queryByText(/秒後に送信/)).toBeNull();
    await fireEvent.press(previewText);
    await fireEvent.press(sendButton);
    await fireEvent.press(screen.getByLabelText("補正した文字起こしをこのカードで編集"));
    expect(onSendCorrection).toHaveBeenCalledTimes(2);
    expect(onEditCorrection).toHaveBeenCalledTimes(1);
  });

  it("animates progress toward the hook deadline without starting a send timer", async () => {
    const animation = { start: jest.fn(), stop: jest.fn() };
    const timing = jest.spyOn(Animated, "timing")
      .mockReturnValue(animation as unknown as ReturnType<typeof Animated.timing>);
    const deadlineMs = Date.now() + 2500;
    const screen = await render(<StreamingSttFooter transcript="元" phase="preview" onStop={jest.fn()}
      reduceMotion={false} correctionPreview={{ text: "補", deadlineMs, editing: false,
        parts: diffSttTranscript("元", "補") }} />);
    expect(timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      toValue: 0, useNativeDriver: false, duration: expect.any(Number),
    }));
    const duration = timing.mock.calls[0][1].duration;
    expect(duration).toBeGreaterThan(0);
    expect(duration).toBeLessThanOrEqual(2500);
    await screen.unmount();
    expect(animation.stop).toHaveBeenCalled();
    timing.mockRestore();
  });

  it("replaces the preview text with an editor inside the same glowing card", async () => {
    const onChangeCorrectionText = jest.fn();
    const onSendCorrection = jest.fn();
    const parts = diffSttTranscript("元の文章", "補正した文章");
    const screen = await render(<StreamingSttFooter transcript="元の文章" phase="preview"
      onStop={jest.fn()} correctionPreview={{ text: "補正した文章", deadlineMs: null,
        editing: true, parts }} onChangeCorrectionText={onChangeCorrectionText}
      onSendCorrection={onSendCorrection} />);
    const card = screen.getByTestId("streaming-stt-correction-preview");
    const editor = within(card).getByTestId("streaming-stt-correction-editor");
    expect(editor.props.value).toBe("補正した文章");
    expect(within(card).getByTestId("streaming-stt-preview-glow")).toBeTruthy();
    expect(within(card).queryByTestId("streaming-stt-correction-text")).toBeNull();
    expect(screen.queryByLabelText("補正した文字起こしをこのカードで編集")).toBeNull();
    expect(screen.queryByText("削除: 元の")).toBeNull();
    await fireEvent.changeText(editor, "編集した文章");
    expect(onChangeCorrectionText).toHaveBeenCalledWith("編集した文章");
    const send = screen.getByLabelText("編集した文字起こしを送信");
    expect(send.props.accessibilityValue?.now).toBeUndefined();
    expect(within(send).queryByTestId("streaming-stt-correction-ring")).toBeNull();
    await fireEvent.press(send);
    expect(onSendCorrection).toHaveBeenCalledTimes(1);
  });

  it("keeps the rainbow glow on the input while correction is running", async () => {
    const screen = await render(<StreamingSttFooter transcript="元の文章" phase="correcting"
      voiceStatus="speaking" onStop={jest.fn()} />);
    expect(screen.getByTestId("streaming-stt-glow")).toBeTruthy();
    expect(screen.queryByTestId("streaming-stt-preview-glow")).toBeNull();
    expect(mockGradientProps.at(-1)?.colors).toEqual([
      "#ff505f", "#ffae3d", "#f9ee56", "#56e89c", "#4cc9ff", "#987aff", "#ff505f",
    ]);
  });

  it("clears old Google usage when a new recording session starts", async () => {
    const ref = React.createRef<StreamingSttFooterHandle>();
    const onStop = jest.fn();
    const screen = await render(<StreamingSttFooter ref={ref} transcript="" phase="recording" onStop={onStop} />);
    await act(async () => {
      ref.current?.updateUsage({ usedSeconds: 12, limitSeconds: 3600, remainingSeconds: 3588,
        monthUtc: "2026-09", resetAt: "2026-10-01T00:00:00.000Z" });
    });
    expect(screen.getByText("00:12 / 60m")).toBeTruthy();
    await screen.rerender(<StreamingSttFooter ref={ref} transcript="" phase="connecting" onStop={onStop} />);
    expect(screen.queryByText("音声入力")).toBeNull();
  });

  it("shows voice context values beside STT usage only when the optional prop is supplied", async () => {
    const onStop = jest.fn();
    const screen = await render(<StreamingSttFooter transcript="" phase="recording" onStop={onStop} />);
    expect(screen.queryByTestId("streaming-stt-voice-context-stats")).toBeNull();
    await screen.rerender(<StreamingSttFooter transcript="" phase="recording" onStop={onStop}
      voiceContextStats={{ estimatedContextUsagePercent: 42, unsummarizedMessageCount: 6, memoryCharacterCount: 123 }} />);
    expect(screen.getByTestId("streaming-stt-voice-context-stats").props.children)
      .toBe("文脈 42% · 未要約 6件 · メモリー 123字");
    await screen.rerender(<StreamingSttFooter transcript="" phase="recording" onStop={onStop}
      voiceContextStats={null} />);
    expect(screen.getByTestId("streaming-stt-voice-context-stats").props.children)
      .toBe("文脈 --% · 未要約 --件 · メモリー --字");
    await screen.rerender(<StreamingSttFooter transcript="" phase="recording" onStop={onStop}
      voiceContextStats={{ estimatedContextUsagePercent: 42, unsummarizedMessageCount: 6,
        memoryCharacterCount: 123, subagentRunningCount: 1, subagentTotalCount: 2 }} />);
    expect(screen.getByTestId("streaming-stt-subagent-count")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("floats the orchestrator icon above the panel without a transcript gutter", async () => {
    const screen = await render(<StreamingSttFooter transcript="" phase="recording" onStop={jest.fn()}
      onChangeText={jest.fn()} leadingAccessory={<View testID="orchestrator-icon" style={{ width: 30, height: 30 }} />}
      voiceContextStats={{ estimatedContextUsagePercent: 2, unsummarizedMessageCount: 0,
        memoryCharacterCount: 0, subagentRunningCount: 0, subagentTotalCount: 0 }} />);
    const panel = screen.getByTestId("streaming-stt-panel");
    expect(screen.getByTestId("orchestrator-icon")).toBeTruthy();
    expect(within(panel).queryByTestId("orchestrator-icon")).toBeNull();
    expect(StyleSheet.flatten(panel.props.style).paddingLeft).toBeUndefined();
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-transcript").props.style).paddingLeft).toBeUndefined();
    const metadata = screen.getByTestId("streaming-stt-metadata");
    expect(StyleSheet.flatten(metadata.props.style)).toMatchObject({ marginTop: 19, minHeight: 11, marginBottom: 2 });
    expect(StyleSheet.flatten(metadata.props.style).paddingLeft).toBeUndefined();
    expect(metadata.children[0]).toBe(screen.getByTestId("streaming-stt-voice-context-stats"));
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-voice-context-stats").props.style).marginLeft).toBe(0);
    const badge = StyleSheet.flatten(screen.getByTestId("streaming-stt-leading-accessory").props.style);
    expect(badge).toMatchObject({ top: 0, left: 0, width: 44, height: 44, zIndex: 3 });
    const footer = screen.getByTestId("streaming-stt-footer");
    expect(StyleSheet.flatten(footer.props.style)).toMatchObject({ paddingTop: 8, paddingLeft: 8 });
    const labelTop = StyleSheet.flatten(footer.props.style).paddingTop
      + StyleSheet.flatten(panel.props.style).paddingVertical + StyleSheet.flatten(metadata.props.style).marginTop;
    expect(labelTop).toBeGreaterThanOrEqual(badge.top
      + StyleSheet.flatten(screen.getByTestId("orchestrator-icon").props.style).height);
    expect(labelTop + StyleSheet.flatten(metadata.props.style).minHeight
      + StyleSheet.flatten(metadata.props.style).marginBottom).toBeGreaterThan(badge.top + badge.height);
    await act(async () => {
      fireEvent(footer, "layout", { nativeEvent: { layout: { width: 268, height: 88 } } });
    });
    expect(mockRRects.at(-1)).toEqual({ x: 54, y: 54, width: 264, height: 84 });
    await screen.rerender(<StreamingSttFooter transcript="" phase="recording" onStop={jest.fn()}
      onChangeText={jest.fn()} leadingAccessory={<View testID="orchestrator-icon" style={{ width: 30, height: 30 }} />} />);
    expect(screen.getByTestId("streaming-stt-metadata").children).toHaveLength(0);
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-metadata").props.style).minHeight).toBe(11);
    await screen.rerender(<StreamingSttFooter transcript="" phase="recording" onStop={jest.fn()}
      voiceStatus="speaking" onCancelSpeaking={jest.fn()}
      leadingAccessory={<View testID="orchestrator-icon" />} />);
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-speaking-cancel").props.style).zIndex).toBe(2);
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-leading-accessory").props.style).zIndex).toBe(3);
  });

  it("keeps an optional upper-right accessory clear of the speaking overlay and stop button", async () => {
    const props = { transcript: "", phase: "recording" as const, onStop: jest.fn(),
      voiceStatus: "speaking" as const, onCancelSpeaking: jest.fn() };
    const screen = await render(<StreamingSttFooter {...props} />);
    expect(screen.queryByTestId("streaming-stt-trailing-accessory")).toBeNull();
    await screen.rerender(<StreamingSttFooter {...props}
      leadingAccessory={<View testID="orchestrator-icon" />}
      trailingAccessory={<View testID="status-menu" />} />);
    const accessory = screen.getByTestId("streaming-stt-trailing-accessory");
    expect(within(accessory).getByTestId("status-menu")).toBeTruthy();
    expect(within(screen.getByTestId("streaming-stt-panel")).queryByTestId("status-menu")).toBeNull();
    expect(StyleSheet.flatten(accessory.props.style)).toMatchObject({
      left: 60, right: 0, top: 0, minHeight: 32, zIndex: 3,
    });
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-footer").props.style).paddingTop).toBe(32);
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-metadata").props.style).marginTop).toBe(8);
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-speaking-cancel").props.style).zIndex).toBe(2);
    expect(screen.getByTestId("streaming-stt-stop")).toBeTruthy();
    await act(async () => {
      fireEvent(screen.getByTestId("streaming-stt-footer"), "layout",
        { nativeEvent: { layout: { width: 268, height: 112 } } });
    });
    expect(mockRRects.at(-1)).toEqual({ x: 54, y: 78, width: 264, height: 84 });
    await screen.rerender(<StreamingSttFooter {...props} trailingAccessory={<View testID="status-menu" />} />);
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-trailing-accessory").props.style).left).toBe(0);
  });

  it("offers a screen-reader history action on the existing transcript element", async () => {
    const onHistoryToggle = jest.fn();
    const onBlur = jest.fn();
    const props = { transcript: "", phase: "recording" as const, onStop: jest.fn(),
      onChangeText: jest.fn(), onHistoryToggle, onBlur };
    const screen = await render(<StreamingSttFooter {...props} />);
    const input = screen.getByTestId("streaming-stt-transcript");
    expect(input.props.accessibilityActions).toEqual([{ name: "toggleHistory", label: "履歴を開く" }]);
    await fireEvent(input, "accessibilityAction", { nativeEvent: { actionName: "toggleHistory" } });
    await fireEvent(input, "blur");
    expect(onBlur).toHaveBeenCalledTimes(1);
    await screen.rerender(<StreamingSttFooter {...props} historyExpanded voiceStatus="responding" />);
    const status = screen.getByTestId("streaming-stt-transcript");
    expect(status.props.accessibilityActions).toEqual([{ name: "toggleHistory", label: "履歴を閉じる" }]);
    await fireEvent(status, "accessibilityAction", { nativeEvent: { actionName: "toggleHistory" } });
    expect(onHistoryToggle).toHaveBeenCalledTimes(2);
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

    expect(transcript.props.scrollEnabled).toBe(true);
    expect(StyleSheet.flatten(transcript.props.style)).toMatchObject({ minHeight: 22, maxHeight: 66 });
    expect(StyleSheet.flatten(transcript.props.style).height).toBeUndefined();

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

  it("uses a speaking tap to stop only the playback", async () => {
    const onCancelSpeaking = jest.fn();
    const onStop = jest.fn();
    const screen = await render(<StreamingSttFooter transcript="" voiceStatus="speaking"
      phase="recording" onStop={onStop} onCancelSpeaking={onCancelSpeaking} />);

    await fireEvent.press(screen.getByLabelText("読み上げを停止"));

    expect(onCancelSpeaking).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("keeps the glow phase when a speaking response receives another audio chunk", async () => {
    const screen = await render(<StreamingSttFooter transcript="" statusText="speaking" voiceStatus="speaking" phase="recording" onStop={jest.fn()} />);
    await act(async () => { mockFrameCallback?.({ timeSincePreviousFrame: 50 }); });
    const angle = Number(mockSharedValues[6].value);
    const width = Number(mockSharedValues[2].value);

    await screen.rerender(<StreamingSttFooter transcript="" statusText="speaking." voiceStatus="speaking" phase="recording" onStop={jest.fn()} />);
    expect(mockSharedValues[6].value).toBe(angle);
    expect(mockSharedValues[2].value).toBe(width);
    await act(async () => { mockFrameCallback?.({ timeSincePreviousFrame: 50 }); });
    expect(Number(mockSharedValues[6].value)).toBeGreaterThan(angle);
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
