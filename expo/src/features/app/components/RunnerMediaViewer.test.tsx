import { fireEvent, render } from "@testing-library/react-native";
import { Audio } from "../audio";
import { RunnerMediaViewer } from "./RunnerMediaViewer";
import type { RunnerMediaFile } from "../utils/runnerFileContextMenu";

let mockViewerState = { totalCount: 3, currentIndex: 0 };
jest.mock("react-native-gesture-image-viewer", () => ({
  GestureViewer: ({ data, renderItem }: { data: unknown[]; renderItem: (item: unknown, index: number) => unknown }) => data.map(renderItem),
  useGestureViewerController: () => ({ goToIndex: jest.fn() }),
  useGestureViewerState: () => mockViewerState,
}));
jest.mock("../audio", () => ({ Audio: { Sound: { createAsync: jest.fn() } }, Video: "Video", ResizeMode: { CONTAIN: "contain" } }));
jest.mock("./WorkspaceFileRenameDialog", () => ({ WorkspaceFileRenameDialog: () => null }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));

const media: RunnerMediaFile = {
  kind: "audio", path: "ready.wav", name: "ready.wav", url: "https://runner.test/files/media?path=ready.wav", runnerToken: "secret",
  items: [
    { kind: "audio", path: "ready.wav", name: "ready.wav", url: "https://runner.test/files/media?path=ready.wav" },
    { kind: "audio", path: "send.wav", name: "send.wav", url: "https://runner.test/files/media?path=send.wav" },
    { kind: "image", path: "image.png", name: "image.png", url: "https://runner.test/files/media?path=image.png" },
  ],
};

function makeSound() {
  return {
    setOnPlaybackStatusUpdate: jest.fn(),
    playAsync: jest.fn(async () => {}),
    unloadAsync: jest.fn(async () => {}),
  };
}

test("only selected gallery audio loads and plays, and changing page or closing releases it", async () => {
  const ready = makeSound(), send = makeSound(), reopened = makeSound();
  jest.mocked(Audio.Sound.createAsync).mockResolvedValueOnce({ sound: ready } as never).mockResolvedValueOnce({ sound: send } as never).mockResolvedValueOnce({ sound: reopened } as never);
  const onRequestClose = jest.fn();
  const screen = await render(<RunnerMediaViewer media={media} onRequestClose={onRequestClose} />);
  await fireEvent(screen.getByTestId("runner-media-content"), "layout", { nativeEvent: { layout: { width: 400, height: 600 } } });
  expect(Audio.Sound.createAsync).toHaveBeenCalledTimes(1);
  expect(Audio.Sound.createAsync).toHaveBeenLastCalledWith({ uri: media.url, headers: { authorization: "Bearer secret" } }, { shouldPlay: false });
  expect(ready.playAsync).toHaveBeenCalledTimes(1);
  mockViewerState = { totalCount: 3, currentIndex: 1 };
  await screen.rerender(<RunnerMediaViewer media={media} onRequestClose={onRequestClose} />);
  expect(ready.unloadAsync).toHaveBeenCalledTimes(1);
  expect(send.playAsync).toHaveBeenCalledTimes(1);
  mockViewerState = { totalCount: 3, currentIndex: 2 };
  await screen.rerender(<RunnerMediaViewer media={media} onRequestClose={onRequestClose} />);
  expect(send.unloadAsync).toHaveBeenCalledTimes(1);
  expect(Audio.Sound.createAsync).toHaveBeenCalledTimes(2);
  mockViewerState = { totalCount: 3, currentIndex: 0 };
  await screen.rerender(<RunnerMediaViewer media={media} onRequestClose={onRequestClose} />);
  expect(reopened.playAsync).toHaveBeenCalledTimes(1);
  await screen.rerender(<RunnerMediaViewer media={null} onRequestClose={onRequestClose} />);
  expect(reopened.unloadAsync).toHaveBeenCalledTimes(1);
});
