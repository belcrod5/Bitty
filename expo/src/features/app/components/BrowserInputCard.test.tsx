import { fireEvent, render } from "@testing-library/react-native";
import { BrowserInputContext, useBrowserInputRequests } from "../contexts/BrowserInputContext";
import type { BrowserSecretInputRequest } from "../hooks/useBrowserSecretInput";
import { BrowserInputCard } from "./BrowserInputCard";
import { VoiceConversationMessages } from "./VoiceConversationMessages";

jest.mock("./MarkdownText", () => ({ MarkdownText: ({ content }: { content: string }) => { const { Text } = require("react-native"); return <Text>{content}</Text>; } }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("./AnswerLearningDetails", () => ({ AnswerLearningDetails: () => null }));
jest.mock("./VoiceTurnTrace", () => ({ VoiceTurnTrace: () => null }));
const form: BrowserSecretInputRequest = { requestId: "request", destinationOrigin: "https://payments.example", topOrigin: "https://shop.example", label: "Card number", createdAt: "2026-11-26T00:01:00Z", status: "pending",
  target: { kind: "orchestrator", orchestratorId: "main" } };

test("unmasked card draft survives chat switches, then its dedicated submit removes the value", async () => {
  const drafts = new Map<string, string>(); const submit = jest.fn(async () => {});
  function Chat({ selected }: { selected: string }) {
    const cards = useBrowserInputRequests({ kind: "orchestrator", orchestratorId: selected });
    return <>{cards.map((request) => <BrowserInputCard key={request.requestId} request={request} />)}</>;
  }
  const controller = { requests: [form], drafts, submit, cancel: jest.fn() };
  const view = await render(<BrowserInputContext.Provider value={controller}><Chat selected="main" /></BrowserInputContext.Provider>);
  expect(view.getByText(form.destinationOrigin)).toBeTruthy();
  expect(view.getByLabelText("ブラウザへの入力内容").props.secureTextEntry).not.toBe(true);
  await fireEvent.changeText(view.getByLabelText("ブラウザへの入力内容"), "  exact private value  ");
  await view.rerender(<BrowserInputContext.Provider value={controller}><Chat selected="other" /></BrowserInputContext.Provider>);
  expect(view.queryByLabelText("ブラウザへの入力内容")).toBeNull();
  await view.rerender(<BrowserInputContext.Provider value={controller}><Chat selected="main" /></BrowserInputContext.Provider>);
  expect(view.getByLabelText("ブラウザへの入力内容").props.value).toBe("  exact private value  ");
  await fireEvent.press(view.getByText("ブラウザへ入力"));
  expect(submit).toHaveBeenCalledWith("request", "  exact private value  ");
  await view.rerender(<BrowserInputContext.Provider value={{ ...controller, requests: [{ ...form, status: "completed" }] }}><Chat selected="main" /></BrowserInputContext.Provider>);
  expect(view.queryByLabelText("ブラウザへの入力内容")).toBeNull();
  expect(view.getByText("ブラウザへの入力が完了しました")).toBeTruthy();
});

test("orchestrator transcript places the card between timestamped messages without changing original messages", async () => {
  const messages = [{ role: "user" as const, text: "before", clientOperationId: "one", at: "2026-11-26T00:00:00Z" },
    { role: "assistant" as const, text: "after", clientOperationId: "two", at: "2026-11-26T00:02:00Z" }];
  const original = JSON.stringify(messages);
  const view = await render(<BrowserInputContext.Provider value={{ requests: [form], drafts: new Map(), submit: jest.fn(), cancel: jest.fn() }}>
    <VoiceConversationMessages messages={messages} browserInputs={[form]} />
  </BrowserInputContext.Provider>);
  const serialized = JSON.stringify(view.toJSON());
  expect(serialized.indexOf("before")).toBeLessThan(serialized.indexOf("browser-input-request"));
  expect(serialized.indexOf("browser-input-request")).toBeLessThan(serialized.indexOf("after"));
  expect(JSON.stringify(messages)).toBe(original);
});
