import { fireEvent, render } from "@testing-library/react-native";
import { ImageViewer } from "./ImageViewer";

jest.mock("react-native-gesture-handler", () => ({ GestureHandlerRootView: require("react-native").View }));

let mockViewerProps: Record<string, any> = {};
jest.mock("react-native-gesture-image-viewer", () => ({
  GestureViewer: (props: Record<string, any>) => {
    mockViewerProps = props;
    return props.data.map(props.renderItem);
  },
}));

test("fits the popup viewport, preserves authentication, enables zoom and closes", async () => {
  const source = { uri: "https://runner.test/image.png", headers: { authorization: "Bearer token" } };
  const onRequestClose = jest.fn();
  const view = await render(<ImageViewer source={source} onRequestClose={onRequestClose} />);
  await fireEvent(view.getByTestId("image-viewer-content"), "layout", { nativeEvent: { layout: { width: 400, height: 600 } } });
  expect(mockViewerProps).toMatchObject({ width: 400, height: 600, enablePinchZoom: true, enableDoubleTapZoom: true, enablePanWhenZoomed: true });
  const image = view.getByLabelText("拡大画像");
  expect(image.props.source).toBe(source);
  await fireEvent(image, "error", { nativeEvent: { error: "failed" } });
  expect(view.getByText("画像を表示できませんでした。")).toBeTruthy();
  await fireEvent.press(view.getByLabelText("画像ビューアーを閉じる"));
  expect(onRequestClose).toHaveBeenCalledTimes(1);
});
