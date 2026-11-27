import { PanResponder } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { BrowserControlContext, useBrowserControlRequests } from "../contexts/BrowserControlContext";
import type { BrowserControlFrame, BrowserControlRequest } from "../hooks/useBrowserControl";
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
  const controller = { requests: [card], command: jest.fn(async () => {}), input: jest.fn(async () => {}), ack: jest.fn(), watch: jest.fn((_id: string, handler: (frame: BrowserControlFrame | null) => void) => { listener = handler; return () => { handler(null); }; }) };
  return { controller, emit: (next: BrowserControlFrame | null) => listener?.(next) };
}
test("opening is explicit, visible text uses dedicated input, and leaving clears both image and draft", async () => {
  const f = fixture();
  function Chat({ selected, status = "pending" }: { selected: string; status?: BrowserControlRequest["status"] }) { return <>{useBrowserControlRequests({ kind: "orchestrator", orchestratorId: selected }).map((r) => <BrowserControlCard key={r.requestId} request={{ ...r, status }} />)}</>; }
  const content = (selected: string, status: BrowserControlRequest["status"] = "pending") => <BrowserControlContext.Provider value={f.controller}><Chat selected={selected} status={status} /></BrowserControlContext.Provider>;
  const view = await render(content("main")); expect(f.controller.command).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText("ブラウザを開く")); await fireEvent.press(view.getByText("操作を開始")); expect(f.controller.command).toHaveBeenCalledWith("one", "start");
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
  await act(async () => f.emit({ ...frame, frameId: 2 })); await act(async () => onError()); expect(view.getByLabelText("ブラウザの画面")).toBeTruthy(); expect(f.controller.command).not.toHaveBeenCalled();
});
test("timeline rows preserve chronological order and original conversation data", async () => {
  const f = fixture(); const messages = [{ role: "user" as const, text: "before", clientOperationId: "one", at: "2026-11-26T00:00:00Z" }, { role: "assistant" as const, text: "after", clientOperationId: "two", at: "2026-11-26T00:02:00Z" }]; const original = JSON.stringify(messages);
  const view = await render(<BrowserControlContext.Provider value={f.controller}><VoiceConversationMessages messages={messages} browserInputs={[card]} /></BrowserControlContext.Provider>);
  const json = JSON.stringify(view.toJSON()); expect(json.indexOf("before")).toBeLessThan(json.indexOf("browser-control-one")); expect(json.indexOf("browser-control-one")).toBeLessThan(json.indexOf("after")); expect(JSON.stringify(messages)).toBe(original);
});

test("scaled touch coordinates preserve text-before-click and drag/scroll ordering", async () => {
  const spy = jest.spyOn(PanResponder, "create").mockImplementation((config) => ({ panHandlers: { onResponderGrant: config.onPanResponderGrant, onResponderMove: config.onPanResponderMove, onResponderRelease: config.onPanResponderRelease } } as never));
  const f = fixture(); const content = (status: BrowserControlRequest["status"]) => <BrowserControlContext.Provider value={f.controller}><BrowserControlCard request={{ ...card, status }} /></BrowserControlContext.Provider>;
  const view = await render(content("pending")); await fireEvent.press(view.getByText("ブラウザを開く")); await view.rerender(content("active")); await act(async () => f.emit(frame));
  await fireEvent(view.getByLabelText("ブラウザの画面"), "load"); const screen = view.getByTestId("browser-control-screen");
  await fireEvent(screen, "layout", { nativeEvent: { layout: { width: 200 } } });
  await fireEvent.changeText(view.getByLabelText("ブラウザへ入力するテキスト"), "dummy text");
  const touch = (x: number, y: number) => ({ nativeEvent: { locationX: x, locationY: y } });
  await fireEvent(screen, "responderGrant", touch(50, 75)); await fireEvent(screen, "responderRelease", touch(50, 75));
  expect(f.controller.input.mock.calls.slice(0, 3)).toEqual([["one", { type: "text", text: "dummy text" }, 1], ["one", { type: "down", x: 0.25, y: 0.5 }, 1], ["one", { type: "up", x: 0.25, y: 0.5 }, 1]]);
  await fireEvent.press(view.getByText("スクロール中"));
  await fireEvent(screen, "responderGrant", touch(50, 75)); await fireEvent(screen, "responderMove", touch(150, 75)); await fireEvent(screen, "responderRelease", touch(150, 75));
  expect(f.controller.input.mock.calls.slice(-3)).toEqual([["one", { type: "down", x: 0.25, y: 0.5 }, 1], ["one", { type: "move", x: 0.75, y: 0.5 }, 1], ["one", { type: "up", x: 0.75, y: 0.5 }, 1]]);
  await view.unmount(); spy.mockRestore();
});
