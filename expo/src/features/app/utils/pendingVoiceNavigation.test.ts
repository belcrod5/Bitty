import {
  clearPendingVoiceOrchestratorId,
  getPendingVoiceOrchestratorId,
  getPendingVoiceControlSignal,
  setPendingVoiceOrchestratorId,
  subscribePendingVoiceOrchestratorId,
} from "./pendingVoiceNavigation";

jest.mock("expo-notifications", () => {
  throw new Error("Cannot find native module 'ExpoPushTokenManager'");
});

test("shared voice navigation works without native push notification support", () => {
  const listener = jest.fn();
  const unsubscribe = subscribePendingVoiceOrchestratorId(listener);
  try {
    expect(getPendingVoiceOrchestratorId()).toBe("");
    setPendingVoiceOrchestratorId("voice-123");
    expect(getPendingVoiceOrchestratorId()).toBe("voice-123");
    expect(listener).toHaveBeenCalledTimes(1);
    clearPendingVoiceOrchestratorId("voice-123");
    expect(getPendingVoiceOrchestratorId()).toBe("");
  } finally {
    unsubscribe();
    clearPendingVoiceOrchestratorId("voice-123");
  }
});

test("canceled remote navigation clears only its own pending destination", () => {
  const remote = new AbortController();
  setPendingVoiceOrchestratorId("remote", remote.signal);
  expect(getPendingVoiceControlSignal()).toBe(remote.signal);
  remote.abort();
  expect(getPendingVoiceOrchestratorId()).toBe("");
  const old = new AbortController();
  setPendingVoiceOrchestratorId("old", old.signal);
  setPendingVoiceOrchestratorId("manual");
  old.abort();
  expect(getPendingVoiceOrchestratorId()).toBe("manual");
  clearPendingVoiceOrchestratorId("manual");
});
