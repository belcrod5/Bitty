import { act, fireEvent, render } from "@testing-library/react-native";
import type { AVPlaybackStatus } from "expo-av";
import { Audio } from "../audio";
import { RunnerAudioPlayer } from "./RunnerAudioPlayer";

jest.mock("../audio", () => ({ Audio: { Sound: { createAsync: jest.fn() } } }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));

const source = { uri: "https://runner.test/files/media?path=cue.wav", headers: { authorization: "Bearer token", "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "secret" } };
const loadedStatus = (overrides: Record<string, unknown> = {}) => ({
  isLoaded: true, isPlaying: true, didJustFinish: false, positionMillis: 100, durationMillis: 200, ...overrides,
} as AVPlaybackStatus);

function makeSound() {
  let handler: ((status: AVPlaybackStatus) => void) | null = null;
  return {
    setOnPlaybackStatusUpdate: jest.fn((next) => { handler = next; handler?.(loadedStatus()); }),
    playAsync: jest.fn(async () => {}),
    replayAsync: jest.fn(async () => {}),
    setStatusAsync: jest.fn(async () => {}),
    unloadAsync: jest.fn(async () => {}),
    emit: (status: AVPlaybackStatus) => handler?.(status),
  };
}

beforeEach(() => { jest.clearAllMocks(); });

test("plays authenticated audio, pauses, resumes, and replays after completion", async () => {
  const sound = makeSound();
  jest.mocked(Audio.Sound.createAsync).mockResolvedValue({ sound } as never);
  const screen = await render(<RunnerAudioPlayer source={source} />);
  expect(Audio.Sound.createAsync).toHaveBeenCalledWith(source, { shouldPlay: false });
  expect(sound.playAsync).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByLabelText("音声を一時停止"));
  expect(sound.setStatusAsync).toHaveBeenCalledWith({ shouldPlay: false });
  await act(() => sound.emit(loadedStatus({ isPlaying: false })));
  await fireEvent.press(screen.getByLabelText("音声を再生"));
  expect(sound.playAsync).toHaveBeenCalledTimes(2);
  await act(() => sound.emit(loadedStatus({ isPlaying: false, didJustFinish: true, positionMillis: 200 })));
  await fireEvent.press(screen.getByLabelText("音声を再生"));
  expect(sound.replayAsync).toHaveBeenCalledTimes(1);
  await screen.unmount();
  expect(sound.setOnPlaybackStatusUpdate).toHaveBeenLastCalledWith(null);
  expect(sound.unloadAsync).toHaveBeenCalledTimes(1);
});

test("changing media unloads the old sound and closing unloads the current sound", async () => {
  const first = makeSound();
  const second = makeSound();
  jest.mocked(Audio.Sound.createAsync).mockResolvedValueOnce({ sound: first } as never).mockResolvedValueOnce({ sound: second } as never);
  const screen = await render(<RunnerAudioPlayer source={source} />);
  await screen.rerender(<RunnerAudioPlayer source={{ ...source, uri: "https://runner.test/files/media?path=next.mp3" }} />);
  expect(first.unloadAsync).toHaveBeenCalledTimes(1);
  expect(second.playAsync).toHaveBeenCalledTimes(1);
  await screen.unmount();
  expect(second.unloadAsync).toHaveBeenCalledTimes(1);
});

test("a sound that finishes loading after close is unloaded without playing", async () => {
  const sound = makeSound();
  let resolve!: (value: unknown) => void;
  jest.mocked(Audio.Sound.createAsync).mockReturnValue(new Promise((done) => { resolve = done; }) as never);
  const screen = await render(<RunnerAudioPlayer source={source} />);
  await screen.unmount();
  await act(async () => { resolve({ sound }); });
  expect(sound.playAsync).not.toHaveBeenCalled();
  expect(sound.unloadAsync).toHaveBeenCalledTimes(1);
});

test("late loading from the previous source never replaces the current sound", async () => {
  const first = makeSound();
  const second = makeSound();
  let resolve!: (value: unknown) => void;
  jest.mocked(Audio.Sound.createAsync).mockReturnValueOnce(new Promise((done) => { resolve = done; }) as never).mockResolvedValueOnce({ sound: second } as never);
  const screen = await render(<RunnerAudioPlayer source={source} />);
  await screen.rerender(<RunnerAudioPlayer source={{ ...source, uri: "https://runner.test/next.wav" }} />);
  await act(async () => { resolve({ sound: first }); });
  expect(first.playAsync).not.toHaveBeenCalled();
  expect(first.unloadAsync).toHaveBeenCalledTimes(1);
  expect(second.playAsync).toHaveBeenCalledTimes(1);
  await screen.unmount();
  expect(second.unloadAsync).toHaveBeenCalledTimes(1);
});

test("reports media loading failures", async () => {
  jest.mocked(Audio.Sound.createAsync).mockRejectedValueOnce(new Error("HTTP 401"));
  const screen = await render(<RunnerAudioPlayer source={source} />);
  expect(screen.getByText("音声を再生できませんでした。")).toBeTruthy();
  expect(screen.getByText("HTTP 401")).toBeTruthy();
});
