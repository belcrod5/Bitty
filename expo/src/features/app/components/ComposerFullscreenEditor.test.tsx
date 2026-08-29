import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { ComposerFullscreenEditor } from "./ComposerFullscreenEditor";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../keyboardController", () => {
  const { View } = require("react-native");
  return { KeyboardAvoidingView: View };
});

test("shows an empty history state", async () => {
  const view = await render(
    <ComposerFullscreenEditor
      visible
      inputRef={{ current: null }}
      value="draft"
      history={[]}
      onChangeText={jest.fn()}
      onClose={jest.fn()}
      onFocus={jest.fn()}
      onBlur={jest.fn()}
    />
  );

  await act(async () => {
    fireEvent.press(view.getByLabelText("送信履歴を開く"));
  });
  expect(view.getByText("送信履歴はまだありません")).toBeTruthy();
});

test("replaces the draft with a selected long history message and closes the list", async () => {
  jest.useFakeTimers();
  const onChangeText = jest.fn();
  const message = "長い送信メッセージ\n".repeat(10);
  const view = await render(
    <ComposerFullscreenEditor
      visible
      inputRef={{ current: null }}
      value="current draft"
      history={[message, "older message"]}
      onChangeText={onChangeText}
      onClose={jest.fn()}
      onFocus={jest.fn()}
      onBlur={jest.fn()}
    />
  );

  await act(async () => {
    fireEvent.press(view.getByLabelText("送信履歴を開く"));
  });
  expect(StyleSheet.flatten(view.getByTestId("composer-history-list").props.style)).toMatchObject({
    position: "absolute",
  });
  const olderHistoryItem = view.getByLabelText("送信履歴 2: older message");
  expect(olderHistoryItem.props.accessibilityHint).toBe("入力欄に反映");
  expect(StyleSheet.flatten(olderHistoryItem.props.style)).toMatchObject({
    borderTopWidth: 1,
    borderTopColor: "#94a3b8",
  });
  await act(async () => {
    fireEvent.press(view.getByLabelText(`送信履歴 1: ${message}`));
  });
  expect(onChangeText).toHaveBeenCalledWith(message);
  expect(view.queryByTestId("composer-history-list")).toBeNull();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});
