import React from "react";
import { Text } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { AppDrawerLayout } from "./AppDrawerLayout.macos";

jest.mock("react-native-drawer-layout", () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => children,
}));

test("uses an animated clickable drawer on macOS", async () => {
  const onClose = jest.fn();

  const screen = await render(
    <AppDrawerLayout
      open
      onOpen={jest.fn()}
      onClose={onClose}
      renderDrawerContent={() => <Text>Drawer content</Text>}
    >
      <Text>Screen content</Text>
    </AppDrawerLayout>
  );

  expect(screen.getByTestId("macos-app-drawer")).toBeTruthy();
  expect(screen.getByText("Drawer content")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("ナビゲーションを閉じる"));
  expect(onClose).toHaveBeenCalledTimes(1);
});
