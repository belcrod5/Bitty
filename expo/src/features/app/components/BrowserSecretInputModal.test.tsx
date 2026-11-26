import { fireEvent, render } from "@testing-library/react-native";
import type { BrowserSecretInputRequest } from "../hooks/useBrowserSecretInput";
import { BrowserSecretInputModal } from "./BrowserSecretInputModal";

const form: BrowserSecretInputRequest = { requestId: "request", destinationOrigin: "https://payments.example", topOrigin: "https://shop.example", label: "Card number", expiresAt: new Date(Date.now() + 120_000).toISOString(),
  origin: { clientInstanceId: "phone", connectionGeneration: "connection", surfaceId: "panel", ownerGeneration: 4, target: { kind: "orchestrator", orchestratorId: "main" } } };
test("masks input, names both destination origins and submits exact text then clears it", async () => {
  const onSubmit = jest.fn(async () => {});
  const view = await render(<BrowserSecretInputModal request={form} sending={false} onSubmit={onSubmit} onCancel={() => {}} />);
  expect(view.getByText(form.destinationOrigin)).toBeTruthy();
  expect(view.getByText(`ページ: ${form.topOrigin}`)).toBeTruthy();
  const input = view.getByLabelText("秘密の入力内容");
  expect(input.props.secureTextEntry).toBe(true);
  expect(input.props.autoCorrect).toBe(false);
  expect(input.props.autoComplete).toBe("off");
  await fireEvent.changeText(input, "  exact private value  ");
  await fireEvent.press(view.getByText("入力する"));
  expect(onSubmit).toHaveBeenCalledWith("  exact private value  ");
  expect(view.getByLabelText("秘密の入力内容").props.value).toBe("");
  await fireEvent.changeText(view.getByLabelText("秘密の入力内容"), "x".repeat(4097));
  expect(view.getByText("4096文字以内で入力してください。")).toBeTruthy();
  await fireEvent.press(view.getByText("入力する"));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test("cancel and request replacement discard the draft and sending blocks another submit", async () => {
  const onSubmit = jest.fn(async () => {}); const onCancel = jest.fn();
  const props = { request: form, sending: false, onSubmit, onCancel };
  const view = await render(<BrowserSecretInputModal {...props} />);
  await fireEvent.changeText(view.getByLabelText("秘密の入力内容"), "discard me");
  await fireEvent.press(view.getByText("キャンセル"));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(view.getByLabelText("秘密の入力内容").props.value).toBe("");
  await fireEvent.changeText(view.getByLabelText("秘密の入力内容"), "old request");
  await view.rerender(<BrowserSecretInputModal {...props} request={{ ...form, requestId: "new-request" }} />);
  expect(view.getByLabelText("秘密の入力内容").props.value).toBe("");
  await view.rerender(<BrowserSecretInputModal {...props} sending />);
  expect(view.getByLabelText("秘密の入力内容").props.editable).toBe(false);
  await fireEvent.press(view.getByText("入力中…"));
  expect(onSubmit).not.toHaveBeenCalled();
  await view.rerender(<BrowserSecretInputModal {...props} request={null} />);
  expect(view.queryByLabelText("秘密の入力内容")).toBeNull();
  await view.unmount();
});
