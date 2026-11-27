import { State, PointerType, type TouchData } from "react-native-gesture-handler";
const { getByGestureTestId }: typeof import("react-native-gesture-handler/lib/typescript/jestUtils") = require("react-native-gesture-handler/lib/commonjs/jestUtils");
const { onGestureHandlerEvent }: typeof import("react-native-gesture-handler/lib/typescript/handlers/gestures/eventReceiver") = require("react-native-gesture-handler/lib/commonjs/handlers/gestures/eventReceiver");
const { TouchEventType }: typeof import("react-native-gesture-handler/lib/typescript/TouchEventType") = require("react-native-gesture-handler/lib/commonjs/TouchEventType");
import { act, fireEvent, render } from "@testing-library/react-native";
import { BrowserControlContext, useBrowserControlRequests } from "../contexts/BrowserControlContext";
import type { BrowserControlFrame, BrowserControlInput, BrowserControlRequest } from "../hooks/useBrowserControl";
import { BrowserControlCard } from "./BrowserControlCard";
import { VoiceConversationMessages } from "./VoiceConversationMessages";
jest.mock("./MarkdownText", () => ({ MarkdownText: ({ content }: { content: string }) => { const { Text } = require("react-native"); return <Text>{content}</Text>; } }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("./AnswerLearningDetails", () => ({ AnswerLearningDetails: () => null }));
jest.mock("./VoiceTurnTrace", () => ({ VoiceTurnTrace: () => null }));
const card: BrowserControlRequest = { requestId: "one", origin: "https://example.com", label: "Control", createdAt: "2026-11-26T00:01:00Z", status: "pending", target: { kind: "orchestrator", orchestratorId: "main" } };
const frame = { frameId: 1, data: "aW1hZ2U=", width: 800, height: 600 };
function fixture() {
  let listener: ((frame: BrowserControlFrame | null) => void) | undefined;
  const controller = { requests: [card], command: jest.fn(async () => {}), input: jest.fn(async (_requestId: string, _input: BrowserControlInput, _frameId: number) => {}), ack: jest.fn(), failDisplay: jest.fn(), watch: jest.fn((_id: string, handler: (frame: BrowserControlFrame | null) => void) => { listener = handler; return () => { handler(null); }; }) };
  return { controller, emit: (next: BrowserControlFrame | null) => listener?.(next) };
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
  await fireEvent.changeText(view.getByLabelText("ブラウザへ入力するテキスト"), "dummy"); await fireEvent.press(view.getByText("入力"));
  expect(f.controller.input).toHaveBeenLastCalledWith("one", { type: "text", text: "dummy" }, 2);
  await act(async () => f.emit({ ...frame, frameId: 3, width: 1600, height: 1200 }));
  expect(f.controller.ack).toHaveBeenCalledTimes(2); expect(view.getByLabelText("Tab").props.accessibilityState.disabled).toBe(true);
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
test("opening is explicit, visible text uses dedicated input, and leaving clears both image and draft", async () => {
  const f = fixture();
  function Chat({ selected, status = "pending" }: { selected: string; status?: BrowserControlRequest["status"] }) { return <>{useBrowserControlRequests({ kind: "orchestrator", orchestratorId: selected }).map((r) => <BrowserControlCard key={r.requestId} request={{ ...r, status }} />)}</>; }
  const content = (selected: string, status: BrowserControlRequest["status"] = "pending") => <BrowserControlContext.Provider value={f.controller}><Chat selected={selected} status={status} /></BrowserControlContext.Provider>;
  const view = await render(content("main")); expect(f.controller.command).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText("ブラウザを開く")); expect(view.queryByText("操作を開始")).toBeNull(); expect(f.controller.watch).toHaveBeenCalledTimes(1); expect(f.controller.command).toHaveBeenCalledWith("one", "start");
  await view.rerender(content("main", "active")); await act(async () => f.emit(frame));
  await fireEvent(view.getByLabelText("ブラウザの画面"), "load"); expect(f.controller.ack).toHaveBeenCalledWith("one", 1);
  const input = view.getByLabelText("ブラウザへ入力するテキスト"); expect(input.props.secureTextEntry).not.toBe(true);
  await fireEvent.changeText(input, "日本語 PRIVATE"); await fireEvent.press(view.getByText("入力")); expect(f.controller.input).toHaveBeenCalledWith("one", { type: "text", text: "日本語 PRIVATE" }, 1);
  await fireEvent.changeText(view.getByLabelText("ブラウザへ入力するテキスト"), "discard me"); await view.rerender(content("other")); await view.rerender(content("main"));
  expect(view.queryByLabelText("ブラウザの画面")).toBeNull(); expect(view.queryByLabelText("ブラウザへ入力するテキスト")).toBeNull(); expect(JSON.stringify(view.toJSON())).not.toContain("discard me");
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
  const click = async (panFirst = true) => {
    await state("tap", State.BEGAN, State.UNDETERMINED);
    if (panFirst) await state("pan", State.FAILED, State.BEGAN);
    await state("tap", State.ACTIVE, State.BEGAN); await state("tap", State.END, State.ACTIVE);
    if (!panFirst) await state("pan", State.FAILED, State.BEGAN);
  };
  return { ...f, view, pan, tap, state, touch, click };
}
const finger = (id: number, x: number, y: number): TouchData => ({ id, x, y, absoluteX: x + 100, absoluteY: y + 200 });
test.each([true, false])("native taps survive stationary pan failure before/after recognition: %s", async (panFirst) => {
  const f = await touchFixture(); await fireEvent.changeText(f.view.getByLabelText("ブラウザへ入力するテキスト"), "dummy text");
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]); await f.click(panFirst);
  expect(f.controller.input.mock.calls).toEqual([["one", { type: "text", text: "dummy text" }, 1], ["one", { type: "down", x: 0.25, y: 0.5 }, 1], ["one", { type: "up", x: 0.25, y: 0.5 }, 1]]);
  await f.view.unmount();
});
test("native continuous touch dispatch scrolls and drags, with one mouse release", async () => {
  const f = await touchFixture(); await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 50, 25)]); await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 50, 25)], undefined, 0);
  await f.state("pan", State.END, State.ACTIVE); await f.click();
  expect(f.controller.input).toHaveBeenCalledTimes(1); expect(f.controller.input.mock.calls[0][1]).toMatchObject({ type: "scroll", x: 0.25, y: 1 / 6, deltaX: 0 }); expect((f.controller.input.mock.calls[0][1] as { deltaY: number }).deltaY).toBeCloseTo(200);
  await fireEvent.press(f.view.getByText("スクロール中")); const tag = f.pan().handlerTag;
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]); await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 150, 75)]);
  await act(async () => f.emit({ ...frame, frameId: 2 })); expect(f.pan().handlerTag).toBe(tag);
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 150, 75)], undefined, 0); await f.state("pan", State.END, State.ACTIVE); await f.click();
  expect(f.controller.input.mock.calls.slice(-3)).toEqual([["one", { type: "down", x: 0.25, y: 0.5 }, 1], ["one", { type: "move", x: 0.75, y: 0.5 }, 1], ["one", { type: "up", x: 0.75, y: 0.5 }, 2]]);
  await f.view.unmount();
});
test.each([false, true])("batched two-finger touch scrolls in either mode without a click: drag=%s", async (drag) => {
  const f = await touchFixture(); if (drag) await fireEvent.press(f.view.getByText("スクロール中"));
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 30, 75), finger(1, 70, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 30, 25), finger(1, 70, 25)]);
  expect(f.controller.input.mock.calls[0][1]).toMatchObject({ type: "scroll", x: 0.25, deltaX: 0 }); expect((f.controller.input.mock.calls[0][1] as { deltaY: number }).deltaY).toBeCloseTo(200);
  // Native iOS UP retains the lifted pointer in allTouches.
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 30, 25), finger(1, 70, 25)], [finger(1, 70, 25)], 1);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 100, 100)]); await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 100, 100)], undefined, 0);
  await f.click(); expect(f.controller.input).toHaveBeenCalledTimes(1); await f.view.unmount();
});
test("adding a second finger finishes an existing drag and never resumes it on finger lift", async () => {
  const f = await touchFixture(); await fireEvent.press(f.view.getByText("スクロール中"));
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 50, 75)]); await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 75, 75)]);
  await f.touch(TouchEventType.TOUCHES_DOWN, [finger(0, 75, 75), finger(1, 125, 75)], [finger(1, 125, 75)]);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 75, 25), finger(1, 125, 25)]);
  await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 75, 25), finger(1, 125, 25)], [finger(1, 125, 25)], 1);
  await f.touch(TouchEventType.TOUCHES_MOVE, [finger(0, 150, 25)]); await f.touch(TouchEventType.TOUCHES_UP, [finger(0, 150, 25)], undefined, 0); await f.click();
  expect(f.controller.input.mock.calls.map((call) => call[1].type)).toEqual(["down", "move", "up", "scroll"]); await f.view.unmount();
});
test("native cancellation releases drag; frame invalidation cannot restart held fingers", async () => {
  const f = await touchFixture(); await fireEvent.press(f.view.getByText("スクロール中"));
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
