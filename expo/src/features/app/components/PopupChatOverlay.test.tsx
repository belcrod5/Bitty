import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { Animated } from "react-native";

import { VisualThemeProvider } from "../theme/VisualThemeContext";
import { PopupChatOverlay } from "./PopupChatOverlay";

const mockSetPanelAutoSpeechOpen = jest.fn();
let mockReduceMotion = false;
const mockStartStandardPopupTransition = jest.fn();
const mockStartCyberpunkPopupTransition = jest.fn();

function mockAnimation(): Animated.CompositeAnimation {
  return {
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
  };
}

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

jest.mock("../hooks/useReduceMotionEnabled", () => ({
  useReduceMotionEnabled: () => mockReduceMotion,
}));

jest.mock("./popupChatTransitions", () => ({
  startStandardPopupTransition: (...args: unknown[]) => mockStartStandardPopupTransition(...args),
  startCyberpunkPopupTransition: (...args: unknown[]) => mockStartCyberpunkPopupTransition(...args),
}));

const finishImmediately = (options: { onFinish: (finished?: boolean) => void }) => {
  options.onFinish(true);
  return mockAnimation();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockReduceMotion = false;
  mockStartStandardPopupTransition.mockImplementation(finishImmediately);
  mockStartCyberpunkPopupTransition.mockImplementation(finishImmediately);
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
  expect(mockStartCyberpunkPopupTransition).toHaveBeenCalledTimes(1);

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
  expect(mockStartCyberpunkPopupTransition).toHaveBeenCalledTimes(2);

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
  expect(mockStartCyberpunkPopupTransition).not.toHaveBeenCalled();

  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} />
    </VisualThemeProvider>
  );
  expect(playThemeSfx).toHaveBeenCalledTimes(1);
});

test("suppresses popup flashing when Reduce Motion is enabled", async () => {
  mockReduceMotion = true;
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

  expect(mockStartCyberpunkPopupTransition).toHaveBeenCalledWith(
    expect.objectContaining({ reduceMotion: true })
  );
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
  expect(mockStartCyberpunkPopupTransition).toHaveBeenCalledTimes(2);
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
  mockStartStandardPopupTransition.mockImplementation((options) => {
    if (options.direction === "close") closeCallbacks.push(options.onFinish);
    else options.onFinish(true);
    return mockAnimation();
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
  mockStartStandardPopupTransition.mockImplementation((options) => {
    if (options.direction === "open") openCallbacks.push(options.onFinish);
    else options.onFinish(true);
    return mockAnimation();
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
  mockStartStandardPopupTransition.mockImplementation((options) => {
    if (options.direction === "close") closeCallbacks.push(options.onFinish);
    else options.onFinish(true);
    return mockAnimation();
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
  mockStartStandardPopupTransition.mockImplementation((options) => {
    if (options.direction === "open") openCallbacks.push(options.onFinish);
    else closeCallbacks.push(options.onFinish);
    return mockAnimation();
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
  mockStartStandardPopupTransition.mockImplementation(() => mockAnimation());
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
