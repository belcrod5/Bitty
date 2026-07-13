import React from "react";
import { render, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { PushNotificationRegistrar } from "./PushNotificationRegistrar";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { getOrCreatePushDeviceId, registerPushDevice } from "../utils/pushNotifications";

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(),
}));

jest.mock("../contexts/AppSettingsContext", () => ({
  useAppSettings: jest.fn(),
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

const mockUseAppSettings = useAppSettings as jest.Mock;
const mockUseRunnerWebSocketSnapshot = useRunnerWebSocketSnapshot as jest.Mock;
const mockGetOrCreatePushDeviceId = getOrCreatePushDeviceId as jest.Mock;
const mockRegisterPushDevice = registerPushDevice as jest.Mock;

// Lets any pending real timers/microtasks in the component's async effect settle,
// used for negative assertions where waitFor's "retry until truthy" model doesn't apply.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("PushNotificationRegistrar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAppSettings.mockReturnValue({
      runnerUrl: "https://runner.example.com",
      runnerToken: "runner-token",
    });
    mockUseRunnerWebSocketSnapshot.mockReturnValue({ connected: true });
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
    });
  });
});
