import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert, Animated } from "react-native";
import { ChecklistFileViewer } from "./ChecklistFileViewer";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("react-native-gesture-handler", () => {
  const gestures: Array<Record<string, (...args: any[]) => unknown>> = [];
  (globalThis as Record<string, unknown>).__checklistGestures = gestures;
  return {
    Gesture: {
      Pan: () => {
        const callbacks: Record<string, (...args: any[]) => unknown> = {};
        gestures.push(callbacks);
        const chain = {
          enabled: () => chain,
          activeOffsetY: () => chain,
          failOffsetX: () => chain,
          runOnJS: () => chain,
          onBegin: (callback: (...args: any[]) => unknown) => {
            callbacks.onBegin = callback;
            return chain;
          },
          onUpdate: (callback: (...args: any[]) => unknown) => {
            callbacks.onUpdate = callback;
            return chain;
          },
          onEnd: (callback: (...args: any[]) => unknown) => {
            callbacks.onEnd = callback;
            return chain;
          },
          onFinalize: (callback: (...args: any[]) => unknown) => {
            callbacks.onFinalize = callback;
            return chain;
          },
        };
        return chain;
      },
    },
    GestureDetector: ({ children }: { children?: React.ReactNode }) => children,
  };
});

function checklistGestures() {
  return (globalThis as Record<string, unknown>).__checklistGestures as Array<{
    onBegin?: () => void;
    onUpdate?: (event: { translationY: number }) => void;
    onEnd?: (event: { translationY: number }) => void;
    onFinalize?: () => void;
  }>;
}

beforeEach(() => {
  checklistGestures().length = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
});

const target = {
  kind: "checklist" as const,
  path: "tasks/today.checklist",
  name: "today.checklist",
  rootDirectory: "/work/other",
};

test("auto-saves toggles and uses the returned version for the next action", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
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
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(alertSpy).toHaveBeenCalledWith(
    "項目を削除しますか？",
    "B",
    expect.any(Array),
  );
  const deleteButtons = alertSpy.mock.calls[0]?.[2] || [];
  deleteButtons.find((button) => button.text === "キャンセル")?.onPress?.();
  expect(onSave).toHaveBeenCalledTimes(1);

  await fireEvent.press(view.getByTestId("checklist-delete-1"));
  const confirmButtons = alertSpy.mock.calls[1]?.[2] || [];
  await act(async () => {
    confirmButtons.find((button) => button.text === "削除")?.onPress?.();
  });
  await waitFor(() => expect(onSave).toHaveBeenNthCalledWith(
    2,
    target,
    "- [x] A\n",
    "version-2",
  ));
});

test("confirms bulk deletion and only saves after destructive confirmation", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const onSave = jest.fn().mockResolvedValue({
    ok: true,
    path: target.path,
    version: "version-2",
  });
  const view = await render(
    <ChecklistFileViewer
      target={target}
      initialItems={[
        { checked: true, text: "A" },
        { checked: false, text: "B" },
        { checked: true, text: "C" },
      ]}
      initialVersion="version-1"
      onSave={onSave}
      onSavingChange={jest.fn()}
    />
  );

  await fireEvent.press(view.getByTestId("checklist-delete-checked"));
  expect(alertSpy).toHaveBeenCalledWith(
    "チェック済みを削除しますか？",
    "2件の項目を削除します。",
    expect.any(Array),
  );
  const cancelButtons = alertSpy.mock.calls[0]?.[2] || [];
  cancelButtons.find((button) => button.text === "キャンセル")?.onPress?.();
  expect(onSave).not.toHaveBeenCalled();

  await fireEvent.press(view.getByTestId("checklist-delete-checked"));
  const confirmButtons = alertSpy.mock.calls[1]?.[2] || [];
  await act(async () => {
    confirmButtons.find((button) => button.text === "削除")?.onPress?.();
  });
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(
    target,
    "- [ ] B\n",
    "version-1",
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

test("reorders through the handle gesture callback sequence and restores scrolling", async () => {
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
    const gesture = checklistGestures()[0];

    await act(async () => {
      gesture.onBegin?.();
    });
    expect(view.getByTestId("checklist-list").props.scrollEnabled).toBe(false);

    await act(async () => {
      gesture.onUpdate?.({ translationY: 68 });
      gesture.onEnd?.({ translationY: 68 });
      gesture.onFinalize?.();
    });
    expect(setValue).toHaveBeenCalledWith(68);
    expect(setValue).toHaveBeenCalledWith(0);
    const resetCallIndex = setValue.mock.calls.findIndex(([value]) => value === 0);
    expect(setValue.mock.invocationCallOrder[resetCallIndex])
      .toBeLessThan(onSave.mock.invocationCallOrder[0]);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      target,
      "- [ ] B\n- [ ] A\n",
      "version-1",
    ));
    await waitFor(() => expect(view.getByTestId("checklist-list").props.scrollEnabled).toBe(true));
  } finally {
    setValue.mockRestore();
  }
});
