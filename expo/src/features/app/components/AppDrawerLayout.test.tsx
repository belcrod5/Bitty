import React from "react";
import { Text } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { Drawer } from "react-native-drawer-layout";
import { AppDrawerLayout as NativeAppDrawerLayout } from "./AppDrawerLayout";
import { AppDrawerLayout as MacOSAppDrawerLayout } from "./AppDrawerLayout.macos";

jest.mock("react-native-drawer-layout", () => ({
  Drawer: jest.fn(({ children }: { children: React.ReactNode }) => children),
}));

test.each([true, false])(
  "forwards swipeEnabled=%s to the native drawer",
  async (swipeEnabled) => {
    await render(
      <NativeAppDrawerLayout
        open={false}
        onOpen={jest.fn()}
        onClose={jest.fn()}
        renderDrawerContent={() => <Text>Drawer content</Text>}
        swipeEnabled={swipeEnabled}
      >
        <Text>Screen content</Text>
      </NativeAppDrawerLayout>
    );

    const drawerMock = Drawer as unknown as jest.Mock;
    expect(drawerMock.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ swipeEnabled })
    );
  }
);

test("uses an animated clickable drawer on macOS", async () => {
  jest.useFakeTimers();
  const onClose = jest.fn();

  try {
    const screen = await render(
      <MacOSAppDrawerLayout
        open
        onOpen={jest.fn()}
        onClose={onClose}
        renderDrawerContent={() => <Text>Drawer content</Text>}
        swipeEnabled={false}
      >
        <Text>Screen content</Text>
      </MacOSAppDrawerLayout>
    );
    await act(async () => {
      jest.runAllTimers();
    });

    expect(screen.getByTestId("macos-app-drawer")).toBeTruthy();
    expect(screen.getByText("Drawer content")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("ナビゲーションを閉じる"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await screen.unmount();
  } finally {
    jest.useRealTimers();
  }
});
