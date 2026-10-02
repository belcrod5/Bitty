import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import type { UserInputRequest, UserInputResponse } from "../../codex/userInput";
import { useUserInputRequestController } from "./useUserInputRequestController";

const originalAppState = AppState.currentState;
const question = (): UserInputRequest => ({ requestId: "q1", threadId: "visible", startedAtMs: Date.now(), questions: [] });
beforeEach(() => { AppState.currentState = "active"; });
afterEach(() => { AppState.currentState = originalAppState; });

test("only the current chat can show a question; switching chats dismisses without answering", async () => {
  const view = await renderHook<ReturnType<typeof useUserInputRequestController>, { sessionId: string }>(
    ({ sessionId }) => useUserInputRequestController(sessionId), { initialProps: { sessionId: "visible" } });
  await expect(view.result.current.ask({ ...question(), threadId: "other" })).resolves.toBeNull();
  let response!: Promise<UserInputResponse | null>;
  await act(async () => { response = view.result.current.ask(question()); });
  expect(view.result.current.request?.requestId).toBe("q1");
  await view.rerender({ sessionId: "other" });
  await expect(response).resolves.toBeNull();
  expect(view.result.current.request).toBeNull();
});

test("skip returns empty answers; background requests are ignored; native resolution closes the form", async () => {
  const view = await renderHook(() => useUserInputRequestController("visible"));
  let response!: Promise<UserInputResponse | null>;
  await act(async () => { response = view.result.current.ask(question()); });
  await act(async () => { view.result.current.decide({ answers: {} }); });
  await expect(response).resolves.toEqual({ answers: {} });
  AppState.currentState = "background";
  await expect(view.result.current.ask(question())).resolves.toBeNull();
  AppState.currentState = "active";
  await act(async () => { response = view.result.current.ask(question()); });
  await act(async () => { view.result.current.resolved(question()); });
  await expect(response).resolves.toBeNull();
  expect(view.result.current.request).toBeNull();
});

test("expiry and concurrent questions are ignored and unmount releases the pending form", async () => {
  const view = await renderHook(() => useUserInputRequestController("visible"));
  await expect(view.result.current.ask({ ...question(), startedAtMs: Date.now() - 60_001 })).resolves.toBeNull();
  let response!: Promise<UserInputResponse | null>;
  await act(async () => { response = view.result.current.ask(question()); });
  await expect(view.result.current.ask({ ...question(), requestId: "q2" })).resolves.toBeNull();
  await view.unmount();
  await expect(response).resolves.toBeNull();
});
