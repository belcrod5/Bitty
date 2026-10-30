import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useConsultationSpeech } from "./useConsultationSpeech";
import type { VoiceConversationPlayback } from "../screens/VoiceConversationScreen";

let mockAudioSequence = 0;
jest.mock("expo-crypto", () => ({ randomUUID: () => `unique-audio-${++mockAudioSequence}` }));

const owner = { id: "owner-a", name: "A", icon: "", ttsProvider: "provider-a", voiceId: "voice-a" };
const a = { id: "a", text: "Aの確定した発言", owner };
const b = { id: "b", text: "Bの確定した発言", owner: { ...owner, id: "owner-b", ttsProvider: "provider-b", voiceId: "voice-b" } };
function player() {
  const state = { messageId: "", active: false };
  const playback: VoiceConversationPlayback = {
    synthesizeSpeechStream: jest.fn(async (_text, target) => { state.messageId = target.messageId; state.active = true; }),
    stopTtsPlayback: jest.fn(async (options) => { if (options?.expectedMessageId === state.messageId) state.active = false; }),
    getPlaybackState: () => ({ ...state }), isTtsPlaybackActive: false, ttsUiStatus: "idle",
  };
  return { state, playback };
}

test("serializes speakers until actual audio completion, even after synthesis resolves with stale idle props", async () => {
  const { state, playback } = player();
  const { result, rerender } = await renderHook(({ p }: { p: VoiceConversationPlayback }) => useConsultationSpeech("room", p), { initialProps: { p: playback } });
  await act(() => { result.current.enqueue(a); result.current.enqueue(b); });
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(1));
  expect(playback.synthesizeSpeechStream).toHaveBeenCalledWith(a.text, expect.objectContaining({
    scope: "voice", orchestratorId: owner.id, ttsProvider: "provider-a", voiceId: "voice-a", messageId: expect.stringContaining(":a:"),
  }));
  expect(result.current.activeMessageId).toBe("a");
  await rerender({ p: { ...playback } });
  expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(1);
  state.active = false;
  await rerender({ p: { ...playback } });
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(2));
  expect(playback.synthesizeSpeechStream).toHaveBeenLastCalledWith(b.text, expect.objectContaining({ orchestratorId: "owner-b", voiceId: "voice-b" }));
});

test("waits for another surface, survives synthesis failure, and does not stop somebody else's playback", async () => {
  const { state, playback } = player(); state.messageId = "ordinary"; state.active = true;
  const { result, rerender, unmount } = await renderHook(({ p }: { p: VoiceConversationPlayback }) => useConsultationSpeech("room", p), {
    initialProps: { p: { ...playback, isTtsPlaybackActive: true } },
  });
  await act(() => { result.current.enqueue(a); result.current.enqueue(b); });
  expect(playback.synthesizeSpeechStream).not.toHaveBeenCalled();
  (playback.synthesizeSpeechStream as jest.Mock).mockRejectedValueOnce(new Error("fake synth failure"));
  state.active = false;
  await rerender({ p: { ...playback, isTtsPlaybackActive: false } });
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(2));
  state.messageId = "other-screen"; state.active = true;
  await unmount();
  expect(playback.stopTtsPlayback).not.toHaveBeenCalledWith(expect.objectContaining({ expectedMessageId: "other-screen" }));
  expect(state.active).toBe(true);
});

test("manual replay replaces this queue, uses a unique playback identity and cleans up on room change", async () => {
  const { state, playback } = player();
  const { result, rerender } = await renderHook(({ room, p }: { room: string; p: VoiceConversationPlayback }) => useConsultationSpeech(room, p), { initialProps: { room: "room-one", p: playback } });
  await act(() => { result.current.enqueue(a); result.current.enqueue(b); });
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(1));
  const oldId = state.messageId;
  await act(() => result.current.read(a));
  await rerender({ room: "room-one", p: { ...playback } });
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(2));
  expect(state.messageId).not.toBe(oldId);
  expect(playback.stopTtsPlayback).toHaveBeenCalledWith(expect.objectContaining({ expectedMessageId: oldId }));
  const replayId = state.messageId;
  await rerender({ room: "room-two", p: { ...playback } });
  expect(playback.stopTtsPlayback).toHaveBeenCalledWith(expect.objectContaining({ expectedMessageId: replayId }));
  expect(result.current.pending).toBe(false);
  expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(2);
});

test("error status releases a stuck active player through its existing stop path and allows the next speaker", async () => {
  const { state, playback } = player();
  const { result, rerender } = await renderHook(({ p }: { p: VoiceConversationPlayback }) => useConsultationSpeech("room", p), { initialProps: { p: playback } });
  await act(() => { result.current.enqueue(a); result.current.enqueue(b); });
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(1));
  const failedId = state.messageId;
  await rerender({ p: { ...playback, ttsUiStatus: "error" as const } });
  expect(playback.stopTtsPlayback).toHaveBeenCalledWith(expect.objectContaining({ expectedMessageId: failedId }));
  await rerender({ p: { ...playback } });
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(2));
});

test("a late old synthesis callback cannot cancel a manual replay or a new mount reading the same history", async () => {
  const { state, playback } = player(); let release!: () => void;
  (playback.synthesizeSpeechStream as jest.Mock).mockImplementationOnce((_text, target) => {
    state.messageId = target.messageId; state.active = true;
    return new Promise<void>((resolve) => { release = resolve; });
  });
  const first = await renderHook(() => useConsultationSpeech("room", playback));
  await act(() => first.result.current.read(a));
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(1));
  const previousId = state.messageId;
  await first.unmount();
  const next = await renderHook(() => useConsultationSpeech("room", playback));
  await act(() => next.result.current.read(a));
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(2));
  const currentId = state.messageId;
  expect(currentId).not.toBe(previousId);
  await act(() => release());
  expect(state.messageId).toBe(currentId); expect(state.active).toBe(true);
  expect(playback.stopTtsPlayback).toHaveBeenLastCalledWith(expect.objectContaining({ expectedMessageId: previousId }));
});

test("the live pipeline snapshot also prevents stealing another surface before its busy props render", async () => {
  const { state, playback } = player(); state.messageId = "ordinary"; state.active = true;
  const { result, rerender } = await renderHook(({ p }: { p: VoiceConversationPlayback }) => useConsultationSpeech("room", p), { initialProps: { p: playback } });
  await act(() => result.current.enqueue(a));
  expect(playback.synthesizeSpeechStream).not.toHaveBeenCalled();
  state.active = false; await rerender({ p: { ...playback } });
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(1));
});

test("job attachments share the playback queue, suppress repeated or cancelled jobs and keep manual text replay separate", async () => {
  const { state, playback } = player();
  const { result, rerender } = await renderHook(({ p }: { p: VoiceConversationPlayback }) => useConsultationSpeech("room", p), { initialProps: { p: playback } });
  await act(() => {
    result.current.enqueue({ ...a, text: "", jobId: "job-a" });
    result.current.enqueue({ ...b, text: "", jobId: "job-b" });
    result.current.enqueue({ ...b, text: "", jobId: "job-b" });
    result.current.enqueue({ ...a, id: "c", text: "", jobId: "job-c" });
  });
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(1));
  expect(playback.synthesizeSpeechStream).toHaveBeenCalledWith("", expect.objectContaining({ jobId: "job-a" }));
  await act(() => result.current.cancel("job-b"));
  state.active = false; await rerender({ p: { ...playback } });
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(2));
  expect(playback.synthesizeSpeechStream).toHaveBeenLastCalledWith("", expect.objectContaining({ jobId: "job-c" }));
  await act(() => { result.current.enqueue({ ...b, text: "", jobId: "job-b" }); result.current.cancel("job-c"); });
  await act(() => result.current.read(a));
  await waitFor(() => expect(playback.synthesizeSpeechStream).toHaveBeenCalledTimes(3));
  expect(playback.synthesizeSpeechStream).toHaveBeenLastCalledWith(a.text, expect.not.objectContaining({ jobId: expect.anything() }));
});
