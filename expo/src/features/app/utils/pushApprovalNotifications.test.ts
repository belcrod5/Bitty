import * as Notifications from "expo-notifications";
import {
  APPROVAL_REQUEST_CATEGORY,
  APPROVE_ACTION,
  DENY_ACTION,
  TURN_COMPLETED_CATEGORY,
  consumePendingPushSessionId,
  registerApprovalNotificationCategories,
  setPendingPushSessionId,
} from "./pushApprovalNotifications";

jest.mock("expo-notifications", () => ({
  setNotificationCategoryAsync: jest.fn(),
}));

const mockSetNotificationCategoryAsync = Notifications.setNotificationCategoryAsync as jest.Mock;

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

describe("pending push session id holder", () => {
  it("returns empty string when nothing is pending", () => {
    expect(consumePendingPushSessionId()).toBe("");
  });

  it("stores and consumes (clearing) a pending session id", () => {
    setPendingPushSessionId("session-123");
    expect(consumePendingPushSessionId()).toBe("session-123");
    expect(consumePendingPushSessionId()).toBe("");
  });

  it("trims and ignores a blank session id", () => {
    setPendingPushSessionId("   ");
    expect(consumePendingPushSessionId()).toBe("");
  });
});
