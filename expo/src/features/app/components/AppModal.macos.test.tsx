import React from "react";
import { Text } from "react-native";
import { act, render } from "@testing-library/react-native";
import { AppModal, AppModalHost } from "./AppModal.macos";

test("renders macOS modal content in the shared root host", async () => {
  jest.useFakeTimers();

  const screen = await render(
    <AppModalHost>
      <Text>App content</Text>
      <AppModal visible transparent animationType="fade">
        <Text>Modal content</Text>
      </AppModal>
    </AppModalHost>
  );

  await act(async () => jest.runAllTimers());
  expect(screen.getByText("App content")).toBeTruthy();
  expect(screen.getByText("Modal content")).toBeTruthy();

  jest.useRealTimers();
});
