import React from "react";
import { Text, View } from "react-native";
import { render } from "@testing-library/react-native";
import { AppModal, AppModalHost } from "./AppModal";

test("foreground follows the drawer and native modal content, retaining its providers", async () => {
  const Context = React.createContext("missing");
  function Foreground() {
    return <View testID="foreground" pointerEvents="none"><Text>{React.useContext(Context)}</Text></View>;
  }
  const screen = await render(<Context.Provider value="shared provider">
    <AppModalHost foreground={<Foreground />}>
      <View testID="drawer" />
      <AppModal visible><View testID="modal-content" /></AppModal>
    </AppModalHost>
  </Context.Provider>);
  expect(screen.getAllByText("shared provider")).toHaveLength(2);
  expect(screen.toJSON()).toMatchObject({ children: [
    { props: { testID: "drawer" } },
    { children: [expect.anything(), { props: { testID: "foreground" } }] },
    { props: { testID: "foreground" } },
  ] });
  await screen.unmount();
});
