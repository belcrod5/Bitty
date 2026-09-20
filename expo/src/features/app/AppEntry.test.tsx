import React from "react";
import { render } from "@testing-library/react-native";
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

test("retries when the shared five-second hide attempt rejects after both triggers fire", async () => {
  jest.useFakeTimers();
  const hideAsync = SplashScreen.hideAsync as jest.MockedFunction<typeof SplashScreen.hideAsync>;
  let rejectFirstAttempt!: (error: Error) => void;
  hideAsync
    .mockReturnValueOnce(new Promise<void>((_resolve, reject) => {
      rejectFirstAttempt = reject;
    }))
    .mockResolvedValue(undefined);

  const view = await render(<App />);
  expect(mockOnReady).toEqual(expect.any(Function));
  jest.advanceTimersByTime(5_000);
  expect(hideAsync).toHaveBeenCalledTimes(1);

  mockOnReady?.();
  expect(hideAsync).toHaveBeenCalledTimes(1);

  rejectFirstAttempt(new Error("temporary failure"));
  await Promise.resolve();
  await Promise.resolve();
  jest.advanceTimersByTime(250);
  await Promise.resolve();
  expect(hideAsync).toHaveBeenCalledTimes(2);

  view.unmount();
  jest.useRealTimers();
});
