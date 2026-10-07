import {
  clearPendingPushVoiceOrchestratorId,
  getPendingPushVoiceOrchestratorId,
  setPendingPushVoiceOrchestratorId,
  subscribePendingPushVoiceOrchestratorId,
} from "./pushApprovalNotifications";

jest.mock("expo-notifications", () => {
  throw new Error("Cannot find native module 'ExpoPushTokenManager'");
});

test("shared voice navigation works without native push notification support", () => {
  const listener = jest.fn();
  const unsubscribe = subscribePendingPushVoiceOrchestratorId(listener);
  try {
    expect(getPendingPushVoiceOrchestratorId()).toBe("");
    setPendingPushVoiceOrchestratorId("voice-123");
    expect(getPendingPushVoiceOrchestratorId()).toBe("voice-123");
    expect(listener).toHaveBeenCalledTimes(1);
    clearPendingPushVoiceOrchestratorId("voice-123");
    expect(getPendingPushVoiceOrchestratorId()).toBe("");
  } finally {
    unsubscribe();
    clearPendingPushVoiceOrchestratorId("voice-123");
  }
});
