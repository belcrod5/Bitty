import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { CloudflareTunnelMonitorScreen } from "./CloudflareTunnelMonitorScreen";

const mockOpenSettingsScreen = jest.fn();

jest.mock("../camera", () => ({
  CameraView: () => null,
  supportsCamera: false,
  useCameraPermissions: () => [null, jest.fn()],
}));
jest.mock("../contexts/AppShellContext", () => ({
  useAppShell: () => ({ openSettingsScreen: mockOpenSettingsScreen }),
}));
jest.mock("../contexts/AppSettingsContext", () => ({
  useAppSettings: () => ({
    runnerUrl: "",
    runnerToken: "",
    cloudflareAccessClientId: "",
    cloudflareAccessEnabled: false,
  }),
}));
jest.mock("./RouteDebugPanel", () => ({ RouteDebugPanel: () => null }));

test("returns from the dedicated tunnel monitor to Settings", async () => {
  const screen = await render(<CloudflareTunnelMonitorScreen />);

  await fireEvent.press(screen.getByLabelText("設定に戻る"));

  expect(mockOpenSettingsScreen).toHaveBeenCalledTimes(1);
  await screen.unmount();
});
