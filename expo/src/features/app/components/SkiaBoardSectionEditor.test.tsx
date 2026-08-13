import { fireEvent, render } from "@testing-library/react-native";
import { Keyboard } from "react-native";
import { SkiaBoardSectionEditor } from "./SkiaBoardSectionEditor";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

const section = {
  id: "section-1",
  label: "作業中",
  color: "#3b82f6",
  opacity: 0.2,
  borderOnly: false,
  col: 0,
  row: 0,
  colSpan: 2,
  rowSpan: 2,
};

test("dismisses the keyboard when the editor panel is touched outside the label", async () => {
  const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
  const screen = await render(
    <SkiaBoardSectionEditor
      section={section}
      onClose={jest.fn()}
      onSave={jest.fn()}
      onDelete={jest.fn()}
    />,
  );

  fireEvent(screen.getByTestId("skia-board-section-editor-panel"), "touchStart");

  expect(dismiss).toHaveBeenCalledTimes(1);
  dismiss.mockRestore();
});

test("keeps the label focused when the label itself is touched", async () => {
  const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
  const stopPropagation = jest.fn();
  const screen = await render(
    <SkiaBoardSectionEditor
      section={section}
      onClose={jest.fn()}
      onSave={jest.fn()}
      onDelete={jest.fn()}
    />,
  );

  fireEvent(screen.getByLabelText("セクションのラベル"), "touchStart", { stopPropagation });

  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(dismiss).not.toHaveBeenCalled();
  dismiss.mockRestore();
});
