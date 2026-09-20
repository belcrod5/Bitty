import React, { useEffect } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react-native";

import { Audio } from "../audio";
import type { VisualThemeSound, VisualThemeSoundEvent } from "../theme/visualThemes";
import { useThemeSfxController } from "./useThemeSfxController";

jest.mock("../audio", () => ({
  Audio: {
    Sound: {
      createAsync: jest.fn(),
    },
  },
}));

type PlaybackHandler = (status: { isLoaded: boolean; didJustFinish?: boolean }) => void;

function sound() {
  return {
    setOnPlaybackStatusUpdate: jest.fn<void, [PlaybackHandler | null]>(),
    unloadAsync: jest.fn(async () => {}),
  };
}

function sounds(offset = 0): Record<VisualThemeSoundEvent, VisualThemeSound> {
  return {
    popupOpen: { asset: 1 + offset, volume: 0.28 },
    popupClose: { asset: 2 + offset, volume: 0.26 },
  };
}

const createAsync = Audio.Sound.createAsync as jest.Mock;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

test("plays only the requested theme sound and releases it after playback", async () => {
  const currentSound = sound();
  createAsync.mockResolvedValueOnce({ sound: currentSound });
  const currentSounds = sounds();
  const { result } = await renderHook(() => useThemeSfxController(currentSounds, true));

  await act(async () => {
    await result.current.playThemeSfx("popupOpen");
  });

  expect(createAsync).toHaveBeenCalledTimes(1);
  expect(createAsync).toHaveBeenCalledWith(currentSounds.popupOpen.asset, {
    shouldPlay: true,
    volume: currentSounds.popupOpen.volume,
  });
  const statusHandler = currentSound.setOnPlaybackStatusUpdate.mock.calls[0]?.[0];
  await act(async () => statusHandler?.({ isLoaded: true, didJustFinish: true }));
  await waitFor(() => expect(currentSound.unloadAsync).toHaveBeenCalledTimes(1));
});

test("does not load theme sounds before persisted settings are ready", async () => {
  const { result } = await renderHook(() => useThemeSfxController(sounds(), false));

  await act(async () => {
    await result.current.playThemeSfx("popupOpen");
  });

  expect(createAsync).not.toHaveBeenCalled();
});

test("unloads an active transition sound when the theme changes", async () => {
  const currentSound = sound();
  createAsync.mockResolvedValueOnce({ sound: currentSound });
  const standard = sounds();
  const cyberpunk = sounds(10);
  const { result, rerender } = await renderHook<
    ReturnType<typeof useThemeSfxController>,
    { themeSounds: Record<VisualThemeSoundEvent, VisualThemeSound> }
  >(
    ({ themeSounds }) => useThemeSfxController(themeSounds, true),
    { initialProps: { themeSounds: standard } }
  );

  await act(async () => {
    await result.current.playThemeSfx("popupOpen");
  });
  await rerender({ themeSounds: cyberpunk });

  expect(currentSound.setOnPlaybackStatusUpdate).toHaveBeenLastCalledWith(null);
  expect(currentSound.unloadAsync).toHaveBeenCalledTimes(1);
});

test("unloads a sound that finishes loading after unmount", async () => {
  const pending = deferred<{ sound: ReturnType<typeof sound> }>();
  const lateSound = sound();
  createAsync.mockReturnValueOnce(pending.promise);
  const { result, unmount } = await renderHook(() => useThemeSfxController(sounds(), true));
  let playback!: Promise<void>;

  await act(async () => {
    playback = result.current.playThemeSfx("popupOpen");
    await Promise.resolve();
  });
  await act(async () => unmount());
  pending.resolve({ sound: lateSound });
  await act(async () => playback);

  expect(lateSound.setOnPlaybackStatusUpdate).not.toHaveBeenCalled();
  expect(lateSound.unloadAsync).toHaveBeenCalledTimes(1);
});

test("unloads a pending sound from the previous theme", async () => {
  const pending = deferred<{ sound: ReturnType<typeof sound> }>();
  const lateSound = sound();
  createAsync.mockReturnValueOnce(pending.promise);
  const standard = sounds();
  const cyberpunk = sounds(10);
  const { result, rerender } = await renderHook<
    ReturnType<typeof useThemeSfxController>,
    { themeSounds: Record<VisualThemeSoundEvent, VisualThemeSound> }
  >(
    ({ themeSounds }) => useThemeSfxController(themeSounds, true),
    { initialProps: { themeSounds: standard } }
  );
  let playback!: Promise<void>;

  await act(async () => {
    playback = result.current.playThemeSfx("popupOpen");
    await Promise.resolve();
  });
  await rerender({ themeSounds: cyberpunk });
  pending.resolve({ sound: lateSound });
  await act(async () => playback);

  expect(lateSound.setOnPlaybackStatusUpdate).not.toHaveBeenCalled();
  expect(lateSound.unloadAsync).toHaveBeenCalledTimes(1);
});

test("unloads a pending sound when theme sounds are disabled", async () => {
  const pending = deferred<{ sound: ReturnType<typeof sound> }>();
  const lateSound = sound();
  createAsync.mockReturnValueOnce(pending.promise);
  const currentSounds = sounds();
  const { result, rerender } = await renderHook<
    ReturnType<typeof useThemeSfxController>,
    { enabled: boolean }
  >(
    ({ enabled }) => useThemeSfxController(currentSounds, enabled),
    { initialProps: { enabled: true } }
  );
  let playback!: Promise<void>;

  await act(async () => {
    playback = result.current.playThemeSfx("popupClose");
    await Promise.resolve();
  });
  await rerender({ enabled: false });
  pending.resolve({ sound: lateSound });
  await act(async () => playback);

  expect(lateSound.setOnPlaybackStatusUpdate).not.toHaveBeenCalled();
  expect(lateSound.unloadAsync).toHaveBeenCalledTimes(1);
});

test("starts only the replayed sound request under StrictMode", async () => {
  jest.useFakeTimers();
  const currentSound = sound();
  createAsync.mockResolvedValueOnce({ sound: currentSound });
  const currentSounds = sounds();

  function StrictPlayback() {
    const { playThemeSfx } = useThemeSfxController(currentSounds, true);
    useEffect(() => {
      const timer = setTimeout(() => {
        void playThemeSfx("popupOpen");
      }, 0);
      return () => clearTimeout(timer);
    }, [playThemeSfx]);
    return null;
  }

  const screen = await render(
    <React.StrictMode>
      <StrictPlayback />
    </React.StrictMode>
  );
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });

  expect(createAsync).toHaveBeenCalledTimes(1);
  expect(currentSound.setOnPlaybackStatusUpdate).toHaveBeenCalledTimes(1);
  await screen.unmount();
  expect(currentSound.unloadAsync).toHaveBeenCalledTimes(1);
});
