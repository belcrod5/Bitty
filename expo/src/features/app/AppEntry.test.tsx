import React from "react";
import { act, render, waitFor } from "@testing-library/react-native";
import * as SplashScreen from "expo-splash-screen";

let mockOnReady: (() => void) | undefined;

jest.mock("./AppRoot", () => ({
  __esModule: true,
  default: ({ onReady }: { onReady?: () => void }) => {
    mockOnReady = onReady;
    return null;
  },
}));

jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(),
}));

const App = require("../../../App").default as typeof import("../../../App").default;

test("retries hiding the splash screen after a failed ready attempt", async () => {
  jest.useFakeTimers();
  const hideAsync = SplashScreen.hideAsync as jest.MockedFunction<typeof SplashScreen.hideAsync>;
  hideAsync.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue(undefined);

  const view = await render(<App />);
  await waitFor(() => expect(mockOnReady).toEqual(expect.any(Function)));
  mockOnReady?.();
  await Promise.resolve();
  expect(hideAsync).toHaveBeenCalledTimes(1);

  act(() => {
    jest.advanceTimersByTime(5_000);
  });
  await Promise.resolve();
  expect(hideAsync).toHaveBeenCalledTimes(2);

  view.unmount();
  jest.useRealTimers();
});
