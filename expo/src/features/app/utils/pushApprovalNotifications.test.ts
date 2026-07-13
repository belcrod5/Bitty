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
    await registerApprovalNotificationCategories();
    expect(mockSetNotificationCategoryAsync).toHaveBeenCalledWith(TURN_COMPLETED_CATEGORY, []);
  });

  it("both approve and deny always foreground the app (background actions cannot run JS reliably on iOS)", async () => {
    await registerApprovalNotificationCategories();
    expect(mockSetNotificationCategoryAsync).toHaveBeenCalledWith(
      APPROVAL_REQUEST_CATEGORY,
      expect.arrayContaining([
        expect.objectContaining({
          identifier: APPROVE_ACTION,
          options: { opensAppToForeground: true },
        }),
        expect.objectContaining({
          identifier: DENY_ACTION,
          options: { opensAppToForeground: true },
        }),
      ])
    );
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
