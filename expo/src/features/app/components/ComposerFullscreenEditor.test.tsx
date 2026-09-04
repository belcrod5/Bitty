import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Platform, StyleSheet } from "react-native";
import { ComposerFullscreenEditor } from "./ComposerFullscreenEditor";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../keyboardController", () => {
  const { View } = require("react-native");
  return { KeyboardAvoidingView: View };
});

const platformOSDescriptor = Object.getOwnPropertyDescriptor(Platform, "OS");

afterEach(() => {
  if (platformOSDescriptor) Object.defineProperty(Platform, "OS", platformOSDescriptor);
});

test("shows an empty history state", async () => {
  const view = await render(
    <ComposerFullscreenEditor
      visible
      inputRef={{ current: null }}
      value="draft"
      history={[]}
      onChangeText={jest.fn()}
      onSubmit={jest.fn()}
      onClose={jest.fn()}
      onFocus={jest.fn()}
      onBlur={jest.fn()}
    />
  );

  await act(async () => {
    fireEvent.press(view.getByLabelText("送信履歴を開く"));
  });
  expect(view.getByText("送信履歴はまだありません")).toBeTruthy();
  await view.unmount();
});

test("replaces the draft with a selected long history message and closes the list", async () => {
  const onChangeText = jest.fn();
  const message = "長い送信メッセージ\n".repeat(10);
  const view = await render(
    <ComposerFullscreenEditor
      visible
      inputRef={{ current: null }}
      value="current draft"
      history={[message, "older message"]}
      onChangeText={onChangeText}
      onSubmit={jest.fn()}
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
  await view.unmount();
});

test("keeps the fullscreen draft locally while parent value propagation is delayed", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "macos" });
  const onChangeText = jest.fn();
  const onSubmit = jest.fn(async (_value: string, onAccepted: () => void) => onAccepted());
  const view = await render(
    <ComposerFullscreenEditor
      visible
      inputRef={{ current: null }}
      value="draft"
      history={[]}
      onChangeText={onChangeText}
      onSubmit={onSubmit}
      submitKeyEvents={[{ key: "Enter", metaKey: true }]}
      onClose={jest.fn()}
      onFocus={jest.fn()}
      onBlur={jest.fn()}
    />
  );

  const input = view.getByTestId("composer-fullscreen-input");
  const submitFromMountedModal = input.props.onSubmitEditing;
  await fireEvent.changeText(input, "drXaft");
  expect(input.props.value).toBe("drXaft");
  expect(onChangeText).toHaveBeenCalledWith("drXaft");

  await view.rerender(
    <ComposerFullscreenEditor
      visible
      inputRef={{ current: null }}
      value="stale parent value"
      history={[]}
      onChangeText={onChangeText}
      onSubmit={onSubmit}
      submitKeyEvents={[{ key: "Enter", metaKey: true }]}
      onClose={jest.fn()}
      onFocus={jest.fn()}
      onBlur={jest.fn()}
    />
  );
  expect(view.getByTestId("composer-fullscreen-input").props.value).toBe("drXaft");
  await act(async () => {
    await submitFromMountedModal();
  });
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("drXaft", expect.any(Function)));
  await waitFor(() => expect(view.getByTestId("composer-fullscreen-input").props.value).toBe(""));
  await view.unmount();
});

test("keeps non-macOS fullscreen input controlled by its parent", async () => {
  const props = {
    visible: true,
    inputRef: { current: null },
    history: [] as string[],
    onChangeText: jest.fn(),
    onSubmit: jest.fn(),
    onClose: jest.fn(),
    onFocus: jest.fn(),
    onBlur: jest.fn(),
  };
  const view = await render(<ComposerFullscreenEditor {...props} value="draft" />);

  await view.rerender(<ComposerFullscreenEditor {...props} value="external update" />);

  expect(view.getByTestId("composer-fullscreen-input").props.value).toBe("external update");
  await view.unmount();
});

test("submits only Command+Enter on macOS and clears after the parent accepts the draft", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "macos" });
  const onSubmit = jest.fn(async (_value: string, onAccepted: () => void) => onAccepted());
  const view = await render(
    <ComposerFullscreenEditor
      visible
      inputRef={{ current: null }}
      value="send me"
      history={[]}
      onChangeText={jest.fn()}
      onSubmit={onSubmit}
      submitKeyEvents={[{ key: "Enter", metaKey: true }]}
      onClose={jest.fn()}
      onFocus={jest.fn()}
      onBlur={jest.fn()}
    />
  );

  const input = view.getByTestId("composer-fullscreen-input");
  expect(input.props.submitKeyEvents).toEqual([{ key: "Enter", metaKey: true }]);
  await fireEvent(input, "submitEditing");
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("send me", expect.any(Function)));
  await waitFor(() => expect(view.getByTestId("composer-fullscreen-input").props.value).toBe(""));

  await view.unmount();
});

test("submits the latest native IME text from the fullscreen editor", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "macos" });
  const onChangeText = jest.fn();
  const onSubmit = jest.fn(async (_value: string, onAccepted: () => void) => onAccepted());
  const view = await render(
    <ComposerFullscreenEditor
      visible
      inputRef={{ current: null }}
      value="t"
      history={[]}
      onChangeText={onChangeText}
      onSubmit={onSubmit}
      submitKeyEvents={[{ key: "Enter", metaKey: true }]}
      onClose={jest.fn()}
      onFocus={jest.fn()}
      onBlur={jest.fn()}
    />
  );

  await fireEvent(view.getByTestId("composer-fullscreen-input"), "submitEditing", {
    nativeEvent: { text: "続けて" },
  });

  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("続けて", expect.any(Function)));
  expect(onChangeText).toHaveBeenCalledWith("続けて");
  await view.unmount();
});

test("keeps a macOS draft when the send is rejected", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "macos" });
  const onSubmit = jest.fn(async () => {});
  const view = await render(
    <ComposerFullscreenEditor
      visible
      inputRef={{ current: null }}
      value="retry me"
      history={[]}
      onChangeText={jest.fn()}
      onSubmit={onSubmit}
      submitKeyEvents={[{ key: "Enter", metaKey: true }]}
      onClose={jest.fn()}
      onFocus={jest.fn()}
      onBlur={jest.fn()}
    />
  );

  await fireEvent(view.getByTestId("composer-fullscreen-input"), "submitEditing");
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("retry me", expect.any(Function)));
  expect(view.getByTestId("composer-fullscreen-input").props.value).toBe("retry me");
  await view.unmount();
});

test("keeps text entered while an accepted macOS send is pending", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "macos" });
  let finishSend!: () => void;
  let acceptSend!: () => void;
  const sendCompletion = new Promise<void>((resolve) => { finishSend = resolve; });
  const onChangeText = jest.fn();
  const onSubmit = jest.fn((_value: string, onAccepted: () => void) => {
    acceptSend = onAccepted;
    return sendCompletion;
  });
  const view = await render(
    <ComposerFullscreenEditor
      visible
      inputRef={{ current: null }}
      value="send me"
      history={[]}
      onChangeText={onChangeText}
      onSubmit={onSubmit}
      submitKeyEvents={[{ key: "Enter", metaKey: true }]}
      onClose={jest.fn()}
      onFocus={jest.fn()}
      onBlur={jest.fn()}
    />
  );

  await fireEvent(view.getByTestId("composer-fullscreen-input"), "submitEditing");
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("send me", expect.any(Function)));
  await act(async () => {
    acceptSend();
    await Promise.resolve();
  });
  expect(onChangeText).toHaveBeenCalledWith("");
  onChangeText.mockClear();
  await fireEvent.changeText(view.getByTestId("composer-fullscreen-input"), "next message");
  await act(async () => {
    finishSend();
    await sendCompletion;
  });

  expect(view.getByTestId("composer-fullscreen-input").props.value).toBe("next message");
  expect(onChangeText).not.toHaveBeenCalledWith("");
  await view.unmount();
});
