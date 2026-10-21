jest.mock("../keyboardController", () => ({ KeyboardAwareScrollView: require("react-native").ScrollView, KeyboardAvoidingView: require("react-native").KeyboardAvoidingView }));
import { fireEvent, render, within } from "@testing-library/react-native";
import { Keyboard, Text, TextInput } from "react-native";
import { LearningDetailsModal } from "./LearningDetailsModal";

const props = { title: "会話のふりかえり", subtitle: "10/21 · 7件", page: 0, testID: "details-modal", onClose: jest.fn() };
afterEach(() => { jest.restoreAllMocks(); });
test("foreground has a fixed safe header outside its independent scroll and uses the existing full-screen modal", async () => {
  const screen = await render(<LearningDetailsModal {...props} visible><Text>長い一覧</Text></LearningDetailsModal>);
  expect(screen.getByTestId("details-modal").props.presentationStyle).toBe("fullScreen");
  const scroll = screen.getByTestId("details-modal-scroll");
  expect(within(scroll).getByText("長い一覧")).toBeTruthy();
  expect(within(scroll).queryByLabelText("会話のふりかえりを閉じる")).toBeNull();
  expect(screen.getByLabelText("会話のふりかえりを閉じる")).toBeTruthy();
  expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
  await screen.unmount();
});
test("closing by header or OS back dismisses keyboard; hidden modal unmounts drafts", async () => {
  const onClose = jest.fn(); const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
  const content = <TextInput accessibilityLabel="下書き" defaultValue="未保存の評価" />;
  const screen = await render(<LearningDetailsModal {...props} visible onClose={onClose}>{content}</LearningDetailsModal>);
  await fireEvent.press(screen.getByLabelText("会話のふりかえりを閉じる"));
  expect(onClose).toHaveBeenCalledTimes(1); expect(dismiss).toHaveBeenCalledTimes(1);
  await fireEvent(screen.getByTestId("details-modal"), "requestClose"); expect(onClose).toHaveBeenCalledTimes(2);
  await screen.rerender(<LearningDetailsModal {...props} visible={false} onClose={onClose}>{content}</LearningDetailsModal>);
  expect(screen.queryByLabelText("下書き")).toBeNull(); await screen.unmount();
});
