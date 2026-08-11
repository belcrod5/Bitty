import * as Notifications from "expo-notifications";
import {
  APPROVAL_REQUEST_CATEGORY,
  APPROVE_ACTION,
  DENY_ACTION,
  TURN_COMPLETED_CATEGORY,
  clearPendingPushSessionTarget,
  getPendingPushSessionTarget,
  normalizeNotificationMetadata,
  registerApprovalNotificationCategories,
  setPendingPushSessionTarget,
  subscribePendingPushSessionTarget,
} from "./pushApprovalNotifications";

jest.mock("expo-notifications", () => ({
  setNotificationCategoryAsync: jest.fn(),
}));

const mockSetNotificationCategoryAsync = Notifications.setNotificationCategoryAsync as jest.Mock;

describe("normalizeNotificationMetadata", () => {
  it("reads actual iOS remote serializer root fields from trigger.payload", () => {
    expect(normalizeNotificationMetadata({
      content: { data: null },
      trigger: {
        type: "push",
        payload: {
          sessionId: "session-root",
          directory: "/root",
          turnId: "turn-root",
          approvalId: "approval-root",
          secret: "ignored",
        },
      },
    } as unknown as Notifications.NotificationRequest)).toEqual({
      sessionId: "session-root",
      directory: "/root",
      turnId: "turn-root",
      approvalId: "approval-root",
    });
  });

  it("prefers content.data per field and falls back only for missing fields", () => {
    expect(normalizeNotificationMetadata({
      content: {
        data: { sessionId: "session-data", directory: "", turnId: "turn-data" },
      },
      trigger: {
        type: "push",
        payload: {
          sessionId: "session-root",
          directory: "/root",
          turnId: "turn-root",
          approvalId: "approval-root",
        },
      },
    } as unknown as Notifications.NotificationRequest)).toEqual({
      sessionId: "session-data",
      directory: "/root",
      turnId: "turn-data",
      approvalId: "approval-root",
    });
  });
});

describe("registerApprovalNotificationCategories", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("registers TURN_COMPLETED with no actions", async () => {
    await registerApprovalNotificationCategories(false);
    expect(mockSetNotificationCategoryAsync).toHaveBeenCalledWith(TURN_COMPLETED_CATEGORY, []);
  });

  it("Face ID ON: approve foregrounds the app so JS can run the biometric prompt", async () => {
    await registerApprovalNotificationCategories(true);
    expect(mockSetNotificationCategoryAsync).toHaveBeenCalledWith(
      APPROVAL_REQUEST_CATEGORY,
      expect.arrayContaining([
        expect.objectContaining({
          identifier: APPROVE_ACTION,
          options: { opensAppToForeground: true },
        }),
      ])
    );
  });

  it("Face ID OFF: approve is a background action (native responder) requiring device unlock", async () => {
    await registerApprovalNotificationCategories(false);
    expect(mockSetNotificationCategoryAsync).toHaveBeenCalledWith(
      APPROVAL_REQUEST_CATEGORY,
      expect.arrayContaining([
        expect.objectContaining({
          identifier: APPROVE_ACTION,
          options: { opensAppToForeground: false, isAuthenticationRequired: true },
        }),
      ])
    );
  });

  it("deny is always a background action (native responder) regardless of the Face ID setting", async () => {
    for (const faceIdRequired of [true, false]) {
      mockSetNotificationCategoryAsync.mockClear();
      await registerApprovalNotificationCategories(faceIdRequired);
      expect(mockSetNotificationCategoryAsync).toHaveBeenCalledWith(
        APPROVAL_REQUEST_CATEGORY,
        expect.arrayContaining([
          expect.objectContaining({
            identifier: DENY_ACTION,
            options: { opensAppToForeground: false },
          }),
        ])
      );
    }
  });
});

describe("pending push session target store", () => {
  beforeEach(() => {
    const target = getPendingPushSessionTarget();
    if (target) clearPendingPushSessionTarget(target);
  });

  it("retains the target until the matching intent is cleared", () => {
    setPendingPushSessionTarget({ sessionId: "session-123", directory: "/repo" });
    const target = getPendingPushSessionTarget();
    expect(target).toEqual(expect.objectContaining({ sessionId: "session-123", directory: "/repo" }));
    expect(clearPendingPushSessionTarget(target!)).toBe(true);
    expect(getPendingPushSessionTarget()).toBeNull();
  });

  it("does not let an older completion clear a newer intent and notifies subscribers", () => {
    const listener = jest.fn();
    const unsubscribe = subscribePendingPushSessionTarget(listener);
    setPendingPushSessionTarget({ sessionId: "old", directory: "/old" });
    const old = getPendingPushSessionTarget()!;
    setPendingPushSessionTarget({ sessionId: "new", directory: "/new" });
    expect(clearPendingPushSessionTarget(old)).toBe(false);
    expect(getPendingPushSessionTarget()).toEqual(expect.objectContaining({ sessionId: "new" }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
