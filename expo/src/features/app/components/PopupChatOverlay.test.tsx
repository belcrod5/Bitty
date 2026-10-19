import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { StyleSheet, type Animated } from "react-native";

import { VisualThemeProvider } from "../theme/VisualThemeContext";
import { VISUAL_THEMES } from "../theme/visualThemes";
import { PopupChatOverlay } from "./PopupChatOverlay";

const mockSetPanelAutoSpeechOpen = jest.fn();
let mockReduceMotion = false;
const mockStartStandardPopupTransition = jest.fn();
const mockStartCyberpunkPopupTransition = jest.fn();
const mockStartPopupMinimizeTransition = jest.fn();

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
  startPopupMinimizeTransition: (...args: unknown[]) => mockStartPopupMinimizeTransition(...args),
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
  mockStartPopupMinimizeTransition.mockImplementation(() => mockAnimation());
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

test.each(["standard", "cyberpunk"] as const)("minimizes only the frame and selects on arrival in %s", async (themeId) => {
  const onComplete = jest.fn();
  const onClose = jest.fn();
  const resolveCloseTarget = jest.fn(async () => ({
    rect: { x: 75, y: 120, width: 140, height: 56 }, onComplete,
  }));
  const props = { panelId: "popup", cycleId: "cycle", onClose,
    onRequestClose: jest.fn(), playThemeSfx: jest.fn(async () => {}), resolveCloseTarget };
  const tree = (visible: boolean) => (
    <VisualThemeProvider themeId={themeId} onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} visible={visible} />
    </VisualThemeProvider>
  );
  const screen = await render(tree(true));
  expect(resolveCloseTarget).not.toHaveBeenCalled();
  expect(screen.getByText("chat")).toBeTruthy();
  await screen.rerender(tree(false));
  await waitFor(() => expect(mockStartPopupMinimizeTransition).toHaveBeenCalledTimes(1));
  const options = mockStartPopupMinimizeTransition.mock.calls[0][0];
  expect(options.blink).toBe(themeId === "cyberpunk");
  expect(screen.queryByText("chat")).toBeNull();
  expect(StyleSheet.flatten(screen.getByTestId("popup-chat-frame").props.style)).toMatchObject({
    backgroundColor: "transparent",
  });
  expect(onComplete).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => options.onFinish(true));
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onComplete.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
});

test("ignores an old board measurement after a new popup cycle opens", async () => {
  const onComplete = jest.fn();
  let finishMeasurement!: (target: { rect: { x: number; y: number; width: number; height: number }; onComplete: () => void }) => void;
  const resolveCloseTarget = () => new Promise<Parameters<typeof finishMeasurement>[0]>((resolve) => {
    finishMeasurement = resolve;
  });
  const onClose = jest.fn();
  const tree = (visible: boolean, cycleId: string) => (
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay visible={visible} cycleId={cycleId} panelId="popup"
        resolveCloseTarget={resolveCloseTarget} onClose={onClose}
        onRequestClose={jest.fn()} playThemeSfx={jest.fn(async () => {})} />
    </VisualThemeProvider>
  );
  const screen = await render(tree(true, "first"));
  await screen.rerender(tree(false, "first"));
  await screen.rerender(tree(true, "second"));
  await act(async () => finishMeasurement({ rect: { x: 10, y: 10, width: 100, height: 60 }, onComplete }));
  expect(mockStartPopupMinimizeTransition).not.toHaveBeenCalled();
  expect(onComplete).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByText("chat")).toBeTruthy();
});

test("still closes when the native board measurement never completes", async () => {
  jest.useFakeTimers();
  const onClose = jest.fn();
  const props = { panelId: "popup", cycleId: "first", onClose,
    resolveCloseTarget: () => new Promise<null>(() => {}),
    onRequestClose: jest.fn(), playThemeSfx: jest.fn(async () => {}) };
  const tree = (visible: boolean) => (
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} visible={visible} />
    </VisualThemeProvider>
  );
  const screen = await render(tree(true));
  await screen.rerender(tree(false));
  await act(async () => jest.advanceTimersByTime(1000));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(mockStartPopupMinimizeTransition).not.toHaveBeenCalled();
});

test("does not select the previous target when an in-flight minimize is interrupted by reopening", async () => {
  const onComplete = jest.fn();
  const onClose = jest.fn();
  const props = { panelId: "popup", onClose,
    resolveCloseTarget: () => ({ rect: { x: 10, y: 10, width: 100, height: 60 }, onComplete }),
    onRequestClose: jest.fn(), playThemeSfx: jest.fn(async () => {}) };
  const tree = (visible: boolean, cycleId: string) => (
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} visible={visible} cycleId={cycleId} />
    </VisualThemeProvider>
  );
  const screen = await render(tree(true, "first"));
  await screen.rerender(tree(false, "first"));
  const animation = mockStartPopupMinimizeTransition.mock.calls[0][0];
  await screen.rerender(tree(true, "second"));
  await act(async () => animation.onFinish(true));
  expect(onComplete).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test("gives a delayed board measurement a full animation before selecting and closing", async () => {
  jest.useFakeTimers();
  const durationMs = VISUAL_THEMES.standard.motion.popupClose.durationMs;
  const onComplete = jest.fn();
  const onClose = jest.fn();
  let finishMeasurement!: (target: { rect: { x: number; y: number; width: number; height: number }; onComplete: () => void }) => void;
  const props = { panelId: "popup", cycleId: "delayed", onClose,
    resolveCloseTarget: () => new Promise<Parameters<typeof finishMeasurement>[0]>((resolve) => {
      finishMeasurement = resolve;
    }),
    onRequestClose: jest.fn(), playThemeSfx: jest.fn(async () => {}) };
  const tree = (visible: boolean) => (
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <PopupChatOverlay {...props} visible={visible} />
    </VisualThemeProvider>
  );
  const screen = await render(tree(true));
  await screen.rerender(tree(false));
  // Measurement returns 50ms before the original animation fail-open deadline.
  await act(async () => jest.advanceTimersByTime(durationMs + 200));
  await act(async () => finishMeasurement({ rect: { x: 10, y: 10, width: 100, height: 60 }, onComplete }));
  const animation = mockStartPopupMinimizeTransition.mock.calls[0][0];
  await act(async () => jest.advanceTimersByTime(51));
  expect(onComplete).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(durationMs - 51));
  expect(onComplete).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => animation.onFinish(true));
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});
