import React from "react";
import { render, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { PushNotificationRegistrar } from "./PushNotificationRegistrar";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useConversation } from "../contexts/ConversationContext";
import { useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { getOrCreatePushDeviceId, registerPushDevice } from "../utils/pushNotifications";
import { registerApprovalNotificationCategories, setPendingPushSessionTarget } from "../utils/pushApprovalNotifications";
import { handlePushApprovalAction } from "../utils/pushApprovalActions";
import {
  reconcileReceivedSessionNotification,
} from "../utils/sessionReadNotifications";

type NotificationResponseListener = (response: unknown) => void;

let capturedResponseListener: NotificationResponseListener | null = null;
let capturedReceivedListener: ((notification: unknown) => void) | null = null;

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  addNotificationReceivedListener: jest.fn(),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  setBadgeCountAsync: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
}));

jest.mock("../contexts/AppSettingsContext", () => ({
  useAppSettings: jest.fn(),
}));

jest.mock("../contexts/ConversationContext", () => ({
  useConversation: jest.fn(),
}));

jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketSnapshot: jest.fn(),
}));

jest.mock("../utils/pushNotifications", () => ({
  getOrCreatePushDeviceId: jest.fn(),
  registerPushDevice: jest.fn(),
  resolveForegroundNotificationBehavior: jest.fn(() => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  })),
}));

jest.mock("../utils/pushApprovalNotifications", () => {
  const actual = jest.requireActual("../utils/pushApprovalNotifications");
  return {
    ...actual,
    registerApprovalNotificationCategories: jest.fn(async () => {}),
    setPendingPushSessionTarget: jest.fn(),
  };
});

jest.mock("../utils/pushApprovalActions", () => ({
  handlePushApprovalAction: jest.fn(async () => {}),
}));

jest.mock("../utils/sessionReadNotifications", () => ({
  notificationFailureReason: jest.fn(() => "error"),
  reconcileReceivedSessionNotification: jest.fn(async () => {}),
}));

const mockUseAppSettings = useAppSettings as jest.Mock;
const mockUseConversation = useConversation as jest.Mock;
const mockUseRunnerWebSocketSnapshot = useRunnerWebSocketSnapshot as jest.Mock;
const mockGetOrCreatePushDeviceId = getOrCreatePushDeviceId as jest.Mock;
const mockRegisterPushDevice = registerPushDevice as jest.Mock;
const mockRegisterApprovalNotificationCategories = registerApprovalNotificationCategories as jest.Mock;
const mockSetPendingPushSessionTarget = setPendingPushSessionTarget as jest.Mock;
const mockHandlePushApprovalAction = handlePushApprovalAction as jest.Mock;
const mockReconcileReceivedSessionNotification = reconcileReceivedSessionNotification as jest.Mock;
const mockAddNotificationResponseReceivedListener =
  Notifications.addNotificationResponseReceivedListener as jest.Mock;

// Lets any pending real timers/microtasks in the component's async effect settle,
// used for negative assertions where waitFor's "retry until truthy" model doesn't apply.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("PushNotificationRegistrar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedResponseListener = null;
    capturedReceivedListener = null;
    // clearAllMocks does not reset return values configured with mockReturnValue.
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValue(null);
    mockAddNotificationResponseReceivedListener.mockImplementation((listener: NotificationResponseListener) => {
      capturedResponseListener = listener;
      return { remove: jest.fn() };
    });
    (Notifications.addNotificationReceivedListener as jest.Mock).mockImplementation((listener) => {
      capturedReceivedListener = listener;
      return { remove: jest.fn() };
    });
    mockUseAppSettings.mockReturnValue({
      runnerUrl: "https://runner.example.com",
      runnerToken: "runner-token",
      faceIdRequiredForApproval: false,
    });
    mockUseRunnerWebSocketSnapshot.mockReturnValue({ connected: true });
    mockUseConversation.mockReturnValue({
      registeredDirectories: [
        { id: "one", path: "/repo/one" },
        { id: "two", path: "/repo/two" },
      ],
    });
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
      granted: true,
      canAskAgain: true,
    });
    (Notifications.getDevicePushTokenAsync as jest.Mock).mockResolvedValue({
      type: "ios",
      data: "apns-token-1",
    });
    mockGetOrCreatePushDeviceId.mockResolvedValue("device-1");
    mockRegisterPushDevice.mockResolvedValue(true);
  });

  it("registers a device with the runner once connected with permission granted", async () => {
    await render(<PushNotificationRegistrar />);

    await waitFor(() => {
      expect(mockRegisterPushDevice).toHaveBeenCalledWith({
        runnerUrl: "https://runner.example.com",
        runnerToken: "runner-token",
        deviceId: "device-1",
        apnsToken: "apns-token-1",
        directories: ["/repo/one", "/repo/two"],
      });
    });
  });

  it("requests permission when not yet determined and can ask again", async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
      granted: false,
      canAskAgain: true,
    });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({
      granted: true,
      canAskAgain: true,
    });

    await render(<PushNotificationRegistrar />);

    await waitFor(() => {
      expect(mockRegisterPushDevice).toHaveBeenCalled();
    });
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
  });

  it("does not register when permission is denied and cannot be asked again", async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
      granted: false,
      canAskAgain: false,
    });

    await render(<PushNotificationRegistrar />);
    await settle();

    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockRegisterPushDevice).not.toHaveBeenCalled();
  });

  it("does not register while the runner connection is not established", async () => {
    mockUseRunnerWebSocketSnapshot.mockReturnValue({ connected: false });

    await render(<PushNotificationRegistrar />);
    await settle();

    expect(mockRegisterPushDevice).not.toHaveBeenCalled();
  });

  it("does not re-register when the device id and token are unchanged across re-renders", async () => {
    const { rerender } = await render(<PushNotificationRegistrar />);
    await waitFor(() => {
      expect(mockRegisterPushDevice).toHaveBeenCalledTimes(1);
    });

    await rerender(<PushNotificationRegistrar />);
    await settle();
    expect(mockRegisterPushDevice).toHaveBeenCalledTimes(1);
  });

  it("re-registers when the registered directory subscription changes", async () => {
    const { rerender } = await render(<PushNotificationRegistrar />);
    await waitFor(() => {
      expect(mockRegisterPushDevice).toHaveBeenCalledTimes(1);
    });
    mockUseConversation.mockReturnValue({
      registeredDirectories: [
        { id: "one", path: "/repo/one" },
        { id: "three", path: "/repo/three" },
      ],
    });
    await rerender(<PushNotificationRegistrar />);
    await waitFor(() => {
      expect(mockRegisterPushDevice).toHaveBeenCalledTimes(2);
    });
    expect(mockRegisterPushDevice).toHaveBeenLastCalledWith(expect.objectContaining({
      directories: ["/repo/one", "/repo/three"],
    }));
  });

  it("re-registers when the APNs token changes on a subsequent connection cycle", async () => {
    const { rerender } = await render(<PushNotificationRegistrar />);
    await waitFor(() => {
      expect(mockRegisterPushDevice).toHaveBeenCalledTimes(1);
    });

    (Notifications.getDevicePushTokenAsync as jest.Mock).mockResolvedValue({
      type: "ios",
      data: "apns-token-2",
    });
    // A real reconnect also refreshes the bearer token, which changes the effect's
    // dependencies and causes it to run again.
    mockUseAppSettings.mockReturnValue({
      runnerUrl: "https://runner.example.com",
      runnerToken: "runner-token-2",
      faceIdRequiredForApproval: false,
    });
    await rerender(<PushNotificationRegistrar />);

    await waitFor(() => {
      expect(mockRegisterPushDevice).toHaveBeenCalledTimes(2);
    });
    expect(mockRegisterPushDevice).toHaveBeenLastCalledWith({
      runnerUrl: "https://runner.example.com",
      runnerToken: "runner-token-2",
      deviceId: "device-1",
      apnsToken: "apns-token-2",
      directories: ["/repo/one", "/repo/two"],
    });
  });

  it("registers approval notification categories on mount and re-registers when the Face ID setting changes", async () => {
    const { rerender } = await render(<PushNotificationRegistrar />);
    await waitFor(() => {
      expect(mockRegisterApprovalNotificationCategories).toHaveBeenCalledWith(false);
    });

    mockUseAppSettings.mockReturnValue({
      runnerUrl: "https://runner.example.com",
      runnerToken: "runner-token",
      faceIdRequiredForApproval: true,
    });
    await rerender(<PushNotificationRegistrar />);

    await waitFor(() => {
      expect(mockRegisterApprovalNotificationCategories).toHaveBeenLastCalledWith(true);
    });
  });

  it("stashes the pending session id on a default (plain) tap", async () => {
    await render(<PushNotificationRegistrar />);
    expect(capturedResponseListener).not.toBeNull();

    capturedResponseListener?.({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: {
        request: {
          content: {
            categoryIdentifier: "TURN_COMPLETED",
            data: null,
          },
          trigger: { type: "push", payload: { backendId: "claude", sessionId: "session-abc", directory: "/repo/one", turnId: "turn-1" } },
        },
      },
    });

    expect(mockSetPendingPushSessionTarget).toHaveBeenCalledWith({
      backendId: "claude",
      sessionId: "session-abc",
      directory: "/repo/one",
    });
    expect(mockHandlePushApprovalAction).not.toHaveBeenCalled();
  });

  it("reconciles an incoming foreground notification against canonical server state", async () => {
    const snapshot = {
      unreadCount: 1,
      directoryCounts: [{ directory: "/repo/one", unreadCount: 1 }],
    };
    mockReconcileReceivedSessionNotification.mockResolvedValueOnce(snapshot);
    const onUnreadCountSnapshot = jest.fn();
    await render(<PushNotificationRegistrar onUnreadCountSnapshot={onUnreadCountSnapshot} />);
    const notification = { request: { identifier: "received-1", content: {} } };
    capturedReceivedListener?.(notification);
    expect(mockReconcileReceivedSessionNotification).toHaveBeenCalledWith({
      notification,
      runnerUrl: "https://runner.example.com",
      runnerToken: "runner-token",
      directories: ["/repo/one", "/repo/two"],
    });
    await waitFor(() => expect(onUnreadCountSnapshot).toHaveBeenCalledWith(snapshot));
  });

  it("delegates the deny action to handlePushApprovalAction immediately", async () => {
    await render(<PushNotificationRegistrar />);

    capturedResponseListener?.({
      actionIdentifier: "deny",
      notification: {
        request: {
          content: {
            categoryIdentifier: "APPROVAL_REQUEST",
            data: {},
          },
          trigger: { type: "push", payload: { approvalId: "relay-1:rpc-2", sessionId: "session-abc" } },
        },
      },
    });

    expect(mockHandlePushApprovalAction).toHaveBeenCalledWith({
      categoryIdentifier: "APPROVAL_REQUEST",
      actionIdentifier: "deny",
      approvalId: "relay-1:rpc-2",
    });
    expect(mockSetPendingPushSessionTarget).not.toHaveBeenCalled();
  });

  it("delegates the approve action to handlePushApprovalAction immediately", async () => {
    await render(<PushNotificationRegistrar />);

    capturedResponseListener?.({
      actionIdentifier: "approve",
      notification: {
        request: {
          content: {
            categoryIdentifier: "APPROVAL_REQUEST",
            data: { approvalId: "relay-1:rpc-2", sessionId: "session-abc" },
          },
        },
      },
    });

    expect(mockHandlePushApprovalAction).toHaveBeenCalledWith({
      categoryIdentifier: "APPROVAL_REQUEST",
      actionIdentifier: "approve",
      approvalId: "relay-1:rpc-2",
    });
  });

  it("picks up a cold-start action press from getLastNotificationResponse and clears it", async () => {
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValue({
      actionIdentifier: "approve",
      notification: {
        request: {
          identifier: "notif-cold-start",
          content: {
            categoryIdentifier: "APPROVAL_REQUEST",
            data: { approvalId: "relay-1:rpc-9", sessionId: "session-abc" },
          },
        },
      },
    });

    await render(<PushNotificationRegistrar />);

    expect(mockHandlePushApprovalAction).toHaveBeenCalledWith({
      categoryIdentifier: "APPROVAL_REQUEST",
      actionIdentifier: "approve",
      approvalId: "relay-1:rpc-9",
    });
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalled();
  });

  it("opens the target session from a cold-start completion tap and clears the response", async () => {
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValue({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: {
        request: {
          identifier: "completion-cold-start",
          content: {
            categoryIdentifier: "TURN_COMPLETED",
            data: null,
          },
          trigger: { type: "push", payload: { sessionId: "session-cold", directory: "/repo/cold" } },
        },
      },
    });

    await render(<PushNotificationRegistrar />);

    expect(mockSetPendingPushSessionTarget).toHaveBeenCalledWith({
      sessionId: "session-cold",
      directory: "/repo/cold",
    });
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalled();
    expect(mockHandlePushApprovalAction).not.toHaveBeenCalled();
  });

  it("retains a cold-start response whose metadata cannot be handled", async () => {
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValue({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: {
        request: {
          identifier: "invalid-cold-start",
          content: { categoryIdentifier: "TURN_COMPLETED", data: null },
          trigger: { type: "push", payload: { directory: "/repo/cold" } },
        },
      },
    });

    await render(<PushNotificationRegistrar />);

    expect(mockSetPendingPushSessionTarget).not.toHaveBeenCalled();
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
  });

  it("does not respond twice when the same response arrives via both the listener and getLastNotificationResponse", async () => {
    const response = {
      actionIdentifier: "approve",
      notification: {
        request: {
          identifier: "notif-dup",
          content: {
            categoryIdentifier: "APPROVAL_REQUEST",
            data: { approvalId: "relay-1:rpc-9", sessionId: "session-abc" },
          },
        },
      },
    };
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValue(response);

    await render(<PushNotificationRegistrar />);
    capturedResponseListener?.(response);

    expect(mockHandlePushApprovalAction).toHaveBeenCalledTimes(1);
  });

  it("still processes distinct responses after a dedupe hit", async () => {
    await render(<PushNotificationRegistrar />);

    const makeResponse = (identifier: string, approvalId: string) => ({
      actionIdentifier: "deny",
      notification: {
        request: {
          identifier,
          content: {
            categoryIdentifier: "APPROVAL_REQUEST",
            data: { approvalId },
          },
        },
      },
    });

    capturedResponseListener?.(makeResponse("notif-1", "relay-1:rpc-1"));
    capturedResponseListener?.(makeResponse("notif-1", "relay-1:rpc-1"));
    capturedResponseListener?.(makeResponse("notif-2", "relay-1:rpc-2"));

    expect(mockHandlePushApprovalAction).toHaveBeenCalledTimes(2);
    expect(mockHandlePushApprovalAction).toHaveBeenLastCalledWith({
      categoryIdentifier: "APPROVAL_REQUEST",
      actionIdentifier: "deny",
      approvalId: "relay-1:rpc-2",
    });
  });
});
