import { State, PointerType, type TouchData } from "react-native-gesture-handler";
const { getByGestureTestId }: typeof import("react-native-gesture-handler/lib/typescript/jestUtils") = require("react-native-gesture-handler/lib/commonjs/jestUtils");
const { onGestureHandlerEvent }: typeof import("react-native-gesture-handler/lib/typescript/handlers/gestures/eventReceiver") = require("react-native-gesture-handler/lib/commonjs/handlers/gestures/eventReceiver");
const { TouchEventType }: typeof import("react-native-gesture-handler/lib/typescript/TouchEventType") = require("react-native-gesture-handler/lib/commonjs/TouchEventType");
import { AppState, StyleSheet, Text } from "react-native";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { act, fireEvent, render } from "@testing-library/react-native";
import { BrowserControlContext, useBrowserControlRequests, useBrowserControlTyping } from "../contexts/BrowserControlContext";
import { useBrowserControl, type BrowserControlFocus, BrowserControlFrame, BrowserControlInput, BrowserControlRequest } from "../hooks/useBrowserControl";
import { BrowserControlCard } from "./BrowserControlCard";
import { VoiceConversationMessages } from "./VoiceConversationMessages";
jest.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000001" }));
jest.mock("../keyboardController", () => ({ KeyboardAvoidingView: require("react-native").KeyboardAvoidingView }));
jest.mock("react-native-gesture-handler/lib/commonjs/RNGestureHandlerModule", () => require("react-native-gesture-handler/lib/commonjs/mocks/mocks"));
jest.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: (name: string) => name === "BittyBrowserKeyboard" ? {} : null,
  requireNativeViewManager: () => { const React = require("react"); const { View } = require("react-native"); return (props: unknown) => React.createElement(View, props); },
}));
jest.mock("./MarkdownText", () => ({ MarkdownText: ({ content }: { content: string }) => { const { Text } = require("react-native"); return <Text>{content}</Text>; } }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("./AnswerLearningDetails", () => ({ AnswerLearningDetails: () => null }));
jest.mock("./VoiceTurnTrace", () => ({ VoiceTurnTrace: () => null }));
const card: BrowserControlRequest = { requestId: "one", origin: "https://example.com", label: "Control", createdAt: "2026-11-26T00:01:00Z", status: "pending", target: { kind: "orchestrator", orchestratorId: "main" } };
const frame = { frameId: 1, data: "aW1hZ2U=", width: 800, height: 600 };
function fixture() {
  let listener: ((frame: BrowserControlFrame | null) => void) | undefined;
  let keyboard: ((focus: BrowserControlFocus | null) => void) | undefined;
  const controller = { requests: [card], typingRequestId: null as string | null, command: jest.fn(async (_requestId: string, _action: string) => {}), input: jest.fn(async (_requestId: string, _input: BrowserControlInput, _frameId: number) => {}), ack: jest.fn(), failDisplay: jest.fn(), watch: jest.fn((_id: string, handler: (frame: BrowserControlFrame | null) => void, onFocus?: (focus: BrowserControlFocus | null) => void) => { listener = handler; keyboard = onFocus; return () => { handler(null); keyboard?.(null); }; }) };
  return { controller, emit: (next: BrowserControlFrame | null) => listener?.(next), emitFocus: (next: BrowserControlFocus | null) => keyboard?.(next) };
}
afterEach(() => jest.restoreAllMocks());
test("already displayed identical frames acknowledge new IDs without another native load", async () => {
  const f = fixture(); const content = (status: BrowserControlRequest["status"]) => <BrowserControlContext.Provider value={f.controller}><BrowserControlCard request={{ ...card, status }} /></BrowserControlContext.Provider>;
  const view = await render(content("pending")); await fireEvent.press(view.getByText("ブラウザを開く")); await view.rerender(content("active"));
  await act(async () => f.emit(frame)); const oldLoad = view.getByLabelText("ブラウザの画面").props.onLoad;
  expect(f.controller.ack).not.toHaveBeenCalled(); await fireEvent(view.getByLabelText("ブラウザの画面"), "load");
  await act(async () => f.emit({ ...frame, frameId: 2 }));
  expect(f.controller.ack.mock.calls).toEqual([["one", 1], ["one", 2]]);
  await act(async () => oldLoad()); expect(f.controller.ack).toHaveBeenCalledTimes(2);
  await act(async () => f.emitFocus({ editable: true, multiline: false, kind: "text", focusRevision: "focus-1" }));
  await fireEvent(view.getByTestId("browser-control-keyboard"), "input", { nativeEvent: { text: "dummy", focusRevision: "focus-1" } });
  expect(f.controller.input).toHaveBeenLastCalledWith("one", { type: "text", text: "dummy", focusRevision: "focus-1" }, 2);
  await act(async () => f.emit({ ...frame, frameId: 3, width: 1600, height: 1200 }));
  expect(f.controller.ack).toHaveBeenCalledTimes(2); expect(view.getByTestId("browser-control-keyboard").props.focusRevision).toBeNull();
  await fireEvent(view.getByLabelText("ブラウザの画面"), "load");
  expect(f.controller.ack).toHaveBeenLastCalledWith("one", 3);
  const priorLoad = view.getByLabelText("ブラウザの画面").props.onLoad;
  await act(async () => { f.emit(null); f.emit({ ...frame, frameId: 4, width: 1600, height: 1200 }); });
  await act(async () => priorLoad()); expect(f.controller.ack).toHaveBeenCalledTimes(3);
  await fireEvent(view.getByLabelText("ブラウザの画面"), "load"); expect(f.controller.ack).toHaveBeenLastCalledWith("one", 4);
  await fireEvent.press(view.getByText("閉じる")); await act(async () => priorLoad()); expect(f.controller.ack).toHaveBeenCalledTimes(4);
  await view.unmount();
});
test("identical frames before the first native load are not acknowledged early", async () => {
  const f = fixture(); const content = (status: BrowserControlRequest["status"]) => <BrowserControlContext.Provider value={f.controller}><BrowserControlCard request={{ ...card, status }} /></BrowserControlContext.Provider>;
  const view = await render(content("pending")); await fireEvent.press(view.getByText("ブラウザを開く")); await view.rerender(content("active"));
  await act(async () => { f.emit(frame); f.emit({ ...frame, frameId: 2 }); }); expect(f.controller.ack).not.toHaveBeenCalled();
  await fireEvent(view.getByLabelText("ブラウザの画面"), "load"); expect(f.controller.ack.mock.calls).toEqual([["one", 2]]); await view.unmount();
});
test("opening is explicit and the native keyboard forwards committed input without a chat field", async () => {
  const f = fixture();
  function Chat({ selected, status = "pending" }: { selected: string; status?: BrowserControlRequest["status"] }) { return <>{useBrowserControlRequests({ kind: "orchestrator", orchestratorId: selected }).map((r) => <BrowserControlCard key={r.requestId} request={{ ...r, status }} />)}</>; }
  const content = (selected: string, status: BrowserControlRequest["status"] = "pending") => <BrowserControlContext.Provider value={f.controller}><Chat selected={selected} status={status} /></BrowserControlContext.Provider>;
  const view = await render(content("main")); expect(f.controller.command).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText("ブラウザを開く")); expect(view.queryByText("操作を開始")).toBeNull(); expect(f.controller.watch).toHaveBeenCalledTimes(1); expect(f.controller.command).toHaveBeenCalledWith("one", "start");
  await view.rerender(content("main", "active")); await act(async () => f.emit(frame));
  await fireEvent(view.getByLabelText("ブラウザの画面"), "load"); expect(f.controller.ack).toHaveBeenCalledWith("one", 1);
  for (const label of ["ブラウザへ入力するテキスト", "Tab", "⌫", "Enter", "Esc", "↑", "↓", "←", "→"]) expect(view.queryByLabelText(label)).toBeNull();
  expect(view.queryByText("入力")).toBeNull(); expect(view.queryByText("スクロール中")).toBeNull(); expect(view.queryByText("ドラッグ中")).toBeNull();
  await act(async () => f.emitFocus({ editable: true, multiline: false, kind: "text", focusRevision: "focus-1" }));
  const keyboard = view.getByTestId("browser-control-keyboard"); expect(keyboard.props.focusRevision).toBe("focus-1");
  await fireEvent(keyboard, "input", { nativeEvent: { text: "日本語 PRIVATE", focusRevision: "focus-1" } });
  expect(f.controller.input).toHaveBeenCalledWith("one", { type: "text", text: "日本語 PRIVATE", focusRevision: "focus-1" }, 1);
  expect(JSON.stringify(view.toJSON())).not.toContain("日本語 PRIVATE");
  await view.rerender(content("other")); await view.rerender(content("main"));
  expect(view.queryByLabelText("ブラウザの画面")).toBeNull(); expect(view.queryByTestId("browser-control-keyboard")).toBeNull();

});
test("a late Image load after navigation cannot restore old input coordinates or ACK", async () => {
  const f = fixture(); const view = await render(<BrowserControlContext.Provider value={f.controller}><BrowserControlCard request={{ ...card, status: "active" }} /></BrowserControlContext.Provider>);
  // Open from pending, then activate; an active card never auto-opens on remount.
  await view.rerender(<BrowserControlContext.Provider value={f.controller}><BrowserControlCard request={card} /></BrowserControlContext.Provider>);
  await fireEvent.press(view.getByText("ブラウザを開く")); await view.rerender(<BrowserControlContext.Provider value={f.controller}><BrowserControlCard request={{ ...card, status: "active" }} /></BrowserControlContext.Provider>);
  await act(async () => f.emit(frame)); const onLoad = view.getByLabelText("ブラウザの画面").props.onLoad; const onError = view.getByLabelText("ブラウザの画面").props.onError;
  await act(async () => f.emit(null)); await act(async () => onLoad()); expect(f.controller.ack).not.toHaveBeenCalled(); expect(view.queryByLabelText("ブラウザの画面")).toBeNull();
  await act(async () => f.emit({ ...frame, frameId: 2 })); await act(async () => onError()); expect(view.getByLabelText("ブラウザの画面")).toBeTruthy(); expect(f.controller.command).toHaveBeenCalledTimes(1); expect(f.controller.failDisplay).not.toHaveBeenCalled();
});
test("timeline rows preserve chronological order and original conversation data", async () => {
  const f = fixture(); const messages = [{ role: "user" as const, text: "before", clientOperationId: "one", at: "2026-11-26T00:00:00Z" }, { role: "assistant" as const, text: "after", clientOperationId: "two", at: "2026-11-26T00:02:00Z" }]; const original = JSON.stringify(messages);
  const view = await render(<BrowserControlContext.Provider value={f.controller}><VoiceConversationMessages messages={messages} browserInputs={[card]} /></BrowserControlContext.Provider>);
  const json = JSON.stringify(view.toJSON()); expect(json.indexOf("before")).toBeLessThan(json.indexOf("browser-control-one")); expect(json.indexOf("browser-control-one")).toBeLessThan(json.indexOf("after")); expect(JSON.stringify(messages)).toBe(original);
});
test("pausing under another chat closes the view and reopening starts with one tap", async () => {
  const f = fixture(); const content = (status: BrowserControlRequest["status"]) => <BrowserControlContext.Provider value={f.controller}><BrowserControlCard request={{ ...card, status }} /></BrowserControlContext.Provider>;
  const view = await render(content("pending")); await fireEvent.press(view.getByText("ブラウザを開く"));
  await view.rerender(content("active")); await act(async () => f.emit(frame));
  await view.rerender(content("pending")); expect(view.queryByLabelText("ブラウザの画面")).toBeNull();
  expect(f.controller.command).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByText("ブラウザを開く")); expect(f.controller.command).toHaveBeenCalledTimes(2);
  expect(f.controller.watch).toHaveBeenCalledTimes(2); await view.unmount();
});
test("a current image decode failure reports a fixed display failure", async () => {
  const f = fixture(); const content = (status: BrowserControlRequest["status"]) => <BrowserControlContext.Provider value={f.controller}><BrowserControlCard request={{ ...card, status }} /></BrowserControlContext.Provider>;
  const view = await render(content("pending")); await fireEvent.press(view.getByText("ブラウザを開く")); await view.rerender(content("active"));
  await act(async () => f.emit(frame)); await fireEvent(view.getByLabelText("ブラウザの画面"), "error", { nativeEvent: { error: "PRIVATE_ERROR" } });
  expect(f.controller.failDisplay).toHaveBeenCalledWith("one", "render_failed");
  expect(JSON.stringify(view.toJSON())).not.toContain("PRIVATE_ERROR"); await view.unmount();
});

// Exercise the real GestureDetector registry and RNGH event receiver, with only the native bridge mocked.
async function touchFixture() {
  const f = fixture();
  const content = (status: BrowserControlRequest["status"]) => <BrowserControlContext.Provider value={f.controller}><BrowserControlCard request={{ ...card, status }} /></BrowserControlContext.Provider>;
  const view = await render(content("pending")); await fireEvent.press(view.getByText("ブラウザを開く")); await view.rerender(content("active"));
  const pan = () => getByGestureTestId("browser-control-pan-one");
  const tap = () => getByGestureTestId("browser-control-tap-one");
  expect(pan().config.enabled).toBe(false);
  await act(async () => f.emit(frame)); await fireEvent(view.getByLabelText("ブラウザの画面"), "load");
  await fireEvent(view.getByTestId("browser-control-screen"), "layout", { nativeEvent: { layout: { width: 200 } } });
  expect(pan().config).toMatchObject({ enabled: true, minDist: 0, runOnJS: true, needsPointerData: true });
  expect(tap().config).toMatchObject({ enabled: true, maxDist: 5, runOnJS: true });
  const state = async (kind: "pan" | "tap", state: number, oldState: number, x = 50, y = 75) => {
    await act(async () => onGestureHandlerEvent({ handlerTag: (kind === "pan" ? pan() : tap()).handlerTag,
      state, oldState, numberOfPointers: 1, pointerType: PointerType.TOUCH, x, y } as Parameters<typeof onGestureHandlerEvent>[0]));
  };
  const touch = async (eventType: typeof TouchEventType[keyof typeof TouchEventType], allTouches: TouchData[], changedTouches = allTouches, numberOfTouches = allTouches.length) => {
    await act(async () => onGestureHandlerEvent({ handlerTag: pan().handlerTag, state: State.ACTIVE, eventType,
      numberOfTouches, allTouches, changedTouches, pointerType: PointerType.TOUCH }));
  };
  const click = async (panFirst = true, x = 50, y = 75) => {
    await state("tap", State.BEGAN, State.UNDETERMINED, x, y);
    if (panFirst) await state("pan", State.FAILED, State.BEGAN);
    await state("tap", State.ACTIVE, State.BEGAN, x, y); await state("tap", State.END, State.ACTIVE, x, y);
    if (!panFirst) await state("pan", State.FAILED, State.BEGAN);
  };
  return { ...f, view, pan, tap, state, touch, click };
}
const finger = (id: number, x: number, y: number): TouchData => ({ id, x, y, absoluteX: x + 100, absoluteY: y + 200 });
test.each([true, false])("native taps survive stationary pan failure before/after recognition: %s", async (panFirst) => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]); await f.click(panFirst);
  expect(f.controller.input.mock.calls).toEqual([["one", { type: "down", x: 0.25, y: 0.5 }, 1], ["one", { type: "up", x: 0.25, y: 0.5 }, 1]]);
  await f.view.unmount();
});
test("native continuous touch dispatch scrolls and drags, with one mouse release", async () => {
  const f = await touchFixture(); await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 30, 75), finger(1, 70, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 30, 25), finger(1, 70, 25)]); await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 30, 25), finger(1, 70, 25)], undefined, 0);
  await f.state("pan", State.END, State.ACTIVE); await f.click();
  expect(f.controller.input).toHaveBeenCalledTimes(1); expect(f.controller.input.mock.calls[0][1]).toMatchObject({ type: "scroll", x: 0.25, y: 1 / 6, deltaX: 0 }); expect((f.controller.input.mock.calls[0][1] as { deltaY: number }).deltaY).toBeCloseTo(200);
  const tag = f.pan().handlerTag;
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]); await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 150, 75)]);
  await act(async () => f.emit({ ...frame, frameId: 2 })); expect(f.pan().handlerTag).toBe(tag);
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 150, 75)], undefined, 0); await f.state("pan", State.END, State.ACTIVE); await f.click();
  expect(f.controller.input.mock.calls.slice(-3)).toEqual([["one", { type: "down", x: 0.25, y: 0.5 }, 1], ["one", { type: "move", x: 0.75, y: 0.5 }, 1], ["one", { type: "up", x: 0.75, y: 0.5 }, 2]]);
  await f.view.unmount();
});
test("batched two-finger touch scrolls without a mode switch or a click", async () => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 30, 75), finger(1, 70, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 30, 25), finger(1, 70, 25)]);
  expect(f.controller.input.mock.calls[0][1]).toMatchObject({ type: "scroll", x: 0.25, deltaX: 0 }); expect((f.controller.input.mock.calls[0][1] as { deltaY: number }).deltaY).toBeCloseTo(200);
  // Native iOS UP retains the lifted pointer in allTouches.
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 30, 25), finger(1, 70, 25)], [finger(1, 70, 25)], 1);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 100, 100)]); await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 100, 100)], undefined, 0);
  await f.click(); expect(f.controller.input).toHaveBeenCalledTimes(1); await f.view.unmount();
});
test("adding a second finger finishes an existing drag and never resumes it on finger lift", async () => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]); await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 75, 75)]);
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 75, 75), finger(1, 125, 75)], [finger(1, 125, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 75, 25), finger(1, 125, 25)]);
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 75, 25), finger(1, 125, 25)], [finger(1, 125, 25)], 1);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 150, 25)]); await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 150, 25)], undefined, 0); await f.click();
  expect(f.controller.input.mock.calls.map((call) => call[1].type)).toEqual(["down", "move", "up", "scroll"]); await f.view.unmount();
});
test("native cancellation releases drag; frame invalidation cannot restart held fingers", async () => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]); await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 75, 75)]);
  await f.state("pan", State.CANCELLED, State.ACTIVE); await f.state("tap", State.CANCELLED, State.BEGAN);
  expect(f.controller.input.mock.calls.map((call) => call[1].type)).toEqual(["down", "move", "up"]); f.controller.input.mockClear();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]); await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 75, 75)]);
  await act(async () => f.emit(null)); expect(f.pan().config.enabled).toBe(false);
  await act(async () => f.emit({ ...frame, frameId: 2 })); await fireEvent(f.view.getByLabelText("ブラウザの画面"), "load");
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 100, 75)]);
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 100, 75), finger(1, 150, 75)], [finger(1, 150, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 100, 25), finger(1, 150, 25)]); await f.click();
  expect(f.controller.input.mock.calls.map((call) => call[1].type)).toEqual(["down", "move"]); await f.view.unmount();
});
test("a second finger without any movement cannot become a native tap", async () => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]);
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75), finger(1, 100, 75)], [finger(1, 100, 75)]);
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 50, 75), finger(1, 100, 75)], [finger(1, 100, 75)], 1);
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 50, 75)], undefined, 0); await f.click();
  expect(f.controller.input).not.toHaveBeenCalled(); await f.view.unmount();
});
test("a cancelled stationary native tap never clicks", async () => {
  const f = await touchFixture(); await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]);
  await f.state("pan", State.CANCELLED, State.BEGAN); await f.state("tap", State.CANCELLED, State.BEGAN);
  expect(f.controller.input).not.toHaveBeenCalled(); await f.view.unmount();
});

test("pinch zoom is local, keeps its center, and transforms later taps without a mode switch", async () => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75), finger(1, 150, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 0, 75), finger(1, 200, 75)]);
  expect(StyleSheet.flatten(f.view.getByLabelText("ブラウザの画面").props.style)).toMatchObject({ width: 400, height: 300, left: -100, top: -75 });
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 0, 75), finger(1, 200, 75)], undefined, 0);
  await f.state("pan", State.END, State.ACTIVE); await f.click();
  expect(f.controller.input).not.toHaveBeenCalled();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]); await f.click();
  expect(f.controller.input.mock.calls).toEqual([["one", { type: "down", x: 0.375, y: 0.5 }, 1], ["one", { type: "up", x: 0.375, y: 0.5 }, 1]]);
  f.controller.input.mockClear();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75), finger(1, 150, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 75, 75), finger(1, 125, 75)]);
  expect(StyleSheet.flatten(f.view.getByLabelText("ブラウザの画面").props.style)).toMatchObject({ width: 200, height: 150, left: 0, top: 0 });
  expect(f.controller.input).not.toHaveBeenCalled();
  await f.view.unmount();
});

test.each([40, 180, 360])("an incremental outward pinch starts directly with one anchored finger and %spt spacing", async (spacing) => {
  const f = await touchFixture();
  await fireEvent(f.view.getByTestId("browser-control-screen"), "layout", { nativeEvent: { layout: { width: 600, height: 450 } } });
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 30, 75), finger(1, 30 + spacing, 75)]);
  for (const movement of [4, 8, 12, 20, 40]) {
    await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 30, 75), finger(1, 30 + spacing + movement, 75)]);
    expect(f.controller.input).not.toHaveBeenCalled();
  }
  expect(StyleSheet.flatten(f.view.getByLabelText("ブラウザの画面").props.style).width).toBeCloseTo(600 * (spacing + 40) / spacing);
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 30, 75), finger(1, 70 + spacing, 75)], undefined, 0);
  await f.state("pan", State.END, State.ACTIVE); await f.click();
  expect(f.controller.input).not.toHaveBeenCalled(); await f.view.unmount();
});

test("an incremental inward pinch also waits for distance evidence instead of becoming a scroll", async () => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75), finger(1, 150, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 0, 75), finger(1, 200, 75)]);
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 0, 75), finger(1, 200, 75)], undefined, 0); await f.state("pan", State.END, State.ACTIVE);
  await fireEvent(f.view.getByTestId("browser-control-screen"), "layout", { nativeEvent: { layout: { width: 600, height: 450 } } });
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 30, 75), finger(1, 390, 75)]);
  for (const movement of [4, 8, 12, 20, 40]) {
    await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 30, 75), finger(1, 390 - movement, 75)]);
    expect(f.controller.input).not.toHaveBeenCalled();
  }
  expect(StyleSheet.flatten(f.view.getByLabelText("ブラウザの画面").props.style).width).toBeCloseTo(1200 * 320 / 360);
  await f.view.unmount();
});

test("parallel two-finger motion still scrolls with small finger-distance jitter", async () => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 10, 75), finger(1, 190, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 10, 69), finger(1, 191, 69)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 10, 63), finger(1, 190, 63)]);
  expect(f.controller.input.mock.calls.map((call) => call[1].type)).toEqual(["scroll", "scroll"]);
  expect(StyleSheet.flatten(f.view.getByLabelText("ブラウザの画面").props.style).width).toBe(200);
  await f.view.unmount();
});

test("pinch can move the enlarged view, clamps its edges, and does not turn into page scrolling", async () => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75), finger(1, 150, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 0, 75), finger(1, 200, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 400, 75), finger(1, 600, 75)]);
  expect(StyleSheet.flatten(f.view.getByLabelText("ブラウザの画面").props.style)).toMatchObject({ width: 400, left: 0 });
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, -400, 75), finger(1, -200, 75)]);
  expect(StyleSheet.flatten(f.view.getByLabelText("ブラウザの画面").props.style)).toMatchObject({ left: -200 });
  expect(f.controller.input).not.toHaveBeenCalled(); await f.view.unmount();
});

test("parallel two-finger scrolling uses the displayed scale and keyboard layout preserves zoom", async () => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75), finger(1, 150, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 0, 75), finger(1, 200, 75)]);
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 0, 75), finger(1, 200, 75)], undefined, 0); await f.state("pan", State.END, State.ACTIVE);
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75), finger(1, 150, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 50, 50), finger(1, 150, 50)]);
  expect(f.controller.input).toHaveBeenCalledTimes(1);
  expect(f.controller.input.mock.calls[0][1]).toMatchObject({ type: "scroll", deltaX: 0, deltaY: 50 });
  await fireEvent(f.view.getByTestId("browser-control-screen"), "layout", { nativeEvent: { layout: { width: 200, height: 100 } } });
  const imageStyle = StyleSheet.flatten(f.view.getByLabelText("ブラウザの画面").props.style);
  expect(imageStyle.width).toBeCloseTo(800 / 3); expect(imageStyle.height).toBeCloseTo(200);
  await f.view.unmount();
});

test("adding a pinching finger releases a remote drag once and never clicks or scrolls", async () => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]); await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 75, 75)]);
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 75, 75), finger(1, 125, 75)], [finger(1, 125, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 50, 75), finger(1, 150, 75)]);
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 50, 75), finger(1, 150, 75)], [finger(1, 150, 75)], 1);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 100, 75)]);
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 100, 75)], undefined, 0); await f.state("pan", State.END, State.ACTIVE); await f.click();
  expect(f.controller.input.mock.calls.map((call) => call[1].type)).toEqual(["down", "move", "up"]);
  await f.view.unmount();
});

test("fullscreen retains one controller, fences the old display, and maps the fitted image instead of letterboxing", async () => {
  const f = await touchFixture();
  await act(async () => f.emitFocus({ editable: true, multiline: false, kind: "text", focusRevision: "field" }));
  const oldLoad = f.view.getByLabelText("ブラウザの画面").props.onLoad;
  const oldError = f.view.getByLabelText("ブラウザの画面").props.onError;
  const oldInput = f.view.getByTestId("browser-control-keyboard").props.onInput;
  await fireEvent.press(f.view.getByText("全画面"));
  expect(f.view.getByTestId("browser-control-fullscreen").props.presentationStyle).toBe("fullScreen");
  expect(f.view.getAllByLabelText("ブラウザの画面")).toHaveLength(1); expect(f.view.getAllByTestId("browser-control-keyboard")).toHaveLength(1);
  expect(f.controller.watch).toHaveBeenCalledTimes(1); expect(f.controller.command).toHaveBeenCalledTimes(1);
  const ackCount = f.controller.ack.mock.calls.length;
  await act(async () => { oldLoad(); oldError(); oldInput({ nativeEvent: { focusRevision: "field", text: "old private commit" } }); });
  expect(f.controller.ack).toHaveBeenCalledTimes(ackCount); expect(f.controller.failDisplay).not.toHaveBeenCalled(); expect(f.controller.input).not.toHaveBeenCalled();
  await fireEvent(f.view.getByTestId("browser-control-screen"), "layout", { nativeEvent: { layout: { width: 400, height: 600 } } });
  await fireEvent(f.view.getByLabelText("ブラウザの画面"), "load");
  expect(StyleSheet.flatten(f.view.getByLabelText("ブラウザの画面").props.style)).toMatchObject({ width: 400, height: 300, left: 0, top: 150 });
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 100, 50)]); await f.click(true, 100, 50);
  expect(f.controller.input).not.toHaveBeenCalled();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 100, 300)]); await f.click(true, 100, 300);
  expect(f.controller.input.mock.calls).toEqual([["one", { type: "down", x: 0.25, y: 0.5 }, 1], ["one", { type: "up", x: 0.25, y: 0.5 }, 1]]);
  await fireEvent.press(f.view.getByText("インラインに戻す"));
  expect(f.view.queryByTestId("browser-control-fullscreen")).toBeNull(); expect(f.view.getAllByLabelText("ブラウザの画面")).toHaveLength(1);
  expect(f.controller.watch).toHaveBeenCalledTimes(1); expect(f.controller.command).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.view.toJSON())).not.toContain("old private commit");
  await f.view.unmount();
});

test("fullscreen switch releases a held drag and suppresses stale input until its new image loads", async () => {
  const f = await touchFixture();
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]); await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 75, 75)]);
  await fireEvent.press(f.view.getByText("全画面"));
  expect(f.controller.input.mock.calls.map((call) => call[1].type)).toEqual(["down", "move", "up"]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 100, 75)]); await f.click();
  expect(f.controller.input).toHaveBeenCalledTimes(3); await f.view.unmount();
});

test("browser typing is scoped to the original conversation without exposing focus metadata", async () => {
  const f = fixture(); f.controller.typingRequestId = "one";
  function Composer({ selected }: { selected: string }) {
    const requests = useBrowserControlRequests({ kind: "orchestrator", orchestratorId: selected });
    return <Text>{useBrowserControlTyping(requests) ? "hidden" : "composer"}</Text>;
  }
  const content = (selected: string) => <BrowserControlContext.Provider value={f.controller}><Composer selected={selected} /></BrowserControlContext.Provider>;
  const view = await render(content("main")); expect(view.getByText("hidden")).toBeTruthy();
  await view.rerender(content("other")); expect(view.getByText("composer")).toBeTruthy();
  f.controller.typingRequestId = null; await view.rerender(content("main")); expect(view.getByText("composer")).toBeTruthy();
  await view.unmount();
});

test("focus changes and clearing discard delayed native input while keys use the current focus token", async () => {
  const f = await touchFixture();
  await act(async () => f.emitFocus({ editable: true, multiline: false, kind: "password", focusRevision: "field-1" }));
  const keyboard = f.view.getByTestId("browser-control-keyboard");
  const oldInput = keyboard.props.onInput;
  expect(keyboard.props.kind).toBe("password");
  await act(async () => f.emitFocus({ editable: true, multiline: true, kind: "text", focusRevision: "field-2" }));
  await act(async () => oldInput({ nativeEvent: { text: "late private commit", focusRevision: "field-1" } }));
  expect(f.controller.input).not.toHaveBeenCalled();
  for (const key of ["Backspace", "Enter"]) await fireEvent(f.view.getByTestId("browser-control-keyboard"), "input", { nativeEvent: { key, focusRevision: "field-2" } });
  expect(f.controller.input.mock.calls.map(([, input]) => input)).toEqual([{ type: "key", key: "Backspace", focusRevision: "field-2" }, { type: "key", key: "Enter", focusRevision: "field-2" }]);
  await act(async () => f.emit(null));
  expect(f.view.getByTestId("browser-control-keyboard").props.focusRevision).toBeNull();
  await act(async () => oldInput({ nativeEvent: { text: "late private commit", focusRevision: "field-2" } }));
  expect(f.controller.input).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.view.toJSON())).not.toContain("late private commit");
  await f.view.unmount();
});

test("finishing retains the view until queued input and the finish command settle", async () => {
  const f = await touchFixture(); let finish: (() => void) | undefined;
  f.controller.command.mockImplementation(async (_id: string, action: string) => { if (action === "finish") await new Promise<void>((resolve) => { finish = resolve; }); });
  await fireEvent.press(f.view.getByText("操作を完了"));
  expect(f.view.getByLabelText("ブラウザの画面")).toBeTruthy();
  expect(f.controller.watch).toHaveBeenCalledTimes(1);
  await act(async () => finish?.());
  expect(f.view.queryByLabelText("ブラウザの画面")).toBeNull();
  await f.view.unmount();
});

test("a reconnectable card shows the uncertainty warning before reopening", async () => {
  const f = fixture(); const view = await render(<BrowserControlContext.Provider value={f.controller}><BrowserControlCard request={{ ...card, inputStatusUnknown: true }} /></BrowserControlContext.Provider>);
  expect(view.getByText("接続が切れました。前の操作結果を確認してから再開してください。")).toBeTruthy();
  expect(view.getByText("ブラウザを開く")).toBeTruthy();
  await view.unmount();
});


test("the real hook drains private typing and finishes before the card releases its viewer", async () => {
  const previous = AppState.currentState; AppState.currentState = "active";
  jest.spyOn(AppState, "addEventListener").mockImplementation(() => ({ remove: jest.fn() }));
  const handlers = new Map<string, (message: any) => void>();
  let finishInput: (() => void) | undefined;
  const request = jest.fn(async (message: any) => {
    const action = message.payload.action;
    if (action === "input") await new Promise<void>((resolve) => { finishInput = resolve; });
    return { channel: "control", op: "browser.control.command.result", payload: { status: action === "finish" ? "completed" : "active" } };
  });
  const send = jest.fn();
  const manager = { request, send, connect: jest.fn(async () => {}), getSnapshot: () => ({ connected: true, generation: 1, connectionOptionsGeneration: 1 }),
    subscribe: ({ op }: { op: string }, listener: (message: any) => void) => { handlers.set(op, listener); return () => handlers.delete(op); },
    subscribeSnapshot: () => () => {},
  } as unknown as RunnerWebSocketManager;
  function Chat() { const controller = useBrowserControl(manager); return <BrowserControlContext.Provider value={controller}>{controller.requests.map((entry) => <BrowserControlCard key={entry.requestId} request={entry} />)}</BrowserControlContext.Provider>; }
  const view = await render(<Chat />);
  const emit = (op: string, payload: unknown) => handlers.get(`browser.control.${op}`)?.({ channel: "control", op: `browser.control.${op}`, payload });
  await act(async () => emit("request", card));
  await fireEvent.press(view.getByText("ブラウザを開く"));
  const controlId = request.mock.calls[0][0].payload.controlId;
  await act(async () => emit("frame", { requestId: "one", controlId, ...frame }));
  await fireEvent(view.getByLabelText("ブラウザの画面"), "load");
  await act(async () => emit("focus", { requestId: "one", controlId, editable: true, multiline: false, kind: "text", focusRevision: "field-1" }));
  await fireEvent(view.getByTestId("browser-control-keyboard"), "input", { nativeEvent: { text: "private queued text", focusRevision: "field-1" } });
  await fireEvent.press(view.getByText("操作を完了"));
  expect(request.mock.calls.map(([message]) => message.payload.action)).toEqual(["start", "input"]);
  expect(view.getByLabelText("ブラウザの画面")).toBeTruthy();
  await act(async () => finishInput?.());
  expect(request.mock.calls.map(([message]) => message.payload.action)).toEqual(["start", "input", "finish"]);
  expect(view.queryByLabelText("ブラウザの画面")).toBeNull();
  expect(view.getByText("ブラウザの操作を終了しました")).toBeTruthy();
  expect(send.mock.calls.some(([message]) => message.payload?.action === "pause")).toBe(false);
  expect(JSON.stringify(view.toJSON())).not.toContain("private queued text");
  await view.unmount(); AppState.currentState = previous;
});


test("an old finish result cannot close a newly reopened browser view", async () => {
  const f = fixture();
  const content = (status: BrowserControlRequest["status"]) => <BrowserControlContext.Provider value={f.controller}><BrowserControlCard request={{ ...card, status }} /></BrowserControlContext.Provider>;
  const view = await render(content("pending")); await fireEvent.press(view.getByText("ブラウザを開く")); await view.rerender(content("active"));
  await act(async () => f.emit(frame)); await fireEvent(view.getByLabelText("ブラウザの画面"), "load");
  let finish: (() => void) | undefined;
  f.controller.command.mockImplementation(async (_id: string, action: string) => { if (action === "finish") await new Promise<void>((resolve) => { finish = resolve; }); });
  await fireEvent.press(view.getByText("操作を完了"));
  await fireEvent.press(view.getByText("閉じる")); await view.rerender(content("pending"));
  await fireEvent.press(view.getByText("ブラウザを開く")); await view.rerender(content("active"));
  await act(async () => f.emit({ ...frame, frameId: 2 })); await fireEvent(view.getByLabelText("ブラウザの画面"), "load");
  await act(async () => finish?.());
  expect(view.getByLabelText("ブラウザの画面")).toBeTruthy();
  expect(f.controller.watch).toHaveBeenCalledTimes(2);
  await view.unmount();
});
