import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Animated, PanResponder } from "react-native";
import { ChecklistFileViewer } from "./ChecklistFileViewer";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

const target = { path: "tasks/today.checklist", name: "today.checklist" };

test("auto-saves toggles and uses the returned version for the next action", async () => {
  const onSave = jest.fn()
    .mockResolvedValueOnce({ ok: true, path: target.path, version: "version-2" })
    .mockResolvedValueOnce({ ok: true, path: target.path, version: "version-3" });
  const view = await render(
    <ChecklistFileViewer
      target={target}
      initialItems={[
        { checked: false, text: "A" },
        { checked: false, text: "B" },
      ]}
      initialVersion="version-1"
      onSave={onSave}
      onSavingChange={jest.fn()}
    />
  );

  await fireEvent.press(view.getByTestId("checklist-toggle-0"));
  await waitFor(() => expect(onSave).toHaveBeenNthCalledWith(
    1,
    target,
    "- [x] A\n- [ ] B\n",
    "version-1",
  ));
  await waitFor(() => expect(view.getByText("保存済み")).toBeTruthy());

  await fireEvent.press(view.getByTestId("checklist-delete-1"));
  await waitFor(() => expect(onSave).toHaveBeenNthCalledWith(
    2,
    target,
    "- [x] A\n",
    "version-2",
  ));
});

test("edits text inline and adds one item for each nonempty input line", async () => {
  const onSave = jest.fn()
    .mockResolvedValueOnce({ ok: true, path: target.path, version: "version-2" })
    .mockResolvedValueOnce({ ok: true, path: target.path, version: "version-3" });
  const view = await render(
    <ChecklistFileViewer
      target={target}
      initialItems={[{ checked: false, text: "変更前" }]}
      initialVersion="version-1"
      onSave={onSave}
      onSavingChange={jest.fn()}
    />
  );

  await fireEvent.press(view.getByTestId("checklist-text-0"));
  await fireEvent.changeText(view.getByTestId("checklist-edit-input-0"), "変更後");
  await fireEvent(view.getByTestId("checklist-edit-input-0"), "submitEditing");
  await waitFor(() => expect(onSave).toHaveBeenNthCalledWith(
    1,
    target,
    "- [ ] 変更後\n",
    "version-1",
  ));
  await waitFor(() => expect(view.getByText("変更後")).toBeTruthy());

  await fireEvent.changeText(view.getByTestId("checklist-new-item-input"), "追加1\n\n 追加2 ");
  await fireEvent.press(view.getByTestId("checklist-add"));
  await waitFor(() => expect(onSave).toHaveBeenNthCalledWith(
    2,
    target,
    "- [ ] 変更後\n- [ ] 追加1\n- [ ] 追加2\n",
    "version-2",
  ));
});

test("rolls back an optimistic change when auto-save fails", async () => {
  const onSave = jest.fn().mockRejectedValue(new Error("save failed"));
  const view = await render(
    <ChecklistFileViewer
      target={target}
      initialItems={[{ checked: false, text: "A" }]}
      initialVersion="version-1"
      onSave={onSave}
      onSavingChange={jest.fn()}
    />
  );

  await fireEvent.press(view.getByTestId("checklist-toggle-0"));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(view.getByTestId("checklist-toggle-0").props.accessibilityState.checked)
    .toBe(false));
});

test("does not start a second write while the current version is still saving", async () => {
  let resolveSave: ((value: { ok: true; path: string; version: string }) => void) | undefined;
  const onSave = jest.fn(() => new Promise<{ ok: true; path: string; version: string }>((resolve) => {
    resolveSave = resolve;
  }));
  const view = await render(
    <ChecklistFileViewer
      target={target}
      initialItems={[
        { checked: false, text: "A" },
        { checked: false, text: "B" },
      ]}
      initialVersion="version-1"
      onSave={onSave}
      onSavingChange={jest.fn()}
    />
  );

  await fireEvent.press(view.getByTestId("checklist-toggle-0"));
  await fireEvent.press(view.getByTestId("checklist-toggle-1"));
  expect(onSave).toHaveBeenCalledTimes(1);

  resolveSave?.({ ok: true, path: target.path, version: "version-2" });
  await waitFor(() => expect(view.getByText("保存済み")).toBeTruthy());
});

test("reorders with the drag handle accessibility actions and keeps bounds", async () => {
  const onSave = jest.fn().mockResolvedValue({
    ok: true,
    path: target.path,
    version: "version-2",
  });
  const view = await render(
    <ChecklistFileViewer
      target={target}
      initialItems={[
        { checked: false, text: "A" },
        { checked: false, text: "B" },
      ]}
      initialVersion="version-1"
      onSave={onSave}
      onSavingChange={jest.fn()}
    />
  );

  await fireEvent(view.getByTestId("checklist-drag-0"), "accessibilityAction", {
    nativeEvent: { actionName: "decrement" },
  });
  expect(onSave).not.toHaveBeenCalled();

  await fireEvent(view.getByTestId("checklist-drag-0"), "accessibilityAction", {
    nativeEvent: { actionName: "increment" },
  });
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(
    target,
    "- [ ] B\n- [ ] A\n",
    "version-1",
  ));
});

test("resets the dragged row translation before saving the reordered list", async () => {
  const createPanResponder = jest.spyOn(PanResponder, "create").mockImplementation((config) => ({
    panHandlers: {
      onResponderRelease: (event: unknown) => config.onPanResponderRelease?.(
        event as never,
        { dy: 68 } as never,
      ),
    },
    getInteractionHandle: () => null,
  } as ReturnType<typeof PanResponder.create>));
  const setValue = jest.spyOn(Animated.Value.prototype, "setValue");
  const onSave = jest.fn().mockResolvedValue({
    ok: true,
    path: target.path,
    version: "version-2",
  });

  try {
    const view = await render(
      <ChecklistFileViewer
        target={target}
        initialItems={[
          { checked: false, text: "A" },
          { checked: false, text: "B" },
        ]}
        initialVersion="version-1"
        onSave={onSave}
        onSavingChange={jest.fn()}
      />
    );

    await fireEvent(view.getByTestId("checklist-drag-0"), "responderRelease", {});
    expect(setValue).toHaveBeenCalledWith(0);
    expect(setValue.mock.invocationCallOrder[0]).toBeLessThan(onSave.mock.invocationCallOrder[0]);
  } finally {
    createPanResponder.mockRestore();
    setValue.mockRestore();
  }
});
