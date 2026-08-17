import React from "react";
import { render } from "@testing-library/react-native";
import { AppScreenContent } from "./AppScreenContent.macos";

let mockBoardMountCount = 0;

jest.mock("../screens/SkiaMiniBoardScreen", () => ({
  SkiaMiniBoardScreen: () => {
    const ReactModule = require("react");
    const { Text } = require("react-native");
    ReactModule.useState(() => {
      mockBoardMountCount += 1;
      return null;
    });
    return ReactModule.createElement(Text, null, "Skia board");
  },
}));
jest.mock("../screens/DebugScreen", () => ({
  DebugScreen: () => {
    const ReactModule = require("react");
    const { Text } = require("react-native");
    return ReactModule.createElement(Text, null, "Debug screen");
  },
}));
jest.mock("../screens/CloudflareTunnelMonitorScreen", () => ({
  CloudflareTunnelMonitorScreen: () => null,
}));
jest.mock("./AudioLabScreen", () => ({
  AudioLabScreen: () => null,
}));

beforeEach(() => {
  mockBoardMountCount = 0;
});

test("keeps the native Skia surface mounted while visiting Current Settings", async () => {
  const openSessionHistoryPopup = jest.fn();
  const screen = await render(
    <AppScreenContent
      activeScreen="skia_board"
      onStartNewSessionInDirectory={jest.fn()}
      openSessionHistoryPopup={openSessionHistoryPopup}
    />
  );

  expect(mockBoardMountCount).toBe(1);
  await screen.rerender(
    <AppScreenContent
      activeScreen="debug"
      onStartNewSessionInDirectory={jest.fn()}
      openSessionHistoryPopup={openSessionHistoryPopup}
    />
  );
  expect(screen.getByText("Debug screen")).toBeTruthy();

  await screen.rerender(
    <AppScreenContent
      activeScreen="skia_board"
      onStartNewSessionInDirectory={jest.fn()}
      openSessionHistoryPopup={openSessionHistoryPopup}
    />
  );
  expect(mockBoardMountCount).toBe(1);
});
