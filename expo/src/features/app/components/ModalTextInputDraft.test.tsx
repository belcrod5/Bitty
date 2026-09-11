import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { Platform, TextInput } from "react-native";

import { ModalTextInputDraft } from "./ModalTextInputDraft";

const platformOSDescriptor = Object.getOwnPropertyDescriptor(Platform, "OS");

afterEach(() => {
  if (platformOSDescriptor) Object.defineProperty(Platform, "OS", platformOSDescriptor);
});

test("keeps the macOS draft when a stale parent value arrives", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "macos" });
  const onChangeText = jest.fn();
  const view = await render(
    <ModalTextInputDraft value="before" onChangeText={onChangeText}>
      {(draft) => (
        <TextInput
          testID="input"
          value={draft.value}
          onChangeText={draft.changeText}
        />
      )}
    </ModalTextInputDraft>
  );

  await fireEvent.changeText(view.getByTestId("input"), "after");
  await view.rerender(
    <ModalTextInputDraft value="stale" onChangeText={onChangeText}>
      {(draft) => (
        <TextInput
          testID="input"
          value={draft.value}
          onChangeText={draft.changeText}
        />
      )}
    </ModalTextInputDraft>
  );

  expect(view.getByTestId("input").props.value).toBe("after");
  expect(onChangeText).toHaveBeenCalledWith("after");
});

test("keeps non-macOS input controlled by its parent", async () => {
  const view = await render(
    <ModalTextInputDraft value="before" onChangeText={jest.fn()}>
      {(draft) => <TextInput testID="input" value={draft.value} />}
    </ModalTextInputDraft>
  );

  await view.rerender(
    <ModalTextInputDraft value="after" onChangeText={jest.fn()}>
      {(draft) => <TextInput testID="input" value={draft.value} />}
    </ModalTextInputDraft>
  );

  expect(view.getByTestId("input").props.value).toBe("after");
});
