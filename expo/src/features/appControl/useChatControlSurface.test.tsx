import { act, renderHook } from "@testing-library/react-native";
import { useChatControlSurface } from "./useChatControlSurface";
import { getVoiceControl, type VoiceTarget } from "./voiceControl";
import type { RunnerWebSocketManager } from "../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../runnerWs/types";

let mockManager: RunnerWebSocketManager;
jest.mock("../runnerWs/RunnerWebSocketContext", () => ({ useRunnerWebSocketManager: () => mockManager }));
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
function fixture() {
  const sent: RunnerWsMessage[] = [];
  mockManager = {
    getSnapshot: () => ({ connected: true, appState: "active", generation: 1, clientInstanceId: "phone" }),
    subscribeSnapshot: () => () => {}, subscribe: () => () => {},
    request: async () => ({ op: "app.control.register.result", payload: { version: 1, connectionGeneration: "connection" } }),
    send: (message: RunnerWsMessage) => { sent.push(message); },
  } as unknown as RunnerWebSocketManager;
  const control = getVoiceControl(mockManager);
  return { sent, control, stop: control.start() };
}

test("conversation registration follows the stable parent through rerenders, resolution and microphone absence", async () => {
  const f = fixture();
  const draft: VoiceTarget = { kind: "session", sessionRef: { backendId: "codex", nativeSessionId: null }, cwd: "/repo" };
  const view = await renderHook(({ target }: { target: VoiceTarget | null }) => useChatControlSurface(target, "popup"), { initialProps: { target: draft } });
  const first = f.control.origin("popup", draft)!;
  expect(first.chatId).toBeTruthy();
  await view.rerender({ target: { ...draft, sessionRef: { ...draft.sessionRef } } });
  expect(f.control.origin("popup", draft)?.chatGeneration).toBe(first.chatGeneration);
  const resolved: VoiceTarget = { ...draft, sessionRef: { ...draft.sessionRef, nativeSessionId: "native" } };
  await view.rerender({ target: resolved });
  // Capture immediately, without advancing the periodic publisher.
  const origin = f.control.origin("popup", resolved)!;
  expect(origin.chatGeneration).toBe(first.chatGeneration);
  const published = f.sent.at(-1)?.payload as { chats: { generation: number; target: VoiceTarget }[]; surfaces: unknown[] };
  expect(published.chats[0]).toMatchObject({ generation: origin.chatGeneration, target: resolved });
  expect(published.surfaces).toEqual([]);
  expect(f.control.matchesChatOrigin(origin)).toBe(true);
  await view.unmount();
  expect(f.control.matchesChatOrigin(origin)).toBe(false);
  f.stop();
});

test("real hide or target switch cannot revive an earlier conversation lease", async () => {
  const f = fixture();
  const target: VoiceTarget = { kind: "orchestrator", orchestratorId: "main" };
  const view = await renderHook(({ selected }: { selected: VoiceTarget | null }) => useChatControlSurface(selected), { initialProps: { selected: target } });
  const origin = f.control.origin(undefined, target)!;
  await view.rerender({ selected: null });
  expect(f.control.matchesChatOrigin(origin)).toBe(false);
  await view.rerender({ selected: target });
  expect(f.control.matchesChatOrigin(origin)).toBe(false);
  await act(async () => { jest.advanceTimersByTime(50); });
  expect(f.control.origin(undefined, target)?.chatGeneration).not.toBe(origin.chatGeneration);
  await view.unmount(); f.stop();
});
