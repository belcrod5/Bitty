jest.mock("../keyboardController", () => ({ KeyboardAwareScrollView: require("react-native").ScrollView, KeyboardAvoidingView: require("react-native").KeyboardAvoidingView }));
jest.mock("./AppModal", () => jest.requireActual("./AppModal.macos"));
import { useState } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import { AppModal, AppModalHost } from "./AppModal.macos";
import { LearningDetailsModal } from "./LearningDetailsModal";

test("nested learning details use the shared macOS foreground host; Escape closes only details and returns to settings", async () => {
  const closeSettings = jest.fn();
  function Settings() {
    const [open, setOpen] = useState(true);
    return <AppModalHost><Text testID="background">App</Text><AppModal visible onRequestClose={closeSettings}>
      <Text>学習の設定</Text><LearningDetailsModal visible={open} title="会話のふりかえり" subtitle="10/21" page={0} testID="details" onClose={() => setOpen(false)}><Text>評価の一覧</Text></LearningDetailsModal>
    </AppModal></AppModalHost>;
  }
  const screen = await render(<Settings />); await waitFor(() => screen.getByText("評価の一覧"));
  const stopPropagation = jest.fn(); await fireEvent(screen.getByTestId("background"), "keyDownCapture", { nativeEvent: { key: "Escape" }, stopPropagation });
  await waitFor(() => expect(screen.queryByText("評価の一覧")).toBeNull());
  expect(screen.getByText("学習の設定")).toBeTruthy(); expect(closeSettings).not.toHaveBeenCalled(); expect(stopPropagation).toHaveBeenCalledTimes(1); await screen.unmount();
});
