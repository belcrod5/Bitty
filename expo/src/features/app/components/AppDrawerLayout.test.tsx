import React from "react";
import { Text } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Drawer } from "react-native-drawer-layout";
import { AppDrawerLayout as NativeAppDrawerLayout } from "./AppDrawerLayout";
import { AppDrawerLayout as MacOSAppDrawerLayout } from "./AppDrawerLayout.macos";

jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => ({
  ...require("react-native-reanimated/mock"),
  useReducedMotion: () => false,
}));
jest.mock("react-native-drawer-layout", () => ({
  Drawer: jest.fn(({
    children,
    renderDrawerContent,
  }: {
    children: React.ReactNode;
    renderDrawerContent: () => React.ReactNode;
  }) => (
    <>{children}{renderDrawerContent()}</>
  )),
}));

const playThemeSfx = jest.fn(async () => {});

beforeEach(() => {
  jest.clearAllMocks();
});

test.each([true, false])(
  "forwards swipeEnabled=%s to the native drawer",
  async (swipeEnabled) => {
    await render(
      <NativeAppDrawerLayout
        open={false}
        onOpen={jest.fn()}
        onClose={jest.fn()}
        playThemeSfx={playThemeSfx}
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

test("fires drawer sounds only when the controlled open state changes", async () => {
  const props = {
    onOpen: jest.fn(),
    onClose: jest.fn(),
    playThemeSfx,
    renderDrawerContent: () => <Text>Drawer content</Text>,
    swipeEnabled: true,
  };
  const screen = await render(
    <NativeAppDrawerLayout {...props} open={false}>
      <Text>Screen content</Text>
    </NativeAppDrawerLayout>
  );

  expect(playThemeSfx).not.toHaveBeenCalled();

  await screen.rerender(
    <NativeAppDrawerLayout {...props} open>
      <Text>Screen content</Text>
    </NativeAppDrawerLayout>
  );
  await waitFor(() => expect(playThemeSfx).toHaveBeenCalledWith("drawerOpen"));

  await screen.rerender(
    <NativeAppDrawerLayout {...props} open>
      <Text>Screen content</Text>
    </NativeAppDrawerLayout>
  );
  expect(playThemeSfx).toHaveBeenCalledTimes(1);

  await screen.rerender(
    <NativeAppDrawerLayout {...props} open={false}>
      <Text>Screen content</Text>
    </NativeAppDrawerLayout>
  );
  await waitFor(() => expect(playThemeSfx).toHaveBeenLastCalledWith("drawerClose"));
  expect(playThemeSfx).toHaveBeenCalledTimes(2);
});

test("uses an animated clickable drawer on macOS", async () => {
  jest.useFakeTimers();
  const onClose = jest.fn();

  try {
    const screen = await render(
      <MacOSAppDrawerLayout
        open
        onOpen={jest.fn()}
        onClose={onClose}
        playThemeSfx={playThemeSfx}
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
