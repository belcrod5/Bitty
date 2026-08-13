import React from "react";
import { Text } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { AppModal, AppModalHost } from "./AppModal.macos";

test("renders macOS modal content in the shared root host", async () => {
  const onRequestClose = jest.fn();

  const screen = await render(
    <AppModalHost>
      <Text testID="app-content">App content</Text>
      <AppModal
        visible
        transparent
        animationType="none"
        onRequestClose={onRequestClose}
        testID="macos-modal"
      >
        <Text>Modal content</Text>
      </AppModal>
    </AppModalHost>
  );

  expect(screen.getByText("App content")).toBeTruthy();
  expect(screen.getByText("Modal content")).toBeTruthy();
  const stopPropagation = jest.fn();
  await fireEvent(screen.getByTestId("app-content"), "keyDownCapture", {
    nativeEvent: { key: "Escape" },
    stopPropagation,
  });
  expect(onRequestClose).toHaveBeenCalledTimes(1);
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test("Escape targets only the top modal and does not fall through when it has no close callback", async () => {
  const closeBack = jest.fn();
  const closeTop = jest.fn();
  const screen = await render(
    <AppModalHost>
      <Text testID="focused-background">Background</Text>
      <AppModal visible onRequestClose={closeBack}><Text>Back modal</Text></AppModal>
      <AppModal visible onRequestClose={closeTop}><Text>Top modal</Text></AppModal>
    </AppModalHost>
  );
  await fireEvent(screen.getByTestId("focused-background"), "keyDownCapture", {
    nativeEvent: { key: "Escape" },
    stopPropagation: jest.fn(),
  });
  expect(closeTop).toHaveBeenCalledTimes(1);
  expect(closeBack).not.toHaveBeenCalled();

  await screen.rerender(
    <AppModalHost>
      <Text testID="focused-background">Background</Text>
      <AppModal visible onRequestClose={closeBack}><Text>Back modal</Text></AppModal>
      <AppModal visible><Text>Top modal without callback</Text></AppModal>
    </AppModalHost>
  );
  await fireEvent(screen.getByTestId("focused-background"), "keyDownCapture", {
    nativeEvent: { key: "Escape" },
    stopPropagation: jest.fn(),
  });
  expect(closeBack).not.toHaveBeenCalled();
  await screen.unmount();
});
