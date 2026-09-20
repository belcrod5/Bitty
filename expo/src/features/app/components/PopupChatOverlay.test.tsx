import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { useReducedMotion, withSequence, withTiming } from "react-native-reanimated";

import { VisualThemeProvider } from "../theme/VisualThemeContext";
import { PopupChatOverlay } from "./PopupChatOverlay";

const mockSetPanelAutoSpeechOpen = jest.fn();

jest.mock("../contexts/PanelRuntimeControllerContext", () => ({
  usePanelRuntimeController: () => ({ setPanelAutoSpeechOpen: mockSetPanelAutoSpeechOpen }),
}));

jest.mock("../screens/ChatScreen", () => ({
  ChatScreen: () => {
    const ReactModule = require("react");
    const { Text } = require("react-native");
    return ReactModule.createElement(Text, null, "chat");
  },
}));

jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => {
  const mock = require("react-native-reanimated/mock");
  return {
    ...mock,
    useReducedMotion: jest.fn(() => false),
    withSequence: jest.fn(mock.withSequence),
    withTiming: jest.fn(mock.withTiming),
  };
});

const mockUseReducedMotion = useReducedMotion as jest.MockedFunction<typeof useReducedMotion>;
const mockWithTiming = withTiming as jest.MockedFunction<typeof withTiming>;
const defaultWithTiming = require("react-native-reanimated/mock").withTiming;

beforeEach(() => {
  jest.clearAllMocks();
  mockUseReducedMotion.mockReturnValue(false);
  mockWithTiming.mockImplementation(defaultWithTiming);
});

afterEach(() => {
  jest.useRealTimers();
});

test("plays popup open and close sounds once per displayed cycle", async () => {
  const playThemeSfx = jest.fn(async () => {});
  const onClose = jest.fn();
  const onRequestClose = jest.fn();
  const screen = await render(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <PopupChatOverlay
        visible
        panelId="popup-panel"
        cycleId="cycle-1"
        onClose={onClose}
        onRequestClose={onRequestClose}
        playThemeSfx={playThemeSfx}
      />
    </VisualThemeProvider>
  );

  await waitFor(() => expect(playThemeSfx).toHaveBeenCalledWith("popupOpen"));
  expect(playThemeSfx).toHaveBeenCalledTimes(1);
  expect(withSequence).toHaveBeenCalledTimes(2);

  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <PopupChatOverlay
        visible
        panelId="popup-panel"
        cycleId="cycle-1"
        onClose={onClose}
        onRequestClose={onRequestClose}
        playThemeSfx={playThemeSfx}
      />
    </VisualThemeProvider>
  );
  expect(playThemeSfx).toHaveBeenCalledTimes(1);

  await fireEvent.press(screen.getByTestId("popup-chat-backdrop"));
  expect(onRequestClose).toHaveBeenCalledTimes(1);
  expect(playThemeSfx).toHaveBeenCalledTimes(1);

  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <PopupChatOverlay
        visible={false}
        panelId="popup-panel"
        cycleId="cycle-1"
        onClose={onClose}
        onRequestClose={onRequestClose}
        playThemeSfx={playThemeSfx}
      />
    </VisualThemeProvider>
  );

  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <PopupChatOverlay
        visible={false}
        panelId="popup-panel"
        cycleId="cycle-1"
        onClose={onClose}
        onRequestClose={onRequestClose}
        playThemeSfx={playThemeSfx}
      />
    </VisualThemeProvider>
  );

  expect(playThemeSfx).toHaveBeenCalledTimes(2);
  expect(playThemeSfx).toHaveBeenLastCalledWith("popupClose");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(withSequence).toHaveBeenCalledTimes(4);

  await screen.rerender(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay
        visible
        panelId="popup-panel"
        cycleId="cycle-2"
        onClose={onClose}
        onRequestClose={onRequestClose}
        playThemeSfx={playThemeSfx}
      />
    </VisualThemeProvider>
  );
  await waitFor(() => expect(playThemeSfx).toHaveBeenCalledTimes(3));
  expect(playThemeSfx).toHaveBeenLastCalledWith("popupOpen");

  screen.unmount();
  expect(playThemeSfx).toHaveBeenCalledTimes(3);
});

test("does not replay the open event when only the theme changes", async () => {
  const playThemeSfx = jest.fn(async () => {});
  const props = {
    visible: true,
    panelId: "popup-panel",
    cycleId: "cycle-1",
    onClose: jest.fn(),
    onRequestClose: jest.fn(),
    playThemeSfx,
  };
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} />
    </VisualThemeProvider>
  );
  await waitFor(() => expect(playThemeSfx).toHaveBeenCalledTimes(1));
  expect(withSequence).not.toHaveBeenCalled();

  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} />
    </VisualThemeProvider>
  );
  expect(playThemeSfx).toHaveBeenCalledTimes(1);
});

test("suppresses popup flashing when Reduce Motion is enabled", async () => {
  mockUseReducedMotion.mockReturnValue(true);
  const screen = await render(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <PopupChatOverlay
        visible
        panelId="popup-panel"
        cycleId="cycle-1"
        onClose={() => undefined}
        onRequestClose={() => undefined}
        playThemeSfx={async () => {}}
      />
    </VisualThemeProvider>
  );

  expect(withSequence).not.toHaveBeenCalled();
  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <PopupChatOverlay
        visible={false}
        panelId="popup-panel"
        cycleId="cycle-1"
        onClose={() => undefined}
        onRequestClose={() => undefined}
        playThemeSfx={async () => {}}
      />
    </VisualThemeProvider>
  );
  expect(withSequence).not.toHaveBeenCalled();
});

test("skips close effects when the popup was never displayed", async () => {
  const playThemeSfx = jest.fn(async () => {});
  const onClose = jest.fn();
  await render(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <PopupChatOverlay
        visible={false}
        panelId="popup-panel"
        cycleId="cycle-1"
        onClose={onClose}
        onRequestClose={() => undefined}
        playThemeSfx={playThemeSfx}
      />
    </VisualThemeProvider>
  );

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(playThemeSfx).not.toHaveBeenCalled();
});

test("ignores a stale close completion after reopening the same cycle", async () => {
  const closeCallbacks: Array<(finished?: boolean) => void> = [];
  mockWithTiming.mockImplementation((toValue, config, callback) => {
    if (toValue === 0 && callback) {
      closeCallbacks.push(callback);
      return toValue as never;
    }
    return defaultWithTiming(toValue, config, callback);
  });
  const playThemeSfx = jest.fn(async () => {});
  const onClose = jest.fn();
  const props = {
    panelId: "popup-panel",
    cycleId: "cycle-1",
    onClose,
    onRequestClose: jest.fn(),
    playThemeSfx,
  };
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} visible />
    </VisualThemeProvider>
  );
  await waitFor(() => expect(playThemeSfx).toHaveBeenCalledWith("popupOpen"));

  await screen.rerender(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} visible={false} />
    </VisualThemeProvider>
  );
  expect(closeCallbacks).toHaveLength(1);

  await screen.rerender(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} visible />
    </VisualThemeProvider>
  );
  await waitFor(() => expect(playThemeSfx).toHaveBeenCalledTimes(3));
  closeCallbacks[0]?.(true);

  expect(playThemeSfx).toHaveBeenNthCalledWith(1, "popupOpen");
  expect(playThemeSfx).toHaveBeenCalledWith("popupClose");
  expect(playThemeSfx).toHaveBeenCalledWith("popupOpen");
  expect(onClose).not.toHaveBeenCalled();
});

test("ignores a stale open completion after closing starts", async () => {
  const openCallbacks: Array<(finished?: boolean) => void> = [];
  mockWithTiming.mockImplementation((toValue, config, callback) => {
    if (toValue === 1 && callback) {
      openCallbacks.push(callback);
      return toValue as never;
    }
    return defaultWithTiming(toValue, config, callback);
  });
  const props = {
    panelId: "popup-panel",
    cycleId: "cycle-1",
    onClose: jest.fn(),
    onRequestClose: jest.fn(),
    playThemeSfx: jest.fn(async () => {}),
  };
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} visible />
    </VisualThemeProvider>
  );
  expect(openCallbacks).toHaveLength(1);
  expect(screen.queryByText("chat")).toBeNull();

  await screen.rerender(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} visible={false} />
    </VisualThemeProvider>
  );
  await act(async () => openCallbacks[0]?.(true));

  expect(screen.queryByText("chat")).toBeNull();
});

test("finishes closing when the animation callback does not fire", async () => {
  jest.useFakeTimers();
  const closeCallbacks: Array<(finished?: boolean) => void> = [];
  mockWithTiming.mockImplementation((toValue, config, callback) => {
    if (toValue === 0 && callback) {
      closeCallbacks.push(callback);
      return toValue as never;
    }
    return defaultWithTiming(toValue, config, callback);
  });
  const onClose = jest.fn();
  const props = {
    panelId: "popup-panel",
    cycleId: "cycle-1",
    onClose,
    onRequestClose: jest.fn(),
    playThemeSfx: jest.fn(async () => {}),
  };
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} visible />
    </VisualThemeProvider>
  );

  await screen.rerender(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} visible={false} />
    </VisualThemeProvider>
  );
  expect(closeCallbacks).toHaveLength(1);
  await act(async () => jest.advanceTimersByTime(470));
  expect(onClose).toHaveBeenCalledTimes(1);

  await act(async () => closeCallbacks[0]?.(true));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("replays StrictMode effects while emitting each popup event once", async () => {
  jest.useFakeTimers();
  const openCallbacks: Array<(finished?: boolean) => void> = [];
  const closeCallbacks: Array<(finished?: boolean) => void> = [];
  mockWithTiming.mockImplementation((toValue, _config, callback) => {
    if (toValue === 1 && callback) openCallbacks.push(callback);
    if (toValue === 0 && callback) closeCallbacks.push(callback);
    return toValue as never;
  });
  const playThemeSfx = jest.fn(async () => {});
  const onClose = jest.fn();
  const props = {
    panelId: "popup-panel",
    cycleId: "cycle-1",
    onClose,
    onRequestClose: jest.fn(),
    playThemeSfx,
  };
  const screen = await render(
    <React.StrictMode>
      <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
        <PopupChatOverlay {...props} visible />
      </VisualThemeProvider>
    </React.StrictMode>
  );

  expect(openCallbacks).toHaveLength(2);
  await act(async () => jest.advanceTimersByTime(0));
  expect(playThemeSfx).toHaveBeenCalledTimes(1);
  expect(playThemeSfx).toHaveBeenLastCalledWith("popupOpen");

  await act(async () => openCallbacks[0]?.(true));
  expect(screen.queryByText("chat")).toBeNull();
  await act(async () => openCallbacks[1]?.(true));
  expect(screen.getByText("chat")).toBeTruthy();

  await screen.rerender(
    <React.StrictMode>
      <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
        <PopupChatOverlay {...props} visible={false} />
      </VisualThemeProvider>
    </React.StrictMode>
  );
  expect(closeCallbacks).toHaveLength(1);
  await act(async () => jest.advanceTimersByTime(0));
  expect(playThemeSfx).toHaveBeenCalledTimes(2);
  expect(playThemeSfx).toHaveBeenLastCalledWith("popupClose");

  await act(async () => closeCallbacks[0]?.(true));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(playThemeSfx).toHaveBeenCalledTimes(2);
});

test("does not play a deferred popup sound after unmount", async () => {
  jest.useFakeTimers();
  mockWithTiming.mockImplementation((toValue) => toValue as never);
  const playThemeSfx = jest.fn(async () => {});
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay
        visible
        panelId="popup-panel"
        cycleId="cycle-1"
        onClose={() => undefined}
        onRequestClose={() => undefined}
        playThemeSfx={playThemeSfx}
      />
    </VisualThemeProvider>
  );

  await screen.unmount();
  await act(async () => jest.runOnlyPendingTimers());

  expect(playThemeSfx).not.toHaveBeenCalled();
});
