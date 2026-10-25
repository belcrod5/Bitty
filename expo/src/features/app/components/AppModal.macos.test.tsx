import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { AppModal, AppModalHost } from "./AppModal.macos";
import { appLayoutStylesByTheme } from "../styles/appLayoutStyles";

test("modal roots stack directly above session popups in opening order", async () => {
  const popupStyle = appLayoutStylesByTheme.standard.drawerPopupOverlayHost;
  const screen = await render(<AppModalHost>
    <View testID="session-popup" style={popupStyle} />
    <AppModal visible testID="title-menu"><Text>Title menu</Text></AppModal>
    <AppModal visible testID="schedule-editor"><Text>Schedule editor</Text></AppModal>
  </AppModalHost>);

  expect(screen.toJSON()).toMatchObject({ children: [
    { props: { testID: "session-popup" } },
    { props: { testID: "title-menu" } },
    { props: { testID: "schedule-editor" } },
  ] });
  const firstLayer = StyleSheet.flatten(screen.getByTestId("title-menu").props.style);
  const topLayer = StyleSheet.flatten(screen.getByTestId("schedule-editor").props.style);
  expect(firstLayer.zIndex).toBeGreaterThan(popupStyle.zIndex);
  expect(topLayer.zIndex).toBe(firstLayer.zIndex);
  await screen.unmount();
});

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
